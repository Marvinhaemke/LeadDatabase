import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import {
  getFunnelEconomics,
  getFunnelRevenueLines,
  getFunnelSpendBreakdown,
  type RevenueLineRow,
  type SpendAllocationRow,
} from '@/lib/metrics';
import { resolveRange } from '@/lib/range';
import { DateRangePicker } from '@/components/date-range-picker';
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRoas,
} from '@/lib/format';

type Metric = 'roas' | 'revenue' | 'spend';

const METRIC_LABELS: Record<Metric, string> = {
  roas: 'ROAS',
  revenue: 'Revenue',
  spend: 'Spend (allocated)',
};

function isMetric(value: string): value is Metric {
  return value === 'roas' || value === 'revenue' || value === 'spend';
}

export default async function ExplainPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string; id: string; metric: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const { company: slug, id, metric: metricParam } = await params;
  const sp = await searchParams;
  if (!isMetric(metricParam)) notFound();
  const metric: Metric = metricParam;

  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id, currency')
    .eq('slug', slug)
    .single();
  if (!company) notFound();

  const { data: funnel } = await client
    .from('funnel_definitions')
    .select('id, key, label')
    .eq('id', id)
    .eq('company_id', company.id as string)
    .maybeSingle();
  if (!funnel) notFound();

  const fmt = { currency: company.currency as string, locale: 'de-DE' };
  const range = resolveRange({ range: sp.range ?? '90d', from: sp.from, to: sp.to });

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link href={`/${slug}/funnels/${id}`} className="hover:text-foreground">
          ← {funnel.label as string}
        </Link>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Explain: {METRIC_LABELS[metric]}
          </h1>
          <p className="text-sm text-muted-foreground">
            <code className="rounded bg-muted px-1">funnel_key = {funnel.key}</code>{' '}
            · {range.fromIso} → {range.toIsoInclusive}
          </p>
        </div>
        <DateRangePicker
          preset={range.preset}
          fromIso={range.fromIso}
          toIsoInclusive={range.toIsoInclusive}
        />
      </header>

      {metric === 'roas' && (
        <RoasExplain
          slug={slug}
          id={id}
          companyId={company.id as string}
          funnelKey={funnel.key as string}
          from={range.from}
          to={range.to}
          fmt={fmt}
          sp={sp}
        />
      )}
      {metric === 'revenue' && (
        <RevenueExplain
          slug={slug}
          companyId={company.id as string}
          funnelKey={funnel.key as string}
          from={range.from}
          to={range.to}
          fmt={fmt}
        />
      )}
      {metric === 'spend' && (
        <SpendExplain
          companyId={company.id as string}
          funnelKey={funnel.key as string}
          from={range.from}
          to={range.to}
          fmt={fmt}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROAS
// ---------------------------------------------------------------------------

async function RoasExplain({
  slug,
  id,
  companyId,
  funnelKey,
  from,
  to,
  fmt,
  sp,
}: {
  slug: string;
  id: string;
  companyId: string;
  funnelKey: string;
  from: Date;
  to: Date;
  fmt: { currency: string; locale: string };
  sp: { range?: string; from?: string; to?: string };
}) {
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);
  const econ = await getFunnelEconomics(client, companyId, from, to, funnelKey);

  const qs = (() => {
    const s = new URLSearchParams();
    if (sp.range) s.set('range', sp.range);
    if (sp.from) s.set('from', sp.from);
    if (sp.to) s.set('to', sp.to);
    return s.toString();
  })();

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-border p-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Formula
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-3 font-mono text-lg">
          <span className="font-semibold">ROAS</span>
          <span className="text-muted-foreground">=</span>
          <Link
            href={`/${slug}/funnels/${id}/explain/revenue${qs ? `?${qs}` : ''}`}
            className="underline decoration-dotted underline-offset-4 hover:no-underline"
          >
            Revenue {formatMoney(econ.revenue, fmt)}
          </Link>
          <span className="text-muted-foreground">÷</span>
          <Link
            href={`/${slug}/funnels/${id}/explain/spend${qs ? `?${qs}` : ''}`}
            className="underline decoration-dotted underline-offset-4 hover:no-underline"
          >
            Spend {formatMoney(econ.spend, fmt)}
          </Link>
          <span className="text-muted-foreground">=</span>
          <span className="font-semibold">{formatRoas(econ.roas)}</span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Click either operand to see the rows that compose it. Spend is
          ad-spend allocated to this funnel by event share; revenue is the
          sum of <code className="rounded bg-muted px-1">won</code> event
          amounts tagged with this funnel.
        </p>
      </div>

      {econ.spend === 0 && (
        <Banner tone="muted">
          No allocated ad spend in this window — ROAS is undefined. Either no
          ads are running, or no leads in this funnel are attributed to an ad.
        </Banner>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

async function RevenueExplain({
  slug,
  companyId,
  funnelKey,
  from,
  to,
  fmt,
}: {
  slug: string;
  companyId: string;
  funnelKey: string;
  from: Date;
  to: Date;
  fmt: { currency: string; locale: string };
}) {
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);
  const rows = await getFunnelRevenueLines(client, companyId, from, to, funnelKey);
  const total = rows.reduce((n, r) => n + r.amount, 0);

  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Sum
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatMoney(total, fmt)}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? 'won event' : 'won events'}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          No <code className="rounded bg-muted px-1">won</code> events in
          this funnel + window.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Lead</th>
                <th className="px-3 py-2 text-left">Ad</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RevenueRow key={r.eventId} row={r} slug={slug} fmt={fmt} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-medium">
                <td colSpan={3} className="px-3 py-2 text-right text-xs text-muted-foreground">
                  Total
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(total, fmt)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function RevenueRow({
  row,
  slug,
  fmt,
}: {
  row: RevenueLineRow;
  slug: string;
  fmt: { currency: string; locale: string };
}) {
  const name = [row.leadFirstName, row.leadLastName].filter(Boolean).join(' ');
  return (
    <tr className="border-t border-border align-top hover:bg-muted/30">
      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
        {formatDateTime(row.occurredAt, fmt)}
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/${slug}/leads/${row.leadId}`}
          className="hover:underline"
        >
          <div>{name || row.leadEmail || '—'}</div>
          {name && row.leadEmail && (
            <div className="text-xs font-mono text-muted-foreground">{row.leadEmail}</div>
          )}
        </Link>
      </td>
      <td className="px-3 py-2 text-xs">
        {row.adName ?? <span className="text-muted-foreground">no ad</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatMoney(row.amount, { ...fmt, currency: row.currency ?? fmt.currency })}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

async function SpendExplain({
  companyId,
  funnelKey,
  from,
  to,
  fmt,
}: {
  companyId: string;
  funnelKey: string;
  from: Date;
  to: Date;
  fmt: { currency: string; locale: string };
}) {
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);
  const rows = await getFunnelSpendBreakdown(client, companyId, from, to, funnelKey);
  const allocatedTotal = rows.reduce((n, r) => n + r.allocatedSpend, 0);

  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Allocated total
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatMoney(allocatedTotal, fmt)}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            across {rows.length} {rows.length === 1 ? 'ad' : 'ads'}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Per-ad: allocated = total_spend × (this-funnel events ÷ all events
          on the ad in this window). An ad whose leads split between
          multiple funnels contributes its spend proportionally.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          No ad-attributed events for this funnel in the window.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Ad</th>
                <th className="px-3 py-2 text-right">Total spend</th>
                <th className="px-3 py-2 text-right">This funnel / all events</th>
                <th className="px-3 py-2 text-right">Share</th>
                <th className="px-3 py-2 text-right">Allocated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <SpendRow key={r.adId} row={r} fmt={fmt} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-medium">
                <td colSpan={4} className="px-3 py-2 text-right text-xs text-muted-foreground">
                  Allocated total
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(allocatedTotal, fmt)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function SpendRow({
  row,
  fmt,
}: {
  row: SpendAllocationRow;
  fmt: { currency: string; locale: string };
}) {
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <div className="font-medium">{row.adName ?? '(unnamed)'}</div>
        {row.adExternalId && (
          <div className="text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1">{row.adExternalId}</code>
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatMoney(row.totalSpend, fmt)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
        {formatNumber(row.thisFunnelEvents, fmt)} / {formatNumber(row.totalEvents, fmt)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.share, 1)}</td>
      <td className="px-3 py-2 text-right tabular-nums font-medium">
        {formatMoney(row.allocatedSpend, fmt)}
      </td>
    </tr>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: 'muted';
  children: React.ReactNode;
}) {
  const cls = tone === 'muted' ? 'bg-amber-50 text-amber-800' : '';
  return <div className={`rounded-md ${cls} p-3 text-sm`}>{children}</div>;
}
