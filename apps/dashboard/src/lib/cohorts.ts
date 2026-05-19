/**
 * Cohort analysis.
 *
 * Given an entry event (typically `form_submitted`) and a target event
 * (typically `won`), build the classic cohort table:
 *
 *   ┌────────────────┬─────┬───────┬───────┬───────┬───────┐
 *   │ Cohort (week)  │  N  │  D0   │  D7   │  D14  │  D21  │
 *   ├────────────────┼─────┼───────┼───────┼───────┼───────┤
 *   │ Apr 6 – 12     │ 100 │  0%   │  4%   │  9%   │  12%  │
 *   │ Apr 13 – 19    │  87 │  0%   │  6%   │  10%  │  TBD  │
 *   │ Apr 20 – 26    │  92 │  0%   │  TBD  │  TBD  │  TBD  │
 *   └────────────────┴─────┴───────┴───────┴───────┴───────┘
 *
 * "TBD" cells haven't accrued enough elapsed time for the answer to be
 * meaningful — distinct from "0% converted by then". The dashboard
 * renders them differently.
 *
 * All aggregation is pure JS in `computeCohorts`. The DB-backed entry
 * point (`getCohortTable`) just runs two `.from('lead_events')` calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'db/types';

type Client = SupabaseClient<Database>;

export type CohortBucket = 'week' | 'month';

export interface CohortCell {
  /** Column offset from cohort start, in days. */
  daysSince: number;
  /** Cumulative count of cohort leads that reached the target stage by this point. */
  converted: number | null;
  /** converted / cohortSize. null = TBD (not enough elapsed time). */
  rate: number | null;
}

export interface CohortRow {
  /** ISO date of the cohort bucket's start (Monday for weekly, 1st for monthly). */
  cohortStart: string;
  /** Number of leads in this cohort. */
  cohortSize: number;
  cells: CohortCell[];
}

export interface CohortTable {
  rows: CohortRow[];
  /** Column offsets in days (e.g. [0, 7, 14, 21, 28]). */
  columns: number[];
  entryEvent: string;
  targetEvent: string;
  bucket: CohortBucket;
}

interface ComputeArgs {
  /** Per-lead entry timestamp. */
  entries: Map<string, Date>;
  /** Per-lead first time the target stage was reached. */
  targets: Map<string, Date>;
  bucket: CohortBucket;
  /** Days from cohort start at which to evaluate conversion. */
  columns: number[];
  /** "Now" for TBD-cell determination — injectable for tests. */
  now?: Date;
}

/**
 * Pure aggregator. Buckets entry timestamps, computes per-cohort
 * conversion at each column offset, marks TBD cells. Exposed for tests.
 */
export function computeCohorts(args: ComputeArgs): CohortRow[] {
  const now = args.now ?? new Date();
  // Group leads by their cohort bucket start.
  const cohortBuckets = new Map<string, Array<{ leadId: string; entryAt: Date }>>();
  for (const [leadId, entryAt] of args.entries) {
    const bucketStart = bucketStartOf(entryAt, args.bucket);
    const key = isoDate(bucketStart);
    let arr = cohortBuckets.get(key);
    if (!arr) {
      arr = [];
      cohortBuckets.set(key, arr);
    }
    arr.push({ leadId, entryAt });
  }

  // Sort buckets ascending so the UI renders oldest at top, newest at bottom.
  const sortedBuckets = [...cohortBuckets.entries()].sort(([a], [b]) => a.localeCompare(b));

  const rows: CohortRow[] = sortedBuckets.map(([bucketStartIso, leads]) => {
    const bucketStart = new Date(`${bucketStartIso}T00:00:00Z`);
    const cohortSize = leads.length;

    // For each lead, compute days-to-target relative to their OWN entry
    // (not the bucket start). Captures within-bucket variance.
    const daysToTarget: number[] = [];
    for (const { leadId, entryAt } of leads) {
      const targetAt = args.targets.get(leadId);
      if (!targetAt) continue;
      const delta = (targetAt.getTime() - entryAt.getTime()) / (24 * 60 * 60 * 1000);
      if (delta >= 0) daysToTarget.push(delta);
    }
    daysToTarget.sort((a, b) => a - b);

    // Cells: for each column offset C, count how many days-to-target ≤ C.
    const elapsedDays = (now.getTime() - bucketStart.getTime()) / (24 * 60 * 60 * 1000);

    const cells: CohortCell[] = args.columns.map((col) => {
      // Cell is TBD when the cohort hasn't been alive long enough — i.e.
      // the youngest lead in the bucket has had fewer than `col` days to
      // convert. Use bucketStart as the lower bound on lead age (leads
      // entering later in the bucket have even less time, but for the
      // cell to be MEANINGFUL we need the whole bucket to have lived
      // `col` days).
      const bucketEnd = bucketEndOf(bucketStart, args.bucket);
      const youngestAge = (now.getTime() - bucketEnd.getTime()) / (24 * 60 * 60 * 1000);
      if (youngestAge < col) {
        return { daysSince: col, converted: null, rate: null };
      }
      // Count converted-by-col via binary-search-style upper bound.
      let lo = 0;
      let hi = daysToTarget.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (daysToTarget[mid]! <= col) lo = mid + 1;
        else hi = mid;
      }
      const converted = lo;
      return { daysSince: col, converted, rate: cohortSize > 0 ? converted / cohortSize : null };
    });

    return { cohortStart: bucketStartIso, cohortSize, cells };
  });

  return rows;
}

