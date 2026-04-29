import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { getAdPerformance } from '@/lib/metrics';
import {
  formatMoney,
  formatNumber,
  formatRoas,
} from '@/lib/format';

export default async function AdsPage({
  params,
}: {
  params: Promise<{ company: string }>;
}) {
  const { company: slug } = await params;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id, currency')
    .eq('slug', slug)
    .single();
  if (!company) return null;

  const fmt = { currency: company.currency as string, locale: 'de-DE' };
  const rows = await getAdPerformance(client, company.id as string);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Ad performance</h1>
        <p className="text-sm text-muted-foreground">
          Sorted by spend. All-time totals; date-windowed performance lands
          in a follow-up. Attribution is via <code>fbclid</code> / utm
          params on the landing page.
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Ad</th>
              <th className="px-3 py-2 text-right">Spend</th>
              <th className="px-3 py-2 text-right">Leads</th>
              <th className="px-3 py-2 text-right">Qualified</th>
              <th className="px-3 py-2 text-right">Calls held</th>
              <th className="px-3 py-2 text-right">Wins</th>
              <th className="px-3 py-2 text-right">Revenue</th>
              <th className="px-3 py-2 text-right">ROAS</th>
              <th className="px-3 py-2 text-right">Avg purchase</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No ad spend recorded yet. Connect Meta or send ad
                  metrics via <code>/api/webhook/{slug}/meta</code>.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.ad_id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.ad_name ?? '(unnamed)'}</div>
                    <div className="text-xs text-muted-foreground">{r.ad_id}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(r.spend, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(r.leads, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(r.qualified_leads, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(r.calls_held, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatNumber(r.wins, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(r.revenue, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatRoas(r.roas)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.avg_purchase_amount != null
                      ? formatMoney(r.avg_purchase_amount, fmt)
                      : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
