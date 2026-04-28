/**
 * Webhook entry point.
 *
 *   POST /api/webhook/<company-slug>/<source>
 *
 * Headers:
 *   x-ingest-secret      required when INGEST_SHARED_SECRET is set
 *   x-idempotency-key    optional sender-supplied idempotency hint
 *   x-source-event       optional source-event hint (e.g. 'booking.created')
 *
 * Behaviour:
 *   1. Resolve the company slug → company_id.
 *   2. Validate the source against WEBHOOK_ALLOWED_SOURCES.
 *   3. Insert the raw payload into webhook_inbox with a deterministic
 *      idempotency_key. On conflict, return the existing row's status.
 *   4. Best-effort kick off processing in the background via `after()`.
 *   5. Return 202 immediately so the sender doesn't wait on Gemini.
 */
import { unstable_after as after, NextResponse } from 'next/server';
import { createSupabaseAdminClient } from 'db/admin';
import { buildIdempotencyKey } from '@/lib/idempotency';
import { processInboxRow } from '@/lib/ingest-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ company: string; source: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { company: companySlug, source } = await params;

  const sharedSecret = process.env.INGEST_SHARED_SECRET;
  if (sharedSecret) {
    const supplied = req.headers.get('x-ingest-secret');
    if (supplied !== sharedSecret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const allowedSources = (process.env.WEBHOOK_ALLOWED_SOURCES ?? 'zapier,calendly,native,meta')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowedSources.includes(source)) {
    return NextResponse.json({ error: `unknown source: ${source}` }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();

  const { data: company } = await admin
    .from('companies')
    .select('id')
    .eq('slug', companySlug)
    .maybeSingle();
  if (!company) {
    return NextResponse.json({ error: `unknown company: ${companySlug}` }, { status: 404 });
  }

  const idempotencyKey = buildIdempotencyKey({
    source,
    body: payload,
    clientKey: req.headers.get('x-idempotency-key'),
  });

  const sourceEvent = req.headers.get('x-source-event');
  const headers = collectHeaders(req);

  // Insert; on conflict, fetch existing row to return its status.
  const insertRes = await admin
    .from('webhook_inbox')
    .insert({
      company_id: company.id,
      source,
      source_event: sourceEvent,
      idempotency_key: idempotencyKey,
      payload: payload as never,
      headers: headers as never,
    })
    .select('id, status')
    .single();

  let inboxId: string;
  let status: string;
  let duplicate = false;

  if (insertRes.error) {
    if (insertRes.error.code === '23505') {
      // Duplicate idempotency_key — return the existing row's state.
      const { data: existing } = await admin
        .from('webhook_inbox')
        .select('id, status')
        .eq('company_id', company.id)
        .eq('idempotency_key', idempotencyKey)
        .single();
      if (!existing) {
        return NextResponse.json({ error: 'idempotency conflict' }, { status: 500 });
      }
      inboxId = existing.id;
      status = existing.status;
      duplicate = true;
    } else {
      return NextResponse.json({ error: insertRes.error.message }, { status: 500 });
    }
  } else {
    inboxId = insertRes.data.id;
    status = insertRes.data.status;
  }

  // Best-effort inline processing. If this throws or times out, the cron
  // sweeper picks the row up. Skip if it's a duplicate that's already done.
  if (!duplicate || status === 'pending' || status === 'failed') {
    after(async () => {
      try {
        await processInboxRow(inboxId);
      } catch {
        // Errors are persisted to webhook_inbox.last_error by the worker.
      }
    });
  }

  return NextResponse.json(
    { id: inboxId, status, duplicate },
    { status: duplicate ? 200 : 202 },
  );
}

function collectHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    // Don't store auth secrets in the audit log.
    if (key === 'x-ingest-secret' || key === 'authorization' || key === 'cookie') return;
    out[key] = value;
  });
  return out;
}
