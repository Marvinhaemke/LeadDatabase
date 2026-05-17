-- =============================================================================
-- Multi-funnel support: `funnel_key` tag on lead_events
--
-- A "funnel" here is an acquisition path (meta / email / organic / …).
-- Each event is tagged with the funnel that was active when it occurred.
-- The most-recent attribution row for a lead determines the active
-- funnel; past events keep their original tag, so a lead who entered
-- via Meta, dropped out, then re-entered via an email campaign and
-- closed appears in BOTH funnels' numbers — in the right stages.
--
-- We deliberately do NOT store a single "current funnel" on the lead:
-- that would invite us to overwrite history. Events are the source of
-- truth.
-- =============================================================================

alter table lead_events
  add column if not exists funnel_key text;

create index if not exists lead_events_company_funnel_idx
  on lead_events (company_id, funnel_key, occurred_at)
  where funnel_key is not null;

-- Canonical derivation: fbclid → 'meta', else lower(utm_source).
-- Used by the backfill function and the ingest layer should mirror it.
create or replace function derive_funnel_key(
  p_fbclid     text,
  p_utm_source text
)
  returns text
  language sql
  immutable
as $$
  select coalesce(
    case when p_fbclid is not null and p_fbclid <> '' then 'meta' end,
    nullif(lower(trim(p_utm_source)), '')
  );
$$;

revoke execute on function derive_funnel_key(text, text) from public, anon, authenticated;
grant execute on function derive_funnel_key(text, text) to service_role;

-- Backfill: for every event with funnel_key IS NULL, set it from the
-- most-recent prior lead_attribution row. Idempotent (only NULLs).
create or replace function backfill_funnel_keys()
  returns table (events_updated bigint)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  affected bigint;
begin
  with prior_attr as (
    select distinct on (e.id)
      e.id as event_id,
      derive_funnel_key(a.fbclid, a.utm_source) as fk
    from lead_events e
    join lead_attribution a
      on a.company_id = e.company_id
     and a.lead_id    = e.lead_id
     and a.captured_at <= e.occurred_at
    where e.funnel_key is null
    order by e.id, a.captured_at desc
  )
  update lead_events e
     set funnel_key = pa.fk
    from prior_attr pa
   where e.id = pa.event_id
     and pa.fk is not null;
  get diagnostics affected = row_count;

  events_updated := affected;
  return next;
end;
$$;

revoke execute on function backfill_funnel_keys() from public, anon, authenticated;
grant execute on function backfill_funnel_keys() to service_role;
