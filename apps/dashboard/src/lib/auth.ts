/**
 * Server-side session/identity helpers for the dashboard.
 *
 * We use Supabase Auth (email + password). The custom access-token hook
 * (see migration 20260101000006_auth_hook.sql) puts `company_id` and
 * `app_role` on every JWT. RLS uses those claims; the dashboard reads
 * them via a single query against `app_users` so we can join the
 * company slug for display + URL routing in one round-trip.
 *
 * `cache()` ensures one query per request even if multiple Server
 * Components / layouts ask for the user.
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';

export type AppRole = 'admin' | 'member';

export interface CurrentUser {
  userId: string;
  email: string | null;
  role: AppRole;
  companyId: string | null;
  companySlug: string | null;
  companyName: string | null;
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return null;

  const { data } = await client
    .from('app_users')
    .select('role, company_id, companies:company_id ( slug, name )')
    .eq('user_id', user.id)
    .maybeSingle();

  // `data.companies` is a join; the placeholder Database type has it as `any`.
  // Real generated types will tighten this once `pnpm db:types` is run.
  const company = (data as { companies?: { slug?: string; name?: string } } | null)?.companies;

  return {
    userId: user.id,
    email: user.email ?? null,
    role: ((data?.role as AppRole | undefined) ?? 'member'),
    companyId: (data?.company_id as string | null) ?? null,
    companySlug: company?.slug ?? null,
    companyName: company?.name ?? null,
  };
});

/**
 * Throws a redirect-equivalent error if the user can't access the company.
 * Use in `[company]/layout.tsx` to gate company-scoped routes.
 */
export async function requireCompanyAccess(slug: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new RedirectError('/sign-in');
  if (user.role === 'admin') return user;
  if (!user.companySlug) throw new RedirectError('/awaiting-access');
  if (user.companySlug !== slug) throw new RedirectError(`/${user.companySlug}`);
  return user;
}

export class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}
