/**
 * Daily backfill for promoted fields. Calls `backfill_applied_proposals()`
 * which re-syncs `attributes ->> field_key` into the typed column for
 * every applied proposal where `drop_attribute_after = false` — this keeps
 * the typed columns fresh while the AI continues writing into attributes
 * (until its schema-summary cache learns about the promoted column).
 */
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from 'db/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const client = createSupabaseAdminClient();
  const { data, error } = await client.rpc('backfill_applied_proposals');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ proposals: (data ?? []).length, results: data ?? [] });
}

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const ingestSecret = process.env.INGEST_SHARED_SECRET;
  const auth = req.headers.get('authorization');
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  if (ingestSecret && req.headers.get('x-ingest-secret') === ingestSecret) return true;
  if (!cronSecret && !ingestSecret && process.env.NODE_ENV !== 'production') return true;
  return false;
}
