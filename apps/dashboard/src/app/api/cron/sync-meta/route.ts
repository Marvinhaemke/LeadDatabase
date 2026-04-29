/**
 * Hourly Meta sync cron. Walks every Meta ad account across all
 * companies and refreshes the last 7 days of insights — Meta updates
 * attribution numbers retroactively for ~7 days, so a rolling window is
 * required for accurate ROAS.
 */
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from 'db/admin';
import { syncAllMetaAccounts } from 'meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: 'META_SYSTEM_USER_TOKEN not configured' },
      { status: 500 },
    );
  }

  const client = createSupabaseAdminClient();
  try {
    const summaries = await syncAllMetaAccounts({
      client,
      accessToken: token,
      apiVersion: process.env.META_API_VERSION,
      windowDays: 7,
    });
    const errorCount = summaries.reduce((n, s) => n + s.errors.length, 0);
    return NextResponse.json({ accounts: summaries.length, errors: errorCount, summaries });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const ingestSecret = process.env.INGEST_SHARED_SECRET;
  const authHeader = req.headers.get('authorization');
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  if (ingestSecret && req.headers.get('x-ingest-secret') === ingestSecret) return true;
  if (!cronSecret && !ingestSecret && process.env.NODE_ENV !== 'production') return true;
  return false;
}
