/**
 * Funnel discovery.
 *
 * Rather than hard-code the funnel shape, this helper learns it from
 * the data: it counts each `lead_events.event_type` observed for the
 * company in the window, ranks them in canonical order, and adds any
 * non-canonical event types that have actually been used so custom
 * funnels show up too.
 *
 * Stages with zero count still appear when they sit *between* two
 * non-zero canonical stages — that's how you spot pipeline breakages
 * (e.g., "10 forms, 0 bookings, 3 holds" means the calendar webhook
 * isn't writing booking_created).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'db/types';

type Client = SupabaseClient<Database>;

/** Forward-funnel events, in their canonical order (the "ideal" path). */
export const CANONICAL_FUNNEL: ReadonlyArray<{ type: string; label: string; color: string }> = [
  { type: 'form_submitted', label: 'Form submitted', color: 'hsl(220 70% 55%)' },
  { type: 'booking_created', label: 'Booking created', color: 'hsl(260 60% 55%)' },
  { type: 'booking_held', label: 'Calls held', color: 'hsl(160 60% 40%)' },
  { type: 'qualified', label: 'Qualified', color: 'hsl(190 70% 40%)' },
  { type: 'proposal_sent', label: 'Proposal sent', color: 'hsl(35 90% 50%)' },
  { type: 'won', label: 'Won', color: 'hsl(140 70% 35%)' },
];

const CANONICAL_TYPES = new Set(CANONICAL_FUNNEL.map((s) => s.type));

/** Non-canonical events we still want to display, with a sensible default color. */
const EXTRA_EVENT_COLORS: Record<string, string> = {
  booking_no_show: 'hsl(0 70% 50%)',
  booking_rescheduled: 'hsl(40 70% 50%)',
  booking_cancelled: 'hsl(0 0% 50%)',
  disqualified: 'hsl(0 50% 60%)',
  lost: 'hsl(0 60% 55%)',
  refunded: 'hsl(0 80% 45%)',
  custom: 'hsl(280 50% 50%)',
};

const FALLBACK_COLOR = 'hsl(220 10% 50%)';

