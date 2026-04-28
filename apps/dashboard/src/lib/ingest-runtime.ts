/**
 * Ingest orchestrator.
 *
 * Two entry points need this: the webhook route (best-effort inline run) and
 * the cron sweeper (scheduled retries). Both call `processInboxRow` with an
 * inbox id; this file owns the lifecycle: claim → call Gemini → apply →
 * log → mark processed/failed.
 */
import { applyPlan, callGemini, getCachedSchemaSummary } from 'ai';
import { createSupabaseAdminClient } from 'db/admin';

const MAX_ATTEMPTS = 5;

export interface ProcessOptions {
  /** When true, only process rows in 'pending' state (skip retries). */
  pendingOnly?: boolean;
}

export type ProcessOutcome =
  | { status: 'processed'; inboxId: string; ignored: boolean }
  | { status: 'skipped'; inboxId: string; reason: string }
  | { status: 'failed'; inboxId: string; error: string };

/**
 * Process a single webhook_inbox row. Atomically claims it (status
 * pending|failed → processing) using `update ... where status in ...
 * returning *`; if the claim returns nothing, another worker has it
 * and we exit cleanly.
 */
export async function processInboxRow(
  inboxId: string,
  opts: ProcessOptions = {},
): Promise<ProcessOutcome> {
  const client = createSupabaseAdminClient();
  const allowedStatuses = opts.pendingOnly ? ['pending'] : ['pending', 'failed'];

  // Atomic claim.
  const { data: claimed, error: claimErr } = await client
    .from('webhook_inbox')
    .update({ status: 'processing' })
    .eq('id', inboxId)
    .in('status', allowedStatuses)
    .select(
      'id, company_id, source, source_event, payload, attempts',
    )
    .maybeSingle();
  if (claimErr) return { status: 'failed', inboxId, error: claimErr.message };
  if (!claimed) return { status: 'skipped', inboxId, reason: 'not in claimable state' };

  if (claimed.attempts >= MAX_ATTEMPTS) {
    await client
      .from('webhook_inbox')
      .update({ status: 'failed', last_error: 'max attempts exceeded' })
      .eq('id', claimed.id);
    return { status: 'skipped', inboxId, reason: 'max attempts exceeded' };
  }

  try {
    const summary = await getCachedSchemaSummary(client, claimed.company_id);
    const gemini = await callGemini({
      schemaSummary: summary.text,
      source: claimed.source,
      sourceEvent: claimed.source_event,
      payload: claimed.payload,
    });

    const applied = await applyPlan({
      client,
      companyId: claimed.company_id,
      webhookInboxId: claimed.id,
      source: claimed.source,
      plan: gemini.plan,
    });

    // Audit log — never updated, only inserted.
    await client.from('webhook_processing_log').insert({
      company_id: claimed.company_id,
      webhook_inbox_id: claimed.id,
      model: gemini.model,
      prompt_version: gemini.promptVersion,
      decision: gemini.plan as unknown as Record<string, unknown>,
      applied_changes: applied as unknown as Record<string, unknown>,
      latency_ms: gemini.latencyMs,
      prompt_tokens: gemini.promptTokens ?? null,
      completion_tokens: gemini.completionTokens ?? null,
    });

    await client
      .from('webhook_inbox')
      .update({
        status: applied.ignored ? 'ignored' : 'processed',
        processed_at: new Date().toISOString(),
        attempts: claimed.attempts + 1,
        last_error: null,
      })
      .eq('id', claimed.id);

    return { status: 'processed', inboxId, ignored: applied.ignored };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await client
      .from('webhook_inbox')
      .update({
        status: 'failed',
        attempts: claimed.attempts + 1,
        last_error: message.slice(0, 2000),
      })
      .eq('id', claimed.id);
    return { status: 'failed', inboxId, error: message };
  }
}

/**
 * Pull a batch of unprocessed rows for the cron sweeper. Returns ids only;
 * callers loop and call `processInboxRow` per id (which re-claims atomically).
 */
export async function listPendingInboxIds(limit = 25): Promise<string[]> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from('webhook_inbox')
    .select('id')
    .in('status', ['pending', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('received_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id);
}
