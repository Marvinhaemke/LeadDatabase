import Link from 'next/link';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { getCohortTable, type CohortBucket } from '@/lib/cohorts';
import { CANONICAL_FUNNEL } from '@/lib/funnels';
import { resolveRange } from '@/lib/range';
import { DateRangePicker } from '@/components/date-range-picker';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

const TARGET_OPTIONS = CANONICAL_FUNNEL.filter(
  (s) => s.type !== 'form_submitted',
);

export default async function CohortsPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    target?: string;
    bucket?: string;
    horizon?: string;
  }>;
}) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id, currency')
    .eq('slug', slug)
    .single();
  if (!company) return null;

  const fmt = { currency: company.currency as string, locale: 'de-DE' };

  // Default to 12 weeks of cohorts (so we see ~3 months of conversion lag).
  const range = resolveRange({
    range: sp.range ?? '90d',
    from: sp.from,
    to: sp.to,
  });
  const targetKey = TARGET_OPTIONS.some((t) => t.type === sp.target)
    ? (sp.target as string)
    : 'won';
  const bucket: CohortBucket = sp.bucket === 'month' ? 'month' : 'week';
  const horizon = clampInt(sp.horizon, 7, 180, bucket === 'month' ? 120 : 56);

  const table = await getCohortTable(
    client,
    company.id as string,
    'form_submitted',
    targetKey,
    range.from,
    range.to,
    bucket,
    horizon,
  );

  const targetLabel =
    TARGET_OPTIONS.find((t) => t.type === targetKey)?.label ?? targetKey;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">
              Cohorts — form_submitted → {targetLabel}
            </h1>
            <p className="text-sm text-muted-foreground">
              Of leads acquired in each {bucket}, the % who had reached{' '}
              <code className="rounded bg-muted px-1">{targetKey}</code> by{' '}
              N {bucket === 'month' ? 'months' : 'weeks'} later. Cells marked
              "—" haven't accrued enough elapsed time to be meaningful.
            </p>
          </div>
          <DateRangePicker
            preset={range.preset}
            fromIso={range.fromIso}
            toIsoInclusive={range.toIsoInclusive}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">Target stage:</span>
          {TARGET_OPTIONS.map((opt) => (
            <Link
              key={opt.type}
              href={buildHref(slug, sp, { target: opt.type })}
              className={cn(
                'rounded-md border px-2 py-1',
                opt.type === targetKey
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {opt.label}
            </Link>
          ))}
          <span className="ml-3 text-muted-foreground">Bucket:</span>
          {(['week', 'month'] as const).map((b) => (
            <Link
              key={b}
              href={buildHref(slug, sp, { bucket: b })}
              className={cn(
                'rounded-md border px-2 py-1',
                b === bucket
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {b}
            </Link>
          ))}
        </div>
      </header>

      {table.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No <code className="rounded bg-muted px-1">form_submitted</code>{' '}
          events in this window. Widen the range or run{' '}
          <code className="rounded bg-muted px-1">pnpm seed:demo</code>.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left whitespace-nowrap">Cohort</th>
                <th className="px-3 py-2 text-right">Size</th>
                {table.columns.map((c) => (
                  <th key={c} className="px-3 py-2 text-right whitespace-nowrap">
                    {bucket === 'month'
                      ? c === 0
                        ? 'M0'
                        : `M${Math.round(c / 30)}`
                      : c === 0
                        ? 'W0'
                        : `W${Math.round(c / 7)}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.cohortStart} className="border-t border-border">
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                    {formatDate(row.cohortStart, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(row.cohortSize, fmt)}
                  </td>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.daysSince}
                      className="px-3 py-2 text-right tabular-nums"
                      style={
                        cell.rate != null
                          ? { background: cellBackground(cell.rate) }
                          : undefined
                      }
                      title={
                        cell.rate != null
                          ? `${cell.converted}/${row.cohortSize} converted within ${cell.daysSince} days`
                          : `Not enough elapsed time for day ${cell.daysSince}`
                      }
                    >
                      {cell.rate != null ? formatPercent(cell.rate, 0) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Color intensity scales with conversion rate. Hover a cell for the
        raw count.
      </p>
    </div>
  );
}

/**
 * Build a heatmap-friendly background for a rate in [0, 1].
 * Low = transparent, mid = pale green, high = saturated green.
 */
function cellBackground(rate: number): string {
  if (rate <= 0) return 'transparent';
  const intensity = Math.min(1, rate * 2.5); // visually compress so 40% reads as fairly strong
  return `hsl(150 60% 90% / ${intensity})`;
}

function clampInt(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function buildHref(
  slug: string,
  current: { range?: string; from?: string; to?: string; target?: string; bucket?: string; horizon?: string },
  patch: { target?: string; bucket?: string },
): string {
  const sp = new URLSearchParams();
  const target = patch.target ?? current.target;
  const bucket = patch.bucket ?? current.bucket;
  if (current.range) sp.set('range', current.range);
  if (current.from) sp.set('from', current.from);
  if (current.to) sp.set('to', current.to);
  if (target) sp.set('target', target);
  if (bucket) sp.set('bucket', bucket);
  if (current.horizon) sp.set('horizon', current.horizon);
  const qs = sp.toString();
  return `/${slug}/cohorts${qs ? `?${qs}` : ''}`;
}
