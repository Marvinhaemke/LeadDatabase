import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { type FilterCondition } from 'ai/funnel-rules';
import {
  CANONICAL_FUNNEL,
  getObservedFunnel,
  getObservedFunnelDaily,
  type ObservedStage,
} from '@/lib/funnels';
import { getCohortTable } from '@/lib/cohorts';
import { getFunnelEconomics } from '@/lib/metrics';
import { resolveRange } from '@/lib/range';
import { DateRangePicker } from '@/components/date-range-picker';
import { LineChart } from '@/components/line-chart';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRoas,
} from '@/lib/format';
import { cn } from '@/lib/utils';

interface FunnelRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  priority: number;
  filters: FilterCondition[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LeadRow {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
}

const TARGET_OPTIONS = CANONICAL_FUNNEL.filter((s) => s.type !== 'form_submitted');

export default async function FunnelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string; id: string }>;
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    target?: string;
    created?: string;
    updated?: string;
    error?: string;
  }>;
}) {
  const { company: slug, id } = await params;
  const sp = await searchParams;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id, currency')
    .eq('slug', slug)
    .single();
  if (!company) notFound();

  const { data: funnelData } = await client
    .from('funnel_definitions')
    .select(
      'id, key, label, description, priority, filters, archived_at, created_at, updated_at',
    )
    .eq('id', id)
    .eq('company_id', company.id as string)
    .maybeSingle();
  if (!funnelData) notFound();
  const funnel = funnelData as unknown as FunnelRow;

  const fmt = { currency: company.currency as string, locale: 'de-DE' };
  const range = resolveRange({ range: sp.range ?? '90d', from: sp.from, to: sp.to });
  const targetKey = TARGET_OPTIONS.some((t) => t.type === sp.target)
    ? (sp.target as string)
    : 'won';

  // Everything below is scoped to this funnel's key.
  const [observed, cohort, leadIdRows, economics] = await Promise.all([
    getObservedFunnel(client, company.id as string, range.from, range.to, funnel.key),
    getCohortTable(
      client,
      company.id as string,
      'form_submitted',
      targetKey,
      range.from,
      range.to,
      'week',
      56,
      funnel.key,
    ),
    client
      .from('lead_events')
      .select('lead_id, occurred_at')
      .eq('company_id', company.id as string)
      .eq('funnel_key', funnel.key)
      .gte('occurred_at', range.from.toISOString())
      .lt('occurred_at', range.to.toISOString())
      .order('occurred_at', { ascending: false })
      .limit(1000),
    getFunnelEconomics(client, company.id as string, range.from, range.to, funnel.key),
  ]);

  // Recent leads — distinct, ordered by their most-recent event in window.
  const distinctLeadIds: string[] = [];
  const seen = new Set<string>();
  for (const r of (leadIdRows.data ?? []) as Array<{ lead_id: string }>) {
    if (!seen.has(r.lead_id)) {
      seen.add(r.lead_id);
      distinctLeadIds.push(r.lead_id);
      if (distinctLeadIds.length >= 25) break;
    }
  }
  const leads: LeadRow[] = [];
  if (distinctLeadIds.length > 0) {
    const { data } = await client
      .from('leads')
      .select('id, email, phone, first_name, last_name, created_at')
      .in('id', distinctLeadIds);
    const byId = new Map((data ?? []).map((l) => [(l as { id: string }).id, l as unknown as LeadRow]));
    for (const id of distinctLeadIds) {
      const lead = byId.get(id);
      if (lead) leads.push(lead);
    }
  }

  const seriesTypes = observed.stages.map((s) => s.type);
  const dailyRows =
    seriesTypes.length === 0
      ? []
      : await getObservedFunnelDaily(
          client,
          company.id as string,
          seriesTypes,
          range.from,
          range.to,
          funnel.key,
        );
  const chartSeries = observed.stages.map((s) => ({
    key: s.type,
    label: s.label,
    color: s.color,
  }));

  const totalEvents = observed.stages.reduce((n, s) => n + s.count, 0) +
    observed.extras.reduce((n, s) => n + s.count, 0);
  const distinctLeadsCount = seen.size; // capped at 1000 events; "most" accurate enough

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link href={`/${slug}/funnels`} className="hover:text-foreground">
          ← Funnels
        </Link>
      </div>

      {sp.created && (
        <Banner tone="success">
          Created <code>{decodeURIComponent(sp.created)}</code>.
        </Banner>
      )}
      {sp.updated && (
        <Banner tone="success">
          Updated <code>{decodeURIComponent(sp.updated)}</code>.
        </Banner>
      )}
      {sp.error && <Banner tone="error">{decodeURIComponent(sp.error)}</Banner>}

      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{funnel.label}</h1>
              {funnel.archived_at && (
                <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  archived
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1">funnel_key = {funnel.key}</code>
              <span>priority {funnel.priority}</span>
              <span>created {formatDateTime(funnel.created_at, fmt)}</span>
            </div>
            {funnel.description && (
              <p className="text-sm text-muted-foreground">{funnel.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/${slug}/funnels/${id}/edit`}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              Edit rules
            </Link>
            <DateRangePicker
              preset={range.preset}
              fromIso={range.fromIso}
              toIsoInclusive={range.toIsoInclusive}
            />
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/20 p-3">
          <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
            Filter rules (all must match)
          </div>
          <FilterSummary filters={funnel.filters} />
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Stat label="Events in window" value={formatNumber(totalEvents, fmt)} />
        <Stat
          label="Distinct leads"
          value={formatNumber(distinctLeadsCount, fmt)}
          hint={distinctLeadsCount >= 999 ? '1000+ (capped)' : undefined}
        />
        <Stat
          label={`Reached ${targetKey}`}
          value={formatNumber(
            observed.stages.find((s) => s.type === targetKey)?.count ?? 0,
            fmt,
          )}
        />
        <Stat
          label={`form → ${targetKey}`}
          value={(() => {
            const entry = observed.stages.find((s) => s.type === 'form_submitted')?.count ?? 0;
            const target = observed.stages.find((s) => s.type === targetKey)?.count ?? 0;
            return entry > 0 ? formatPercent(target / entry) : '—';
          })()}
        />
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">Economics</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Spend is each ad's window total, allocated to this funnel by its
          share of the ad's events (so a Meta ad serving both VSL and Quiz
          funnels splits proportionally). Revenue is the sum of{' '}
          <code className="rounded bg-muted px-1">won</code> event amounts
          tagged with this funnel.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat
            label="Spend (allocated)"
            value={formatMoney(economics.spend, fmt)}
            hint={`${formatNumber(economics.attributedEvents, fmt)} ad-attributed events`}
          />
          <Stat label="Revenue" value={formatMoney(economics.revenue, fmt)} />
          <Stat
            label="ROAS"
            value={formatRoas(economics.roas)}
            hint={economics.spend === 0 ? 'no spend in window' : undefined}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">Funnel</h2>
        {observed.stages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            No events tagged with this funnel in the window. Hit{' '}
            <strong>Rematch all events</strong> on the list page if you just
            edited the rules.
          </div>
        ) : (
          <>
            <LineChart
              data={dailyRows as Array<Record<string, string | number> & { day: string }>}
              series={chartSeries}
            />
            <div className="mt-3">
              <StageStrip stages={observed.stages} fmt={fmt} />
            </div>
            {observed.extras.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {observed.extras.map((s) => (
                  <span
                    key={s.type}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px]"
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: s.color }}
                    />
                    <span className="font-mono">{s.type}</span>
                    <span className="tabular-nums">{formatNumber(s.count, fmt)}</span>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-base font-semibold">
            Cohorts — form_submitted →{' '}
            {TARGET_OPTIONS.find((t) => t.type === targetKey)?.label ?? targetKey}
          </h2>
          <div className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Target:</span>
            {TARGET_OPTIONS.map((opt) => (
              <Link
                key={opt.type}
                href={buildHref(slug, id, sp, { target: opt.type })}
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
          </div>
        </div>

        {cohort.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No <code>form_submitted</code> events for this funnel in the window.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Cohort</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  {cohort.columns.map((c) => (
                    <th key={c} className="px-3 py-2 text-right whitespace-nowrap">
                      {c === 0 ? 'W0' : `W${Math.round(c / 7)}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohort.rows.map((row) => (
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
                        {cell.rate != null ? (
                          formatPercent(cell.rate, 0)
                        ) : (
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
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold">Recent leads in this funnel</h2>
        {leads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No leads have events tagged with this funnel in the window.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Email</th>
                  <th className="px-3 py-2 text-left">Phone</th>
                  <th className="px-3 py-2 text-right">Created</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        href={`/${slug}/leads/${l.id}`}
                        className="hover:underline"
                      >
                        {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/${slug}/leads/${l.id}`}
                        className="hover:underline"
                      >
                        {l.email ?? '—'}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{l.phone ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                      {formatDateTime(l.created_at, fmt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: 'success' | 'error';
  children: React.ReactNode;
}) {
  const cls = tone === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700';
  return <div className={`rounded-md ${cls} p-3 text-sm`}>{children}</div>;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function StageStrip({
  stages,
  fmt,
}: {
  stages: ObservedStage[];
  fmt: { currency: string; locale: string };
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
      {stages.map((s) => (
        <div key={s.type} className="rounded-md border border-border bg-muted/20 p-2">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-2 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {s.label}
            </span>
          </div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {formatNumber(s.count, fmt)}
          </div>
          {s.stepRate != null && (
            <div className="text-[10px] text-muted-foreground">
              {formatPercent(s.stepRate)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FilterSummary({ filters }: { filters: FilterCondition[] }) {
  if (!filters || filters.length === 0) {
    return <span className="text-xs text-muted-foreground">No filters defined.</span>;
  }
  return (
    <ul className="space-y-0.5 text-xs">
      {filters.map((f, i) => {
        const value = (() => {
          if (f.op === 'is_set' || f.op === 'is_not_set') return null;
          const v = (f as { value?: string | string[] }).value;
          if (Array.isArray(v)) return v.join(', ');
          return v ?? '';
        })();
        return (
          <li key={i} className="font-mono">
            <span>{f.field}</span> <span className="text-muted-foreground">{f.op}</span>
            {value != null && <span> {value}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function cellBackground(rate: number): string {
  if (rate <= 0) return 'transparent';
  const intensity = Math.min(1, rate * 2.5);
  return `hsl(150 60% 90% / ${intensity})`;
}

function buildHref(
  slug: string,
  id: string,
  current: { range?: string; from?: string; to?: string; target?: string },
  patch: { target?: string },
): string {
  const sp = new URLSearchParams();
  if (current.range) sp.set('range', current.range);
  if (current.from) sp.set('from', current.from);
  if (current.to) sp.set('to', current.to);
  const target = patch.target ?? current.target;
  if (target) sp.set('target', target);
  const qs = sp.toString();
  return `/${slug}/funnels/${id}${qs ? `?${qs}` : ''}`;
}