function labelFor(type: string): string {
  // 'booking_no_show' → 'Booking no show'
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function colorFor(type: string): string {
  const canonical = CANONICAL_FUNNEL.find((s) => s.type === type);
  if (canonical) return canonical.color;
  return EXTRA_EVENT_COLORS[type] ?? FALLBACK_COLOR;
}

export interface ObservedStage {
  type: string;
  label: string;
  color: string;
  count: number;
  /** Conversion from the previous shown canonical stage. null on the first. */
  stepRate: number | null;
  /** Whether this stage belongs to the canonical forward funnel. */
  canonical: boolean;
}

export interface ObservedFunnel {
  /** Canonical stages in order, including zero-count ones between non-zero stages. */
  stages: ObservedStage[];
  /** Non-canonical events observed (no order, no step rates). */
  extras: ObservedStage[];
}

/**
 * Compute a funnel from observed events. Pure aggregation — given a count
 * map, returns the funnel. Exposed for testing; production code calls
 * `getObservedFunnel`.
 */
export function computeFunnel(counts: Map<string, number>): ObservedFunnel {
  // Find first + last non-zero canonical stage so we can trim leading/
  // trailing zeros but keep middle zeros (those signal pipeline breaks).
  let firstNonZero = -1;
  let lastNonZero = -1;
  CANONICAL_FUNNEL.forEach((s, i) => {
    const c = counts.get(s.type) ?? 0;
    if (c > 0) {
      if (firstNonZero === -1) firstNonZero = i;
      lastNonZero = i;
    }
  });

  const stages: ObservedStage[] = [];
  if (firstNonZero !== -1) {
    let prevCount: number | null = null;
    for (let i = firstNonZero; i <= lastNonZero; i++) {
      const s = CANONICAL_FUNNEL[i]!;
      const count = counts.get(s.type) ?? 0;
      stages.push({
        type: s.type,
        label: s.label,
        color: s.color,
        count,
        stepRate:
          prevCount == null
            ? null
            : prevCount === 0
              ? null
              : count / prevCount,
        canonical: true,
      });
      prevCount = count;
    }
  }

  // Extras: anything that appeared at least once and isn't in the canonical
  // window we just rendered. Includes booking_no_show etc.
  const extras: ObservedStage[] = [];
  for (const [type, count] of counts) {
    if (count === 0) continue;
    if (CANONICAL_TYPES.has(type)) continue;
    extras.push({
      type,
      label: labelFor(type),
      color: colorFor(type),
      count,
      stepRate: null,
      canonical: false,
    });
  }
  extras.sort((a, b) => b.count - a.count);

  return { stages, extras };
}

/**
 * Live-data variant: pulls the event-type counts from the DB and runs
 * `computeFunnel`. The view doesn't aggregate per company-day cheaply
 * for arbitrary types, so this hits `lead_events` directly.
 */
export async function getObservedFunnel(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
  funnelKey?: string,
): Promise<ObservedFunnel> {
  let query = client
    .from('lead_events')
    .select('event_type, lead_id')
    .eq('company_id', companyId)
    .gte('occurred_at', from.toISOString())
    .lt('occurred_at', to.toISOString());
  if (funnelKey) query = query.eq('funnel_key', funnelKey);
  const { data } = await query;

  // For form_submitted / qualified we count distinct leads (a lead can
  // submit twice; we don't want that to inflate). For event-shaped
  // stages (booking_held etc.) we count rows because each booking is
  // its own opportunity.
  const distinctLeadStages = new Set(['form_submitted', 'qualified', 'disqualified']);
  const rowsByType = new Map<string, number>();
  const leadsByType = new Map<string, Set<string>>();

  for (const r of (data ?? []) as Array<{ event_type: string; lead_id: string }>) {
    rowsByType.set(r.event_type, (rowsByType.get(r.event_type) ?? 0) + 1);
    if (distinctLeadStages.has(r.event_type)) {
      let set = leadsByType.get(r.event_type);
      if (!set) {
        set = new Set();
        leadsByType.set(r.event_type, set);
      }
      set.add(r.lead_id);
    }
  }

  const counts = new Map<string, number>();
  for (const [type, count] of rowsByType) {
    counts.set(type, distinctLeadStages.has(type) ? leadsByType.get(type)!.size : count);
  }

  return computeFunnel(counts);
}

/**
 * Multi-funnel variant: same shape as `getObservedFunnel`, but grouped
 * by `lead_events.funnel_key`. Returns one ObservedFunnel per source
 * key encountered (meta, email, etc.) plus an "(unattributed)" bucket
 * for events with funnel_key IS NULL.
 *
 * Why this is the right place to slice: each event carries the funnel
 * that was active when it occurred (see apply.ts deriveFunnelKey), so a
 * lead who entered via Meta, dropped, and re-entered via Email shows
 * up in BOTH funnels' numbers — in the appropriate stages — without
 * double-counting (the same event can only have one funnel_key).
 */
export interface FunnelGroup {
  key: string;
  /** Display label — capitalised key, or '(unattributed)'. */
  label: string;
  funnel: ObservedFunnel;
  totalEvents: number;
}

export async function getObservedFunnelsBySource(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
): Promise<FunnelGroup[]> {
  const { data } = await client
    .from('lead_events')
    .select('event_type, lead_id, funnel_key')
    .eq('company_id', companyId)
    .gte('occurred_at', from.toISOString())
    .lt('occurred_at', to.toISOString());

  const distinctLeadStages = new Set(['form_submitted', 'qualified', 'disqualified']);
  // Per-key bucket: type → { rows, leads }
  const buckets = new Map<
    string,
    Map<string, { rows: number; leads: Set<string> }>
  >();

  for (const r of (data ?? []) as Array<{
    event_type: string;
    lead_id: string;
    funnel_key: string | null;
  }>) {
    const key = r.funnel_key ?? '__unattributed__';
    let typeMap = buckets.get(key);
    if (!typeMap) {
      typeMap = new Map();
      buckets.set(key, typeMap);
    }
    let cell = typeMap.get(r.event_type);
    if (!cell) {
      cell = { rows: 0, leads: new Set() };
      typeMap.set(r.event_type, cell);
    }
    cell.rows += 1;
    cell.leads.add(r.lead_id);
  }

  const groups: FunnelGroup[] = [];
  for (const [key, typeMap] of buckets) {
    const counts = new Map<string, number>();
    let total = 0;
    for (const [type, cell] of typeMap) {
      const c = distinctLeadStages.has(type) ? cell.leads.size : cell.rows;
      counts.set(type, c);
      total += cell.rows;
    }
    groups.push({
      key,
      label: key === '__unattributed__' ? '(unattributed)' : labelFor(key),
      funnel: computeFunnel(counts),
      totalEvents: total,
    });
  }

  // Sort by total event volume descending so the biggest funnel is first;
  // (unattributed) goes to the bottom regardless.
  groups.sort((a, b) => {
    if (a.key === '__unattributed__') return 1;
    if (b.key === '__unattributed__') return -1;
    return b.totalEvents - a.totalEvents;
  });

  return groups;
}

/**
 * Daily series for a given set of event types — used by the line chart
 * once stages are discovered. Returns one row per day with one column
 * per requested type.
 */
export async function getObservedFunnelDaily(
  client: Client,
  companyId: string,
  types: string[],
  from: Date,
  to: Date,
  funnelKey?: string,
): Promise<Array<Record<string, string | number>>> {
  if (types.length === 0) return [];

  let query = client
    .from('lead_events')
    .select('event_type, occurred_at')
    .eq('company_id', companyId)
    .gte('occurred_at', from.toISOString())
    .lt('occurred_at', to.toISOString())
    .in('event_type', types);
  if (funnelKey) query = query.eq('funnel_key', funnelKey);
  const { data } = await query;

  const byDay = new Map<string, Map<string, number>>();
  for (const r of (data ?? []) as Array<{ event_type: string; occurred_at: string }>) {
    const day = r.occurred_at.slice(0, 10);
    let row = byDay.get(day);
    if (!row) {
      row = new Map();
      byDay.set(day, row);
    }
    row.set(r.event_type, (row.get(r.event_type) ?? 0) + 1);
  }

  const days: string[] = [];
  const cursor = new Date(from);
  while (cursor.getTime() < to.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days.map((day) => {
    const row: Record<string, string | number> = { day };
    const counts = byDay.get(day);
    for (const t of types) row[t] = counts?.get(t) ?? 0;
    return row;
  });
}
