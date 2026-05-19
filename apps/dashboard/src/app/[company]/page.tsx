import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { KpiCard } from '@/components/kpi-card';
import { DateRangePicker } from '@/components/date-range-picker';
import {
  deltaPct,
  getFunnelTotals,
  getShowUpDaily,
  getSpendTotals,
} from '@/lib/metrics';
import {
  getObservedFunnel,
  getObservedFunnelDaily,
  type ObservedStage,
} from '@/lib/funnels';
import { resolveRange } from '@/lib/range';
import {
  formatMoney,
  formatNumber,
  formatPercent,
  formatRoas,
  safeDivide,
} from '@/lib/format';

interface CompanyContext {
  id: string;
  currency: string;
  locale: string;
}

export default async function CompanyOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id, currency, timezone')
    .eq('slug', slug)
    .single();
  if (!company) return null;

  const ctx: CompanyContext = {
    id: company.id as string,
    currency: company.currency as string,
    locale: 'de-DE',
  };
  const fmt = { currency: ctx.currency, locale: ctx.locale };

  const range = resolveRange(sp);
  const { from, to, prevFrom, prevTo } = range;

  // Current + prior in parallel. The observed funnel adapts the stage
  // cards to the company's actual shape; the derived metrics (show-up,
  // ROAS, revenue, spend) always render.
  const [
    currFunnel,
    priorFunnel,
    currSpend,
    priorSpend,
    showUpRows,
    priorShowUpRows,
    currTotals,
    priorTotals,
  ] = await Promise.all([
    getObservedFunnel(client, ctx.id, from, to),
    getObservedFunnel(client, ctx.id, prevFrom, prevTo),
    getSpendTotals(client, ctx.id, from, to),
    getSpendTotals(client, ctx.id, prevFrom, prevTo),
    getShowUpDaily(client, ctx.id, from, to),
    getShowUpDaily(client, ctx.id, prevFrom, prevTo),
    getFunnelTotals(client, ctx.id, from, to),
    getFunnelTotals(client, ctx.id, prevFrom, prevTo),
  ]);

  // Build prior-counts lookup for delta badges on stage cards.
  const priorCountByType = new Map<string, number>();
  for (const s of [...priorFunnel.stages, ...priorFunnel.extras]) {
    priorCountByType.set(s.type, s.count);
  }

  // Sparkline data per observed stage.
  const observedTypes = [
    ...currFunnel.stages.map((s) => s.type),
    ...currFunnel.extras.map((s) => s.type),
  ];
  const daily =
    observedTypes.length === 0
      ? []
      : await getObservedFunnelDaily(client, ctx.id, observedTypes, from, to);
  const sparkByType = new Map<string, number[]>();
  for (const t of observedTypes) {
    sparkByType.set(
      t,
      daily.map((row) => Number(row[t] ?? 0)),
    );
  }

  // Derived metrics
  const held = showUpRows.reduce((n, r) => n + Number(r.held ?? 0), 0);
  const noShow = showUpRows.reduce((n, r) => n + Number(r.no_show ?? 0), 0);
  const showUp = safeDivide(held, held + noShow);

  const priorHeld = priorShowUpRows.reduce((n, r) => n + Number(r.held ?? 0), 0);
  const priorNoShow = priorShowUpRows.reduce((n, r) => n + Number(r.no_show ?? 0), 0);
  const priorShowUp = safeDivide(priorHeld, priorHeld + priorNoShow);

  const roas = safeDivide(currTotals.revenue, currSpend.spend);
  const priorRoas = safeDivide(priorTotals.revenue, priorSpend.spend);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{range.label}</h1>
            <p className="text-sm text-muted-foreground">
              {range.fromIso} → {range.toIsoInclusive} · compared to the prior{' '}
              {range.days}-day window. Stage cards reflect the funnel shape
              observed in this window.
            </p>
          </div>
          <DateRangePicker
            preset={range.preset}
            fromIso={range.fromIso}
            toIsoInclusive={range.toIsoInclusive}
          />
        </div>
      </header>

      {currFunnel.stages.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No funnel events recorded in this window yet. Run{' '}
          <code className="rounded bg-muted px-1">pnpm seed:demo</code> for
          synthetic data, or send a webhook to{' '}
          <code className="rounded bg-muted px-1">
            /api/webhook/{slug}/zapier
          </code>
          .
        </div>
      ) : (
        <section>
          <h2 className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
            Funnel stages
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {currFunnel.stages.map((s) => (
              <KpiCard
                key={s.type}
                label={s.label}
                value={formatNumber(s.count, fmt)}
                spark={sparkByType.get(s.type)}
                delta={deltaBadge(deltaPct(s.count, priorCountByType.get(s.type) ?? 0))}
                hint={
                  s.stepRate != null
                    ? `${formatPercent(s.stepRate)} of previous stage`
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
          Derived metrics
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Show-up rate"
            value={formatPercent(showUp)}
            delta={deltaBadge(
              showUp != null && priorShowUp != null ? showUp - priorShowUp : null,
              true,
            )}
            hint="held / (held + no-show)"
          />
          <KpiCard
            label="ROAS"
            value={formatRoas(roas)}
            delta={deltaBadge(
              roas != null && priorRoas != null ? roas - priorRoas : null,
              true,
            )}
            hint="revenue / spend"
          />
          <KpiCard
            label="Revenue"
            value={formatMoney(currTotals.revenue, fmt)}
            delta={deltaBadge(deltaPct(currTotals.revenue, priorTotals.revenue))}
            hint={
              currFunnel.stages.length > 0
                ? `${formatPercent(safeDivide(currTotals.wins, currTotals.form_submissions))} form → won`
                : undefined
            }
          />
          <KpiCard
            label="Ad spend"
            value={formatMoney(currSpend.spend, fmt)}
            delta={deltaBadge(deltaPct(currSpend.spend, priorSpend.spend))}
            hint={`${formatNumber(currSpend.clicks, fmt)} clicks`}
          />
        </div>
      </section>

      {currFunnel.extras.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Other events observed
          </h2>
          <div className="flex flex-wrap gap-2">
            {currFunnel.extras.map((s) => {
              const prior = priorCountByType.get(s.type) ?? 0;
              const dp = deltaPct(s.count, prior);
              return (
                <span
                  key={s.type}
                  className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: s.color }}
                  />
                  <span className="font-mono">{s.type}</span>
                  <span className="tabular-nums">{formatNumber(s.count, fmt)}</span>
                  {dp != null && (
                    <span
                      className={
                        dp >= 0 ? 'text-emerald-700' : 'text-red-700'
                      }
                    >
                      {dp >= 0 ? '▲' : '▼'} {formatPercent(Math.abs(dp), 0)}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </section>
      )}

      {currFunnel.stages.length > 0 && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <AdaptiveFunnelTable stages={currFunnel.stages} fmt={fmt} />
          <PriorPeriodTable
            stages={currFunnel.stages}
            priorCountByType={priorCountByType}
            currRevenue={currTotals.revenue}
            priorRevenue={priorTotals.revenue}
            fmt={fmt}
          />
        </section>
      )}
    </div>
  );
}

function deltaBadge(
  value: number | null,
  isAbsolute = false,
): { value: string; positive?: boolean } | null {
  if (value == null) return null;
  if (value === 0) return { value: '0%', positive: true };
  const positive = value > 0;
  const formatted = isAbsolute
    ? `${(value * 100).toFixed(1)}pp`
    : formatPercent(value, 1);
  return {
    value: positive ? `▲ ${formatted}` : `▼ ${formatted.replace('-', '')}`,
    positive,
  };
}

function AdaptiveFunnelTable({
  stages,
  fmt,
}: {
  stages: ObservedStage[];
  fmt: { currency: string; locale: string };
}) {
  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border bg-muted/30 px-4 py-2 text-sm font-medium">
        Funnel
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left">Stage</th>
            <th className="px-4 py-2 text-right">Count</th>
            <th className="px-4 py-2 text-right">Step rate</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => (
            <tr key={s.type} className="border-t border-border">
              <td className="px-4 py-2">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-3 rounded-sm"
                    style={{ background: s.color }}
                  />
                  {s.label}
                </span>
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatNumber(s.count, fmt)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                {s.stepRate != null ? formatPercent(s.stepRate) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PriorPeriodTable({
  stages,
  priorCountByType,
  currRevenue,
  priorRevenue,
  fmt,
}: {
  stages: ObservedStage[];
  priorCountByType: Map<string, number>;
  currRevenue: number;
  priorRevenue: number;
  fmt: { currency: string; locale: string };
}) {
  const rows: Array<{ label: string; cur: string; prev: string }> = [
    ...stages.map((s) => ({
      label: s.label,
      cur: formatNumber(s.count, fmt),
      prev: formatNumber(priorCountByType.get(s.type) ?? 0, fmt),
    })),
    {
      label: 'Revenue',
      cur: formatMoney(currRevenue, fmt),
      prev: formatMoney(priorRevenue, fmt),
    },
  ];
  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border bg-muted/30 px-4 py-2 text-sm font-medium">
        vs prior period
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left">Metric</th>
            <th className="px-4 py-2 text-right">Current</th>
            <th className="px-4 py-2 text-right">Prior</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border">
              <td className="px-4 py-2">{r.label}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.cur}</td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                {r.prev}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
