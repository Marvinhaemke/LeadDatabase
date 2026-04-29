/**
 * Helpers for the field-proposal review UI.
 *
 * Reading sample values + counts uses the service-role client because
 * member users can already read this data via RLS — the admin client
 * just avoids one round-trip for permission resolution and works for
 * cross-company admin views.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'db/types';

type Client = SupabaseClient<Database>;

export interface ProposalSample {
  /** Total rows in the entity (this company) carrying this attribute key. */
  total: number;
  /** Most-recent values seen (deduped, capped at `limit`). */
  recentValues: Array<{ value: unknown; createdAt: string | null }>;
}

export async function loadProposalSample(
  client: Client,
  companyId: string,
  entity: 'leads' | 'bookings' | 'deals',
  fieldKey: string,
  limit = 25,
): Promise<ProposalSample> {
  // PostgREST doesn't expose the jsonb `?` operator on dynamic keys
  // directly, so we scan a recent window and filter in JS. For accurate
  // global counts an operator can read field_proposals.occurrence_count.
  const SCAN_LIMIT = 500;
  const { data } = await client
    .from(entity)
    .select('attributes, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(SCAN_LIMIT);

  const distinctValues: ProposalSample['recentValues'] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const row of data ?? []) {
    const attrs = (row as { attributes?: Record<string, unknown> }).attributes;
    if (!attrs || typeof attrs !== 'object') continue;
    if (!(fieldKey in attrs)) continue;

    total += 1;
    const v = attrs[fieldKey];
    const dedupKey = JSON.stringify(v);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    if (distinctValues.length < limit) {
      distinctValues.push({
        value: v,
        createdAt: (row as { created_at?: string }).created_at ?? null,
      });
    }
  }

  return { total, recentValues: distinctValues };
}

/**
 * Suggest a default Postgres type from the inferred-type label the AI gave.
 */
export function inferredToPgType(inferred: string | null): string {
  switch (inferred) {
    case 'number':
      return 'numeric';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'timestamptz';
    case 'json':
      return 'jsonb';
    default:
      return 'text';
  }
}

export const ALLOWED_PG_TYPES = [
  'text',
  'citext',
  'numeric',
  'integer',
  'bigint',
  'boolean',
  'timestamptz',
  'date',
  'jsonb',
] as const;
