import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { getShowUpDaily } from '@/lib/metrics';
import {
  getObservedFunnel,
  getObservedFunnelDaily,
} from '@/lib/funnels';
import { resolveRange } from '@/lib/range';
import { DateRangePicker } from '@/components/date-range-picker';
import { LineChart } from '@/components/line-chart';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';

export default async function FunnelPage({
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

  const ctx = { id: company.id as string, currency: company.currency as string };
  const fmt = { currency: ctx.currency, locale: 'de-DE' };

  // Funnel default is 90d so weekly trends are visible.
  const range = resolveRange({ range: sp.range ?? '90d', from: sp.from, to: sp.to });
  const { from, to } = range;

  const [funnel, showUp] = await Promise.all([
    getObservedFunnel(client, ctx.id, from, to),
    getShowUpDaily(client, ctx.id, from, to),
  ]);

  // Chart series: visible canonical stages.
  const seriesTypes = funnel.stages.map((s) => s.type);
  const dailyRows =
    seriesTypes.length === 0
      ? []
      : await getObservedFunnelDaily(client, ctx.id, seriesTypes, from, to);

  const chartSeries = funnel.stages.map((s) => ({
    key: s.type,
    label: s.label,
    color: s.color,
  }));

  // Day-bucketed table — joins funnel daily with show_up_rate_daily.
  const showUpByDay = new Map(showUp.map((r) => [r.day, r]));
  const tableRows = [...dailyRows].sort((a, b) =>
    String(b.day).localeCompare(String(a.day)),
  );

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Funnel — {range.label}</h1>
            <p className="text-sm text-muted-foreground">
              {range.fromIso} → {range.toIsoInclusive} · shape discovered
              from <code className="rounded bg-muted px-1">lead_events</code>{' '}
              in this window.
            </p>
          </div>
          <DateRangePicker
            preset={range.preset}
            fromIso={range.fromIso}
            toIsoInclusive={range.toIsoInclusive}
          />
        </div>
      </header>

      {funnel.stages.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          No funnel events recorded in this window yet. Send a webhook to
          <code className="mx-1 rounded bg-muted px-1">
            /api/webhook/{slug}/zapier
          </code>
          or widen the date range.
        </div>
      ) : (
        <>
          <LineChart data={dailyRows as Array<Record<string, string | number> & { day: string }>}
            series={chartSeries}
          />

          <section className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {funnel.stages.map((s) => (
              <div key={s.type} className="rounded-lg border border-border p-4">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-3 rounded-sm"
                    style={{ background: s.color }}
                  />
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {s.label}
                  </div>
                </div>
                <div className="mt-2 text-2xl font-semibold tabular-nums">
                  {formatNumber(s.count, fmt)}
                </div>
                {s.stepRate != null && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatPercent(s.stepRate)} of previous stage
                  </div>
                )}
              </div>
            ))}
          </section>

          {funnel.extras.length > 0 && (
            <section>
              <h2 className="text-base font-semibold">Other events observed</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Events outside the canonical forward funnel (no-shows,
                disqualifications, custom event types).
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {funnel.extras.map((s) => (
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
                  </span>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-base font-semibold">Daily breakdown</h2>
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Day</th>
                    {funnel.stages.map((s) => (
                      <th
                        key={s.type}
                        className="px-3 py-2 text-right whitespace-nowrap"
                      >
                        {s.label}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right">Show-up</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={funnel.stages.length + 2}
                        className="px-3 py-6 text-center text-muted-foreground"
                      >
                        No daily breakdown for this window.
                      </td>
                    </tr>
                  ) : (
                    tableRows.map((row) => {
                      const day = String(row.day);
                      const su = showUpByDay.get(day);
                      return (
                        <tr key={day} className="border-t border-border">
                          <td className="px-3 py-2 whitespace-nowrap">
                            {formatDate(day, fmt)}
                          </td>
                          {funnel.stages.map((s) => (
                            <td
                              key={s.type}
                              className="px-3 py-2 text-right tabular-nums"
                            >
                              {formatNumber(Number(row[s.type] ?? 0), fmt)}
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {su ? formatPercent(su.show_up_rate) : '—'}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
