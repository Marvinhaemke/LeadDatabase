-- =============================================================================
-- Row Level Security
--
-- Tenancy model:
--   - JWT carries `company_id` and `app_role` claims (set by the access-token hook).
--   - Members can only see/write rows where company_id = their JWT claim.
--   - Admins (app_role = 'admin') see/write across all companies.
--   - Service role bypasses RLS entirely (used by ingest workers + scripts).
--
-- All policies are written via app.is_admin() / app.current_company_id() so
-- the predicate is identical across tables — change in one place to evolve.
-- =============================================================================

-- Companies: members see only their own; admins see all.
alter table companies enable row level security;

create policy companies_select on companies
  for select using (app.is_admin() or id = app.current_company_id());

create policy companies_admin_write on companies
  for all using (app.is_admin()) with check (app.is_admin());

-- App users: a user can read their own row; admins see all.
alter table app_users enable row level security;

create policy app_users_select_self on app_users
  for select using (app.is_admin() or user_id = auth.uid());

create policy app_users_admin_write on app_users
  for all using (app.is_admin()) with check (app.is_admin());

-- Generic per-company RLS — applied identically to every tenant table.
do $$
declare
  t text;
  tenant_tables text[] := array[
    'pipeline_stages',
    'ad_accounts',
    'campaigns',
    'ad_sets',
    'ads',
    'ad_metrics_daily',
    'leads',
    'lead_attribution',
    'bookings',
    'deals',
    'deal_stage_history',
    'lead_events',
    'webhook_inbox',
    'webhook_processing_log',
    'field_proposals',
    'entity_aliases'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);

    execute format($f$
      create policy %I on %I
        for select using (
          app.is_admin()
          or company_id = app.current_company_id()
          or company_id is null  -- global rows (e.g. entity_aliases defaults)
        )
    $f$, t || '_select', t);

    execute format($f$
      create policy %I on %I
        for insert with check (
          app.is_admin()
          or company_id = app.current_company_id()
        )
    $f$, t || '_insert', t);

    execute format($f$
      create policy %I on %I
        for update using (
          app.is_admin()
          or company_id = app.current_company_id()
        ) with check (
          app.is_admin()
          or company_id = app.current_company_id()
        )
    $f$, t || '_update', t);

    execute format($f$
      create policy %I on %I
        for delete using (
          app.is_admin()
          or company_id = app.current_company_id()
        )
    $f$, t || '_delete', t);
  end loop;
end$$;

-- Append-only enforcement on event/log tables: deny update/delete to
-- non-service roles even if the company_id matches. Admins can correct
-- via service role + audit, not via the dashboard.
revoke update, delete on lead_events from authenticated, anon;
revoke update, delete on deal_stage_history from authenticated, anon;
revoke update, delete on webhook_processing_log from authenticated, anon;
revoke update, delete on webhook_inbox from authenticated, anon;
