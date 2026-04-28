-- =============================================================================
-- Extensions and shared helpers
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- All app schema lives in `public` (Supabase's default). Helpers live in `app`.
create schema if not exists app;

-- ---------------------------------------------------------------------------
-- JWT claim helpers
--
-- The dashboard issues JWTs with two custom claims:
--   - company_id: uuid of the company the user is scoped to
--   - role:       'admin' | 'member'
--
-- These helpers extract those claims for use in RLS policies. They are
-- SECURITY DEFINER so they can be called from policies regardless of
-- the executing role.
-- ---------------------------------------------------------------------------

create or replace function app.current_company_id()
  returns uuid
  language sql
  stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'company_id', '')::uuid
$$;

create or replace function app.current_role()
  returns text
  language sql
  stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'app_role', '')
$$;

create or replace function app.is_admin()
  returns boolean
  language sql
  stable
as $$
  select coalesce(app.current_role() = 'admin', false)
$$;

-- Touch helper for updated_at columns.
create or replace function app.touch_updated_at()
  returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
