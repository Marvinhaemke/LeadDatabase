/**
 * Display formatters. The dashboard's currency / locale come from the
 * company row; defaults are sensible for the demo seed (EUR / de-DE).
 */

export interface FormatContext {
  currency: string;
  locale: string;
}

export const DEFAULT_FORMAT: FormatContext = {
  currency: 'EUR',
  locale: 'de-DE',
};

export function formatNumber(value: number | null | undefined, ctx = DEFAULT_FORMAT): string {
  if (value == null) return '—';
  return new Intl.NumberFormat(ctx.locale).format(value);
}

export function formatMoney(value: number | null | undefined, ctx = DEFAULT_FORMAT): string {
  if (value == null) return '—';
  return new Intl.NumberFormat(ctx.locale, {
    style: 'currency',
    currency: ctx.currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  if (value == null) return '—';
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

export function formatRoas(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toFixed(2)}×`;
}

export function formatDate(value: string | null | undefined, ctx = DEFAULT_FORMAT): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(ctx.locale, { dateStyle: 'medium' }).format(d);
}

export function formatDateTime(value: string | null | undefined, ctx = DEFAULT_FORMAT): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(ctx.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

export function safeDivide(num: number, denom: number): number | null {
  return denom > 0 ? num / denom : null;
}
