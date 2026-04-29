-- =============================================================================
-- Field-proposal review workflow
--
-- Adds the columns and the `apply_field_proposal` SQL function used by the
-- /[company]/proposals dashboard pages.
--
-- DATA-PRESERVATION INVARIANT
--   - Unknown fields are stored in `entity.attributes jsonb` from the
--     moment they arrive. They stay there forever unless explicitly
--     dropped. Review is therefore non-blocking: if you don't review
--     for 30 days, no data is lost.
--   - Applying a proposal:
--       1. ADD COLUMN IF NOT EXISTS — idempotent.
--       2. Backfill from attributes -> column.
--       3. Optionally drop the key from attributes.
--   - With `drop_attribute_after = false` (the default), data lives in
--     both the typed column AND attributes — so the AI can keep writing
--     to attributes and a daily backfill cron keeps the column fresh.
--   - When the schema-summary cache refreshes, the AI learns about the
--     typed column and starts writing there directly.
--
-- SAFETY
--   - SQL injection: the function whitelists entity names + the column
--     type, and validates the column identifier against a regex before
--     interpolating with %I.
--   - DDL is only callable by service_role.
-- =============================================================================

alter table field_proposals
  add column if not exists target_column_name  text,
  add column if not exists target_column_type  text,
  add column if not exists drop_attribute_after boolean not null default false,
  add column if not exists applied_at          timestamptz,
  add column if not exists applied_by          uuid references auth.users(id) on delete set null,
  add column if not exists last_seen_at        timestamptz not null default now();

create or replace function apply_field_proposal(
  p_proposal_id uuid,
  p_actor       uuid default null
)
  returns table (proposal_id uuid, applied boolean, error text, rows_backfilled bigint)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  proposal       record;
  col_name       text;
  col_type       text;
  affected       bigint := 0;
  -- Allow-listed: entity tables we permit DDL on.
  entity_allowed text[] := array['leads', 'bookings', 'deals'];
  -- Allow-listed: pg types we accept for promoted columns. Anything else
  -- requires a real migration (and a brain).
  type_allowed   text[] := array[
    'text', 'citext', 'numeric', 'integer', 'bigint',
    'boolean', 'timestamptz', 'date', 'jsonb'
  ];
begin
  select *
    into proposal
    from field_proposals
   where id = p_proposal_id
     for update;

  if not found then
    return query select p_proposal_id, false, 'proposal not found', 0::bigint;
    return;
  end if;

  if proposal.status = 'applied' then
    return query select p_proposal_id, false, 'already applied', 0::bigint;
    return;
  end if;
  if proposal.status = 'rejected' then
    return query select p_proposal_id, false, 'proposal was rejected', 0::bigint;
    return;
  end if;
  if proposal.proposal_kind <> 'attribute' then
    return query select p_proposal_id, false,
      'only attribute proposals can be auto-applied (entity proposals require a real migration)',
      0::bigint;
    return;
  end if;
  if not (proposal.entity = any (entity_allowed)) then
    return query select p_proposal_id, false,
      format('entity %s not in allow-list', proposal.entity), 0::bigint;
    return;
  end if;
  if proposal.field_key is null then
    return query select p_proposal_id, false, 'missing field_key', 0::bigint;
    return;
  end if;

  col_name := coalesce(proposal.target_column_name, proposal.field_key);
  col_type := coalesce(
    proposal.target_column_type,
    case proposal.inferred_type
      when 'number'  then 'numeric'
      when 'boolean' then 'boolean'
      when 'date'    then 'timestamptz'
      when 'json'    then 'jsonb'
      else 'text'
    end
  );

  if col_name !~ '^[a-z_][a-z0-9_]{0,62}$' then
    return query select p_proposal_id, false,
      format('invalid column name: %s', col_name), 0::bigint;
    return;
  end if;
  if not (col_type = any (type_allowed)) then
    return query select p_proposal_id, false,
      format('disallowed type: %s', col_type), 0::bigint;
    return;
  end if;

  -- 1. Add the column (no-op if it already exists).
  execute format(
    'alter table %I add column if not exists %I %s',
    proposal.entity, col_name, col_type
  );

  -- 2. Backfill: attributes ->> 'key' cast to the typed column.
  --    Scoped to this company; other tenants keep their attributes intact.
  --    Uses a `case` on inferred_type to pick the right cast — `::numeric`
  --    blows up on 'true'/'false', `::boolean` on '0'/'1' edge cases, etc.
  execute format(
    'update %I set %I = (attributes ->> %L)::%s '
    || 'where company_id = %L and (attributes ? %L) and (attributes ->> %L) is not null',
    proposal.entity, col_name, proposal.field_key, col_type,
    proposal.company_id, proposal.field_key, proposal.field_key
  );
  get diagnostics affected = row_count;

  -- 3. Optionally drop the key from attributes (caller decides).
  if proposal.drop_attribute_after then
    execute format(
      'update %I set attributes = attributes - %L '
      || 'where company_id = %L and (attributes ? %L)',
      proposal.entity, proposal.field_key, proposal.company_id, proposal.field_key
    );
  end if;

  update field_proposals
     set status              = 'applied',
         applied_at          = now(),
         applied_by          = p_actor,
         decided_at          = coalesce(decided_at, now()),
         decided_by          = coalesce(decided_by, p_actor),
         target_column_name  = col_name,
         target_column_type  = col_type
   where id = p_proposal_id;

  return query select p_proposal_id, true, null::text, affected;
end;
$$;

revoke execute on function apply_field_proposal(uuid, uuid) from public, authenticated, anon;
grant execute on function apply_field_proposal(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Backfill cron support
--
-- Re-applies the attributes → typed-column copy for every applied proposal
-- where `drop_attribute_after = false`. Run daily; keeps promoted columns
-- in sync with attributes the AI is still writing to (until the AI's
-- schema-summary cache learns about the promoted column).
-- ---------------------------------------------------------------------------
create or replace function backfill_applied_proposals()
  returns table (proposal_id uuid, rows_backfilled bigint)
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  p record;
  affected bigint;
begin
  for p in
    select id, company_id, entity, field_key, target_column_name, target_column_type
      from field_proposals
     where status = 'applied'
       and drop_attribute_after = false
       and target_column_name is not null
       and target_column_type is not null
  loop
    if p.entity not in ('leads', 'bookings', 'deals') then
      continue;
    end if;
    if p.target_column_name !~ '^[a-z_][a-z0-9_]{0,62}$' then
      continue;
    end if;

    execute format(
      'update %I set %I = (attributes ->> %L)::%s '
      || 'where company_id = %L and (attributes ? %L) and (attributes ->> %L) is not null '
      || 'and (%I is distinct from (attributes ->> %L)::%s)',
      p.entity, p.target_column_name, p.field_key, p.target_column_type,
      p.company_id, p.field_key, p.field_key,
      p.target_column_name, p.field_key, p.target_column_type
    );
    get diagnostics affected = row_count;

    proposal_id := p.id;
    rows_backfilled := affected;
    return next;
  end loop;
end;
$$;

revoke execute on function backfill_applied_proposals() from public, authenticated, anon;
grant execute on function backfill_applied_proposals() to service_role;
