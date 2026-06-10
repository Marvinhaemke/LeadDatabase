/**
 * Funnel-rule evaluation. Pure logic — no DB, no side effects.
 *
 * Used by:
 *   - apply.ts (ingest): pick the funnel a fresh event belongs to.
 *   - Dashboard settings UI: live-preview which leads a draft funnel
 *     would match without saving.
 *   - The rematch endpoint: re-stamp historical events after rule edits.
 *
 * A funnel matches when ALL its filters pass against an attribution
 * context. When multiple funnels match, the one with the lowest
 * `priority` wins (ties broken by `id` order at the caller).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const FILTER_FIELDS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'landing_url',
  'referrer_url',
  /** Internal ad's external_id (Meta ad id). */
  'ad_external_id',
  /** Internal campaign's external_id (Meta campaign id). */
  'campaign_external_id',
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_OPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_set',
  'is_not_set',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

const filterSchema = z.discriminatedUnion('op', [
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('eq'), value: z.string() }),
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('neq'), value: z.string() }),
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('contains'), value: z.string() }),
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('not_contains'), value: z.string() }),
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('in'), value: z.array(z.string()).min(1) }),
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('not_in'), value: z.array(z.string()).min(1) }),
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('is_set') }),
  z.object({ field: z.enum(FILTER_FIELDS), op: z.literal('is_not_set') }),
]);

export const FilterSchema = filterSchema;
export type FilterCondition = z.infer<typeof filterSchema>;

export const FunnelDefinitionSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(200),
  priority: z.number().int(),
  filters: z.array(filterSchema),
});
export type FunnelDefinition = z.infer<typeof FunnelDefinitionSchema>;

/**
 * Attribution context — the fields a filter can reference. Built by the
 * caller from `lead_attribution` + (optionally) the resolved ad/campaign
 * external_ids when an ad-level match exists.
 */
export interface AttributionContext {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  fbclid?: string | null;
  landing_url?: string | null;
  referrer_url?: string | null;
  ad_external_id?: string | null;
  campaign_external_id?: string | null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function lc(v: string | null | undefined): string {
  return v == null ? '' : String(v).toLowerCase();
}

function isPresent(v: string | null | undefined): boolean {
  return v != null && String(v).length > 0;
}

export function evaluateFilter(filter: FilterCondition, ctx: AttributionContext): boolean {
  const raw = ctx[filter.field];
  switch (filter.op) {
    case 'is_set':
      return isPresent(raw);
    case 'is_not_set':
      return !isPresent(raw);
    case 'eq':
      return lc(raw) === lc(filter.value);
    case 'neq':
      return lc(raw) !== lc(filter.value);
    case 'contains':
      return isPresent(raw) && lc(raw).includes(lc(filter.value));
    case 'not_contains':
      return !lc(raw).includes(lc(filter.value));
    case 'in':
      return filter.value.some((v) => lc(raw) === lc(v));
    case 'not_in':
      return !filter.value.some((v) => lc(raw) === lc(v));
  }
}

/**
 * Match an attribution context against a list of funnel definitions.
 * Returns the matched funnel (lowest priority wins) or null. Funnels
 * with zero filters are skipped — they would match everything and that
 * is almost certainly an operator mistake; surfacing the no-match makes
 * the bug obvious in QA.
 */
export function matchFunnel(
  funnels: ReadonlyArray<FunnelDefinition>,
  ctx: AttributionContext,
): FunnelDefinition | null {
  const sorted = [...funnels].sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
  );
  for (const funnel of sorted) {
    if (funnel.filters.length === 0) continue;
    if (funnel.filters.every((f) => evaluateFilter(f, ctx))) return funnel;
  }
  return null;
}
