-- =============================================================================
-- Ad attribution
--
-- When a lead arrives with `utm_content` / `utm_campaign` / `fbclid` we want
-- to resolve which `ads.id` they came from, stamp it on the lead once, and
-- have every future event for that lead pick it up. That is what makes the
-- `ad_performance` view reflect reality.
--
-- DESIGN
--   - `leads.attributed_ad_id` is the lead-level cache. It's set by the
--     first attribution row that matches and never overwritten (the ad
--     that brought the lead in is the canonical attribution).
--   - `lead_attribution.matched_ad_id` records, per attribution row, what
--     we matched and which strategy succeeded. Useful for QA + analytics.
--   - `resolve_ad_for_attribution()` does the matching. Strategies, in
--     order of confidence:
--       1. utm_content == ads.external_id  (best — operator put the ad id
--          directly into the URL parameter, e.g. utm_content={{ad.id}}).
--       2. utm_content == ads.name (lower — relies on names being unique).
--       3. utm_campaign == campaigns.external_id (no ad resolution; we
--          record the campaign-level match in match_strategy but leave
--          ad_id null because we can't pick a specific ad).
--   - `match_and_stamp_lead_attribution()` is the orchestrator called by
--     the ingest worker after writing a lead_attribution row.
--   - `backfill_lead_event_attribution()` retroactively stamps
--     `lead_events.ad_id` on rows where the lead now has an
--     `attributed_ad_id` but the event was inserted before attribution
--     resolved. Run nightly via cron.
-- =============================================================================

alter table leads
  add column if not exists attributed_ad_id uuid references ads(id) on delete set null,
  add column if not exists attributed_at    timestamptz,
  add column if not exists attributed_via   text;

create index if not exists leads_attributed_ad_idx
  on leads (company_id, attributed_ad_id)
  where attributed_ad_id is not null;

alter table lead_attribution
  add column if not exists matched_ad_id   uuid references ads(id) on delete set null,
  add column if not exists match_strategy  text,
  add column if not exists matched_at      timestamptz;

create index if not exists lead_attribution_matched_ad_idx
  on lead_attribution (company_id, matched_ad_id)
  where matched_ad_id is not null;

-- ---------------------------------------------------------------------------
-- resolve_ad_for_attribution
--
-- Given an attribution record's salient fields, returns the matched
-- ad_id (if any) and the strategy used. NULLs for unknown.
-- ---------------------------------------------------------------------------
create or replace function resolve_ad_for_attribution(
  p_company_id    uuid,
  p_utm_content   text,
  p_utm_campaign  text,
  p_fbclid        text
)
  returns table (ad_id uuid, strategy text)
  language plpgsql
  stable
as $$
declare
  result_ad_id   uuid;
  result_strat   text;
begin
  -- 1. utm_content == ads.external_id (the gold-standard tracking pattern).
  if p_utm_content is not null and p_utm_content <> '' then
    select a.id into result_ad_id
      from ads a
     where a.company_id = p_company_id
       and a.external_id = p_utm_content
     limit 1;
    if result_ad_id is not null then
      ad_id := result_ad_id;
      strategy := 'utm_content_external_id';
      return next;
      return;
    end if;

    -- 2. utm_content == ads.name (case-insensitive, exact).
    select a.id into result_ad_id
      from ads a
     where a.company_id = p_company_id
       and lower(a.name) = lower(p_utm_content)
     limit 1;
    if result_ad_id is not null then
      ad_id := result_ad_id;
      strategy := 'utm_content_name';
      return next;
      return;
    end if;
  end if;

  -- 3. Campaign-level: utm_campaign == campaigns.external_id or .name.
  --    We can't pick a specific ad from this, but record the strategy
  --    so QA can see why an ad-level match wasn't possible.
  if p_utm_campaign is not null and p_utm_campaign <> '' then
    perform 1
      from campaigns c
     where c.company_id = p_company_id
       and (c.external_id = p_utm_campaign or lower(c.name) = lower(p_utm_campaign))
     limit 1;
    if found then
      ad_id := null;
      strategy := 'utm_campaign_only';
      return next;
      return;
    end if;
  end if;

  -- 4. fbclid present but no other match. Record the strategy so we know
  --    we have raw fbclids that might be resolvable later via Meta CAPI.
  if p_fbclid is not null and p_fbclid <> '' then
    ad_id := null;
    strategy := 'fbclid_unresolved';
    return next;
    return;
  end if;

  ad_id := null;
  strategy := null;
  return next;
end;
$$;

revoke execute on function resolve_ad_for_attribution(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function resolve_ad_for_attribution(uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- match_and_stamp_lead_attribution
--
-- Reads one lead_attribution row, runs resolve_ad_for_attribution, writes
-- the result back onto the attribution row, and (if an ad was matched
-- AND the lead has no attribution yet) stamps the lead. First attribution
-- wins — this is intentional, "the ad that brought them in" doesn't
-- change just because they later visit again with a different utm.
-- ---------------------------------------------------------------------------
create or replace function match_and_stamp_lead_attribution(
  p_attribution_id uuid
)
  returns table (
    attribution_id uuid,
    matched_ad_id  uuid,
    strategy       text,
    stamped_lead   boolean
  )
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  attr     record;
  resolved record;
  did_stamp boolean := false;
begin
  select *
    into attr
    from lead_attribution
   where id = p_attribution_id
     for update;
  if not found then
    return;
  end if;

  select * into resolved
    from resolve_ad_for_attribution(
      attr.company_id,
      attr.utm_content,
      attr.utm_campaign,
      attr.fbclid
    );

  update lead_attribution
     set matched_ad_id = resolved.ad_id,
         match_strategy = resolved.strategy,
         matched_at = now()
   where id = p_attribution_id;

  if resolved.ad_id is not null then
    update leads
       set attributed_ad_id = resolved.ad_id,
           attributed_at    = now(),
           attributed_via   = resolved.strategy
     where id = attr.lead_id
       and company_id = attr.company_id
       and attributed_ad_id is null;
    if found then did_stamp := true; end if;
  end if;

  attribution_id := p_attribution_id;
  matched_ad_id := resolved.ad_id;
  strategy := resolved.strategy;
  stamped_lead := did_stamp;
  return next;
end;
$$;

revoke execute on function match_and_stamp_lead_attribution(uuid)
  from public, anon, authenticated;
grant execute on function match_and_stamp_lead_attribution(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- backfill_lead_event_attribution
--
-- Stamps lead_events.ad_id retroactively for events whose lead has
-- `attributed_ad_id` set but the event row was inserted before the
-- attribution match resolved. Idempotent — only updates rows where
-- ad_id IS NULL. Returns per-lead counts.
-- ---------------------------------------------------------------------------
create or replace function backfill_lead_event_attribution()
  returns table (lead_id uuid, events_updated bigint)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  r record;
  affected bigint;
begin
  for r in
    select l.id as lid, l.attributed_ad_id as aid
      from leads l
     where l.attributed_ad_id is not null
  loop
    update lead_events
       set ad_id = r.aid
     where lead_id = r.lid
       and ad_id is null;
    get diagnostics affected = row_count;
    if affected > 0 then
      lead_id := r.lid;
      events_updated := affected;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function backfill_lead_event_attribution()
  from public, anon, authenticated;
grant execute on function backfill_lead_event_attribution()
  to service_role;
