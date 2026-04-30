import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { getFunnelDaily, getShowUpDaily } from '@/lib/metrics';
import { resolveRange } from '@/lib/range';
import { DateRangePicker } from '@/components/date-range-picker';
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  safeDivide,
} from '@/lib/format';

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

  // Funnel default is 90d so weekly trends are visible; user can narrow.
  const range = resolveRange({ range: sp.range ?? '90d', from: sp.from, to: sp.to });
  const { from, to } = range;
  const [daily, showUp] = await Promise.all([
    getFunnelDaily(client, ctx.id, from, to),
    getShowUpDaily(client, ctx.id, from, to),
  ]);

  const showUpByDay = new Map(showUp.map((r) => [r.day, r]));

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Funnel — {range.label}</h1>
            <p className="text-sm text-muted-foreground">
              {range.fromIso} → {range.toIsoInclusive} · each row is one
              calendar day. Show-up rate is bucketed by the booking&apos;s
              scheduled date (see <code>docs/funnel-semantics.md</code>).
            </p>
          </div>
          <DateRangePicker
            preset={range.preset}
            fromIso={range.fromIso}
            toIsoInclusive={range.toIsoInclusive}
          />
        </div>
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Day</th>
              <th className="px-3 py-2 text-right">Forms</th>
              <th className="px-3 py-2 text-right">Booked</th>
              <th className="px-3 py-2 text-right">Held</th>
              <th className="px-3 py-2 text-right">No-show</th>
              <th className="px-3 py-2 text-right">Show-up</th>
              <th className="px-3 py-2 text-right">Qualified</th>
              <th className="px-3 py-2 text-right">Wins</th>
              <th className="px-3 py-2 text-right">Revenue</th>
              <th className="px-3 py-2 text-right">Form→Booked</th>
              <th className="px-3 py-2 text-right">Form→Won</th>
            </tr>
          </thead>
          <tbody>
            {daily.length === 0 ? (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No funnel events in this window yet.
                </td>
              </tr>
            ) : (
              daily.map((row) => {
                const su = showUpByDay.get(row.day);
                return (
                  <tr key={row.day} className="border-t border-border">
                    <td className="px-3 py-2">{formatDate(row.day, fmt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(row.form_submissions, fmt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(row.bookings_created, fmt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(row.bookings_held, fmt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(row.bookings_no_show, fmt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {su ? formatPercent(su.show_up_rate) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(row.qualified, fmt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(row.wins, fmt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(row.revenue, fmt)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatPercent(
                        safeDivide(row.bookings_created, row.form_submissions),
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatPercent(
                        safeDivide(row.wins, row.form_submissions),
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
