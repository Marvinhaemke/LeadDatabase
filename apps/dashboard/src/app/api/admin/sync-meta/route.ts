/**
 * Admin-triggered Meta sync. Useful for backfilling beyond the cron's
 * 7-day window or forcing a refresh after creating a new ad_account.
 *
 *   POST /api/admin/sync-meta?company=<slug>&days=30
 *
 * Auth: must be signed in as an admin (RLS-respecting Supabase session).
 */
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from 'db/admin';
import { syncCompanyMetaAccounts, syncAllMetaAccounts } from 'meta';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'META_SYSTEM_USER_TOKEN not configured' },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get('company');
  const days = clampInt(url.searchParams.get('days'), 1, 365, 7);

  const client = createSupabaseAdminClient();

  if (!slug) {
    const summaries = await syncAllMetaAccounts({
      client,
      accessToken: token,
      apiVersion: process.env.META_API_VERSION,
      windowDays: days,
    });
    return NextResponse.json({ scope: 'all', accounts: summaries.length, summaries });
  }

  const { data: company } = await client
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (!company) {
    return NextResponse.json({ error: `unknown company: ${slug}` }, { status: 404 });
  }

  const summaries = await syncCompanyMetaAccounts({
    client,
    companyId: company.id as string,
    accessToken: token,
    apiVersion: process.env.META_API_VERSION,
    windowDays: days,
  });
  return NextResponse.json({ scope: slug, accounts: summaries.length, summaries });
}

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
