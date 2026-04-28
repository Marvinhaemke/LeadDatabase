/**
 * Cron sweeper. Vercel Cron hits this every minute (see vercel.json).
 * Picks up to 25 pending/failed inbox rows and processes them.
 *
 * Auth: Vercel Cron sends an `Authorization: Bearer <CRON_SECRET>` header.
 * For local testing, the route also accepts the INGEST_SHARED_SECRET as a
 * fallback so you can curl it.
 */
import { NextResponse } from 'next/server';
import { listPendingInboxIds, processInboxRow } from '@/lib/ingest-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const ids = await listPendingInboxIds(25);
  const results = await Promise.allSettled(ids.map((id) => processInboxRow(id)));

  const summary = {
    picked: ids.length,
    processed: 0,
    failed: 0,
    skipped: 0,
    ignored: 0,
  };
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      summary.failed++;
      continue;
    }
    if (r.value.status === 'processed') {
      summary.processed++;
      if (r.value.ignored) summary.ignored++;
    } else if (r.value.status === 'failed') summary.failed++;
    else summary.skipped++;
  }

  return NextResponse.json(summary);
}

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const ingestSecret = process.env.INGEST_SHARED_SECRET;
  const authHeader = req.headers.get('authorization');
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  if (ingestSecret && req.headers.get('x-ingest-secret') === ingestSecret) return true;
  // No secret configured at all → only allow in development.
  if (!cronSecret && !ingestSecret && process.env.NODE_ENV !== 'production') return true;
  return false;
}
