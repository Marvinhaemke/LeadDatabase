/**
 * URL-driven date range. The contract:
 *
 *   ?range=<preset>          → preset window ending today (UTC)
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   → custom (inclusive `to`, inclusive `from`)
 *   no params                → defaults to '30d'
 *
 * Internally the resolver returns an exclusive `to` so SQL `<` comparisons
 * line up with calendar-day boundaries. The "previous period" window is
 * the same length immediately before `from`, regardless of preset — that
 * gives consistent vs-prior comparisons even for variable-length presets
 * like MTD / YTD.
 */

export type RangePreset = '7d' | '30d' | '90d' | 'mtd' | 'ytd' | 'custom';

export interface PresetMeta {
  key: RangePreset;
  label: string;
  short: string;
}

export const PRESETS: PresetMeta[] = [
  { key: '7d', label: 'Last 7 days', short: '7d' },
  { key: '30d', label: 'Last 30 days', short: '30d' },
  { key: '90d', label: 'Last 90 days', short: '90d' },
  { key: 'mtd', label: 'Month to date', short: 'MTD' },
  { key: 'ytd', label: 'Year to date', short: 'YTD' },
];

export interface RangeSearchParams {
  range?: string;
  from?: string;
  to?: string;
}

export interface ResolvedRange {
  preset: RangePreset;
  /** Inclusive lower bound (UTC midnight). */
  from: Date;
  /** Exclusive upper bound (UTC midnight of the day after the last included day). */
  to: Date;
  /** Same-length window immediately before `from`, exclusive of `from`. */
  prevFrom: Date;
  prevTo: Date;
  /** ISO-date string of `from` (YYYY-MM-DD). */
  fromIso: string;
  /** ISO-date string of the *last included* day (YYYY-MM-DD). */
  toIsoInclusive: string;
  /** Length of the window in whole days. */
  days: number;
  label: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveRange(params: RangeSearchParams = {}): ResolvedRange {
  // Custom range wins when both bounds are valid.
  if (
    params.from &&
    params.to &&
    ISO_DATE_RE.test(params.from) &&
    ISO_DATE_RE.test(params.to)
  ) {
    const from = parseDate(params.from);
    const lastDay = parseDate(params.to);
    if (from && lastDay && lastDay.getTime() >= from.getTime()) {
      const exclTo = addDays(lastDay, 1);
      return finalize('custom', from, exclTo, `${params.from} → ${params.to}`);
    }
  }

  const preset = (params.range as RangePreset) ?? '30d';
  const today = todayUtc();
  const exclTo = addDays(today, 1);

  switch (preset) {
    case '7d':
      return finalize('7d', addDays(exclTo, -7), exclTo, 'Last 7 days');
    case '90d':
      return finalize('90d', addDays(exclTo, -90), exclTo, 'Last 90 days');
    case 'mtd': {
      const from = utcDate(today.getUTCFullYear(), today.getUTCMonth(), 1);
      return finalize('mtd', from, exclTo, 'Month to date');
    }
    case 'ytd': {
      const from = utcDate(today.getUTCFullYear(), 0, 1);
      return finalize('ytd', from, exclTo, 'Year to date');
    }
    case '30d':
    default:
      return finalize('30d', addDays(exclTo, -30), exclTo, 'Last 30 days');
  }
}

function finalize(
  preset: RangePreset,
  from: Date,
  to: Date,
  label: string,
): ResolvedRange {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
  const lastIncluded = addDays(to, -1);
  const prevTo = from;
  const prevFrom = addDays(from, -days);
  return {
    preset,
    from,
    to,
    prevFrom,
    prevTo,
    fromIso: isoDate(from),
    toIsoInclusive: isoDate(lastIncluded),
    days,
    label,
  };
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function parseDate(s: string): Date | null {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return isoDate(d) === s ? d : null;
}

/**
 * Build the URL search-params string for a preset (used by the picker).
 */
export function buildPresetQuery(preset: RangePreset): string {
  if (preset === 'custom') return '';
  const sp = new URLSearchParams();
  sp.set('range', preset);
  return sp.toString();
}
