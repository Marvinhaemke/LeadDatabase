-- =============================================================================
-- Custom access token hook
--
-- Reads `app_users` for the signing-in user and merges `company_id` and
-- `app_role` into the JWT. Configured in supabase/config.toml under
-- [auth.hook.custom_access_token].
--
-- This is the *only* place the JWT learns about tenancy. Everything else —
-- RLS, dashboard middleware, ingest auth — derives from these claims.
-- =============================================================================

create or replace function public.custom_access_token_hook(event jsonb)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  claims      jsonb;
  user_record record;
begin
  claims := coalesce(event -> 'claims', '{}'::jsonb);

  select au.company_id, au.role::text as role
    into user_record
  from public.app_users au
  where au.user_id = (event ->> 'user_id')::uuid;

  if found then
    claims := claims
      || jsonb_build_object(
        'company_id', coalesce(user_record.company_id::text, ''),
        'app_role',   user_record.role
      );
  else
    -- User isn't yet provisioned in app_users; default to 'member' with no company.
    -- The dashboard middleware will redirect them to an "awaiting access" page.
    claims := claims
      || jsonb_build_object('company_id', '', 'app_role', 'member');
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Allow the auth admin role to call the hook.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on public.app_users to supabase_auth_admin;
