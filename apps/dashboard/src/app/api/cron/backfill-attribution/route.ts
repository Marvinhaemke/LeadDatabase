/**
 * Hourly attribution backfill. Calls `backfill_lead_event_attribution()`
 * which retroactively stamps `lead_events.ad_id` for events whose lead
 * now has an `attributed_ad_id` but the event row was inserted before
 * the attribution match resolved.
 *
 * Common cases this handles:
 *   - A booking webhook arrives before the form-submission webhook
 *     finished processing, so the `booking_created` event landed without
 *     an ad_id. Once the form's attribution resolves, this cron fixes it.
 *   - The Meta sync runs and creates `ads` rows that didn't exist when
 *     earlier attribution attempts ran. Future ingest will match, but
 *     past unmatched events get retro-stamped here.
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
  const { data, error } = await client.rpc('backfill_lead_event_attribution');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const results = (data ?? []) as Array<{ lead_id: string; events_updated: number }>;
  const totalEvents = results.reduce((n, r) => n + Number(r.events_updated ?? 0), 0);
  return NextResponse.json({ leads: results.length, events_updated: totalEvents });
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