/**
 * Live-data variant. Two queries (entry events for leads first-seen in
 * the range, then ALL target events for those leads regardless of when)
 * + the pure aggregator above.
 */
export async function getCohortTable(
  client: Client,
  companyId: string,
  entryEvent: string,
  targetEvent: string,
  since: Date,
  until: Date,
  bucket: CohortBucket = 'week',
  horizonDays = 60,
): Promise<CohortTable> {
  const columns = buildColumns(bucket, horizonDays);

  // 1. Entry events in window — used to assign cohort membership.
  const { data: entryRows } = await client
    .from('lead_events')
    .select('lead_id, occurred_at')
    .eq('company_id', companyId)
    .eq('event_type', entryEvent)
    .gte('occurred_at', since.toISOString())
    .lt('occurred_at', until.toISOString())
    .order('occurred_at', { ascending: true });

  const entries = new Map<string, Date>();
  for (const r of (entryRows ?? []) as Array<{ lead_id: string; occurred_at: string }>) {
    const t = new Date(r.occurred_at);
    const existing = entries.get(r.lead_id);
    if (!existing || t < existing) entries.set(r.lead_id, t);
  }

  if (entries.size === 0) {
    return { rows: [], columns, entryEvent, targetEvent, bucket };
  }

  // 2. Target events for cohort leads (no upper bound on date — a cohort
  //    from May should still pick up wins in November).
  const leadIds = [...entries.keys()];
  const targets = new Map<string, Date>();
  // PostgREST `.in()` is limited to ~2000 ids per call; chunk to be safe.
  for (const chunk of chunked(leadIds, 1000)) {
    const { data: targetRows } = await client
      .from('lead_events')
      .select('lead_id, occurred_at')
      .eq('company_id', companyId)
      .eq('event_type', targetEvent)
      .in('lead_id', chunk);
    for (const r of (targetRows ?? []) as Array<{ lead_id: string; occurred_at: string }>) {
      const t = new Date(r.occurred_at);
      const existing = targets.get(r.lead_id);
      if (!existing || t < existing) targets.set(r.lead_id, t);
    }
  }

  return {
    rows: computeCohorts({ entries, targets, bucket, columns }),
    columns,
    entryEvent,
    targetEvent,
    bucket,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildColumns(bucket: CohortBucket, horizonDays: number): number[] {
  const step = bucket === 'week' ? 7 : 30;
  const cols: number[] = [];
  for (let d = 0; d <= horizonDays; d += step) cols.push(d);
  return cols;
}

function bucketStartOf(d: Date, bucket: CohortBucket): Date {
  if (bucket === 'month') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
  // ISO weeks: Monday is the first day of the week.
  // d.getUTCDay() returns 0=Sun..6=Sat. Days back to Monday = (day + 6) % 7.
  const day = d.getUTCDay();
  const back = (day + 6) % 7;
  const start = new Date(d);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - back);
  return start;
}

function bucketEndOf(start: Date, bucket: CohortBucket): Date {
  if (bucket === 'month') {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return end;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
