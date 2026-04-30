import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { KpiCard } from '@/components/kpi-card';
import { DateRangePicker } from '@/components/date-range-picker';
import {
  deltaPct,
  getFunnelTotals,
  getSpendTotals,
} from '@/lib/metrics';
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

  const [current, prior, currentSpend, priorSpend] = await Promise.all([
    getFunnelTotals(client, ctx.id, from, to),
    getFunnelTotals(client, ctx.id, prevFrom, prevTo),
    getSpendTotals(client, ctx.id, from, to),
    getSpendTotals(client, ctx.id, prevFrom, prevTo),
  ]);

  const showUp = safeDivide(
    current.bookings_held,
    current.bookings_held + current.bookings_no_show,
  );
  const showUpPrev = safeDivide(
    prior.bookings_held,
    prior.bookings_held + prior.bookings_no_show,
  );

  const formToWon = safeDivide(current.wins, current.form_submissions);
  const heldToWon = safeDivide(current.wins, current.bookings_held);
  const roas = safeDivide(current.revenue, currentSpend.spend);
  const roasPrev = safeDivide(prior.revenue, priorSpend.spend);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{range.label}</h1>
            <p className="text-sm text-muted-foreground">
              {range.fromIso} → {range.toIsoInclusive} · compared to the prior{' '}
              {range.days}-day window
            </p>
          </div>
          <DateRangePicker
            preset={range.preset}
            fromIso={range.fromIso}
            toIsoInclusive={range.toIsoInclusive}
          />
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Form submissions"
          value={formatNumber(current.form_submissions, fmt)}
          delta={deltaBadge(deltaPct(current.form_submissions, prior.form_submissions))}
        />
        <KpiCard
          label="Bookings created"
          value={formatNumber(current.bookings_created, fmt)}
          delta={deltaBadge(deltaPct(current.bookings_created, prior.bookings_created))}
          hint={`form → booking ${formatPercent(safeDivide(current.bookings_created, current.form_submissions))}`}
        />
        <KpiCard
          label="Calls held"
          value={formatNumber(current.bookings_held, fmt)}
          delta={deltaBadge(deltaPct(current.bookings_held, prior.bookings_held))}
          hint={`no-shows ${formatNumber(current.bookings_no_show, fmt)}`}
        />
        <KpiCard
          label="Show-up rate"
          value={formatPercent(showUp)}
          delta={deltaBadge(showUp != null && showUpPrev != null ? showUp - showUpPrev : null, true)}
          hint="held / (held + no-show)"
        />

        <KpiCard
          label="Qualified"
          value={formatNumber(current.qualified, fmt)}
          delta={deltaBadge(deltaPct(current.qualified, prior.qualified))}
        />
        <KpiCard
          label="Wins"
          value={formatNumber(current.wins, fmt)}
          delta={deltaBadge(deltaPct(current.wins, prior.wins))}
          hint={`held → won ${formatPercent(heldToWon)}`}
        />
        <KpiCard
          label="Revenue"
          value={formatMoney(current.revenue, fmt)}
          delta={deltaBadge(deltaPct(current.revenue, prior.revenue))}
          hint={`form → won ${formatPercent(formToWon)}`}
        />
        <KpiCard
          label="ROAS"
          value={formatRoas(roas)}
          delta={deltaBadge(roas != null && roasPrev != null ? roas - roasPrev : null, true)}
          hint={`spend ${formatMoney(currentSpend.spend, fmt)}`}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <FunnelTable totals={current} fmt={fmt} />
        <PriorPeriodTable current={current} prior={prior} fmt={fmt} />
      </section>
    </div>
  );
}

function deltaBadge(value: number | null, isAbsolute = false): { value: string; positive?: boolean } | null {
  if (value == null) return null;
  if (value === 0) return { value: '0%', positive: true };
  const positive = value > 0;
  const formatted = isAbsolute ? `${(value * 100).toFixed(1)}pp` : formatPercent(value, 1);
  return { value: positive ? `▲ ${formatted}` : `▼ ${formatted.replace('-', '')}`, positive };
}

function FunnelTable({
  totals,
  fmt,
}: {
  totals: ReturnType<typeof Object> & {
    form_submissions: number;
    bookings_created: number;
    bookings_held: number;
    qualified: number;
    wins: number;
  };
  fmt: { currency: string; locale: string };
}) {
  const stages: Array<{ label: string; value: number; rate?: number | null }> = [
    { label: 'Form submissions', value: totals.form_submissions },
    {
      label: 'Bookings created',
      value: totals.bookings_created,
      rate: safeDivide(totals.bookings_created, totals.form_submissions),
    },
    {
      label: 'Calls held',
      value: totals.bookings_held,
      rate: safeDivide(totals.bookings_held, totals.bookings_created),
    },
    {
      label: 'Qualified',
      value: totals.qualified,
      rate: safeDivide(totals.qualified, totals.bookings_held),
    },
    {
      label: 'Wins',
      value: totals.wins,
      rate: safeDivide(totals.wins, totals.qualified),
    },
  ];
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
            <tr key={s.label} className="border-t border-border">
              <td className="px-4 py-2">{s.label}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatNumber(s.value, fmt)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                {s.rate != null ? formatPercent(s.rate) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PriorPeriodTable({
  current,
  prior,
  fmt,
}: {
  current: { form_submissions: number; bookings_held: number; wins: number; revenue: number };
  prior: { form_submissions: number; bookings_held: number; wins: number; revenue: number };
  fmt: { currency: string; locale: string };
}) {
  const rows: Array<{
    label: string;
    cur: string;
    prev: string;
  }> = [
    {
      label: 'Form submissions',
      cur: formatNumber(current.form_submissions, fmt),
      prev: formatNumber(prior.form_submissions, fmt),
    },
    {
      label: 'Calls held',
      cur: formatNumber(current.bookings_held, fmt),
      prev: formatNumber(prior.bookings_held, fmt),
    },
    {
      label: 'Wins',
      cur: formatNumber(current.wins, fmt),
      prev: formatNumber(prior.wins, fmt),
    },
    {
      label: 'Revenue',
      cur: formatMoney(current.revenue, fmt),
      prev: formatMoney(prior.revenue, fmt),
    },
  ];
  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border bg-muted/30 px-4 py-2 text-sm font-medium">
        vs prior 30 days
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
