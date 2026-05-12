-- =============================================================================
-- Grant access to the `app` schema for RLS evaluation
--
-- The RLS policies on tenant tables call `app.is_admin()` and
-- `app.current_company_id()`. Postgres requires that the calling role
-- have USAGE on the schema containing those functions, otherwise the
-- policy raises:
--
--   permission denied for schema app (SQLSTATE 42501)
--
-- … and the query returns NULL even though the row exists. Granting
-- USAGE + EXECUTE here lets the authenticated and anon roles evaluate
-- the policies (the functions are still SECURITY INVOKER, so they only
-- see what the calling role would see).
-- =============================================================================

grant usage on schema app to authenticated, anon, service_role;

grant execute on function app.current_company_id() to authenticated, anon, service_role;
grant execute on function app.current_role()       to authenticated, anon, service_role;
grant execute on function app.is_admin()           to authenticated, anon, service_role;
