/**
 * No-show sweeper. Vercel Cron hits this every 5 minutes (see vercel.json).
 * Calls the `sweep_bookings_to_no_show` SQL function which atomically flips
 * stale `scheduled` bookings to `no_show` and emits the matching event.
 */
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from 'db/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const client = createSupabaseAdminClient();
  // @ts-expect-error rpc isn't in the placeholder Database type
  const { data, error } = await client.rpc('sweep_bookings_to_no_show', {
    p_grace_minutes: 15,
    p_limit: 200,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ swept: (data ?? []).length });
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
