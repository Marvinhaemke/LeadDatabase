/**
 * Builds a compact natural-language summary of the per-company schema for
 * the Gemini prompt. The summary is what teaches the model:
 *   - which entities exist,
 *   - which typed columns each has,
 *   - which JSONB attribute keys are already in use (so the model reuses
 *     them instead of inventing new ones for the same concept),
 *   - which aliases map back to canonical keys.
 *
 * Output is plain text, ~1–2 KB, cached per company (10 min) by the worker.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'db/types';

interface SchemaSummary {
  text: string;
  pipelineStages: string[];
  fetchedAt: number;
}

type Client = SupabaseClient<Database>;

const STATIC_SCHEMA = `
ENTITIES (typed columns shown; everything else goes into \`attributes\` jsonb):

leads
  email (citext, unique per company)
  phone (text, E.164)
  first_name, last_name (text)
  source (text)

bookings
  external_id (text, from calendar tool)
  meeting_type (text, e.g. 'setting_call', 'closing_call')
  scheduled_at (timestamptz)
  status (enum: scheduled | held | no_show | cancelled_by_lead | cancelled_by_us | rescheduled)
  duration_minutes (int)
  previous_external_id (only for reschedules — id of the booking this supersedes)

deals
  stage_key (matches pipeline_stages.key for this company — see PIPELINE below)
  status (enum: open | won | lost)
  amount (number)
  currency (3-letter code)
  closed_at (timestamptz)

lead_events (append-only — emit one for every funnel-relevant transition)
  type (enum: form_submitted | booking_created | booking_rescheduled | booking_held |
              booking_no_show | booking_cancelled | qualified | disqualified |
              proposal_sent | won | lost | refunded | custom)
  occurred_at (timestamptz)
  amount, currency (for won/refunded)

attribution (write when the payload contains any of these)
  fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  landing_url, referrer_url
`.trim();

export async function buildSchemaSummary(
  client: Client,
  companyId: string,
): Promise<SchemaSummary> {
  const [stagesRes, aliasesRes, leadKeysRes, bookingKeysRes, dealKeysRes] = await Promise.all([
    client
      .from('pipeline_stages')
      .select('key,label,position')
      .eq('company_id', companyId)
      .order('position'),
    client
      .from('entity_aliases')
      .select('entity,canonical_key,alias')
      .or(`company_id.eq.${companyId},company_id.is.null`),
    sampleAttributeKeys(client, 'leads', companyId),
    sampleAttributeKeys(client, 'bookings', companyId),
    sampleAttributeKeys(client, 'deals', companyId),
  ]);

  const stages = stagesRes.data ?? [];
  const aliases = aliasesRes.data ?? [];

  const stageList = stages
    .map((s) => `  ${s.key} ("${s.label}", position ${s.position})`)
    .join('\n');

  const aliasList = aliases
    .map((a) => `  ${a.entity}.${a.alias} → ${a.canonical_key}`)
    .join('\n');

  const text = [
    STATIC_SCHEMA,
    '',
    'PIPELINE STAGES (use the `key` for deal.stage_key):',
    stageList || '  (none configured)',
    '',
    'KNOWN ALIASES (map these source field names to the canonical key):',
    aliasList || '  (none)',
    '',
    'EXISTING ATTRIBUTE KEYS already in use (prefer reusing):',
    `  leads:    ${formatKeys(leadKeysRes)}`,
    `  bookings: ${formatKeys(bookingKeysRes)}`,
    `  deals:    ${formatKeys(dealKeysRes)}`,
  ].join('\n');

  return {
    text,
    pipelineStages: stages.map((s) => s.key),
    fetchedAt: Date.now(),
  };
}

function formatKeys(keys: string[]): string {
  return keys.length === 0 ? '(none)' : keys.join(', ');
}

/**
 * Cheap sampler: pull recent rows and union their JSON keys. Capped to keep
 * the prompt small; we don't need every key, just a representative set.
 */
async function sampleAttributeKeys(
  client: Client,
  table: 'leads' | 'bookings' | 'deals',
  companyId: string,
): Promise<string[]> {
  const { data } = await client
    .from(table)
    .select('attributes')
    .eq('company_id', companyId)
    .order('updated_at', { ascending: false })
    .limit(50);

  if (!data) return [];
  const keys = new Set<string>();
  for (const row of data) {
    const attrs = (row as { attributes: unknown }).attributes;
    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
      for (const k of Object.keys(attrs as Record<string, unknown>)) {
        keys.add(k);
        if (keys.size >= 30) break;
      }
    }
    if (keys.size >= 30) break;
  }
  return Array.from(keys).sort();
}

// ---------------------------------------------------------------------------
// In-memory cache. Fine for serverless: each instance gets its own cache,
// and stale entries (>10 min) get refreshed.
// ---------------------------------------------------------------------------

const CACHE = new Map<string, SchemaSummary>();
const TTL_MS = 10 * 60 * 1000;

export async function getCachedSchemaSummary(
  client: Client,
  companyId: string,
): Promise<SchemaSummary> {
  const cached = CACHE.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  const fresh = await buildSchemaSummary(client, companyId);
  CACHE.set(companyId, fresh);
  return fresh;
}

export function invalidateSchemaSummary(companyId: string): void {
  CACHE.delete(companyId);
}
