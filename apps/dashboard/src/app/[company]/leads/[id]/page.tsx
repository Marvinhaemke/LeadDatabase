import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format';

interface LeadRow {
  id: string;
  company_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  source: string | null;
  attributes: Record<string, unknown> | null;
  attributed_ad_id: string | null;
  attributed_via: string | null;
  attributed_at: string | null;
  created_at: string;
  updated_at: string;
  ads: { name: string | null; external_id: string } | { name: string | null; external_id: string }[] | null;
}

interface LeadEventRow {
  id: string;
  event_type: string;
  event_subtype: string | null;
  occurred_at: string;
  amount: number | null;
  currency: string | null;
  source: string | null;
  ad_id: string | null;
  booking_id: string | null;
  deal_id: string | null;
  funnel_key: string | null;
  attributes: Record<string, unknown> | null;
}

interface BookingRow {
  id: string;
  meeting_type: string | null;
  scheduled_at: string;
  status: string;
  status_set_at: string;
  status_source: string | null;
  duration_minutes: number | null;
  external_id: string | null;
  previous_booking_id: string | null;
  attributes: Record<string, unknown> | null;
}

interface DealRow {
  id: string;
  status: string;
  amount: number | null;
  currency: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  attributes: Record<string, unknown> | null;
  pipeline_stages: { key: string; label: string } | { key: string; label: string }[] | null;
}

interface AttributionRow {
  id: string;
  fbclid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  landing_url: string | null;
  referrer_url: string | null;
  matched_ad_id: string | null;
  match_strategy: string | null;
  matched_at: string | null;
  captured_at: string;
  ads: { name: string | null; external_id: string } | { name: string | null; external_id: string }[] | null;
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ company: string; id: string }>;
}) {
  const { company: slug, id } = await params;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id, currency')
    .eq('slug', slug)
    .single();
  if (!company) notFound();

  const fmt = { currency: company.currency as string, locale: 'de-DE' };

  const [leadRes, eventsRes, bookingsRes, dealsRes, attributionRes] = await Promise.all([
    client
      .from('leads')
      .select(
        'id, company_id, email, phone, first_name, last_name, source, attributes, attributed_ad_id, attributed_via, attributed_at, created_at, updated_at, ads:attributed_ad_id ( name, external_id )',
      )
      .eq('company_id', company.id as string)
      .eq('id', id)
      .maybeSingle(),
    client
      .from('lead_events')
      .select(
        'id, event_type, event_subtype, occurred_at, amount, currency, source, ad_id, booking_id, deal_id, funnel_key, attributes',
      )
      .eq('company_id', company.id as string)
      .eq('lead_id', id)
      .order('occurred_at', { ascending: false })
      .limit(200),
    client
      .from('bookings')
      .select(
        'id, meeting_type, scheduled_at, status, status_set_at, status_source, duration_minutes, external_id, previous_booking_id, attributes',
      )
      .eq('company_id', company.id as string)
      .eq('lead_id', id)
      .order('scheduled_at', { ascending: false }),
    client
      .from('deals')
      .select(
        'id, status, amount, currency, closed_at, created_at, updated_at, attributes, pipeline_stages:stage_id ( key, label )',
      )
      .eq('company_id', company.id as string)
      .eq('lead_id', id)
      .order('updated_at', { ascending: false }),
    client
      .from('lead_attribution')
      .select(
        'id, fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_url, referrer_url, matched_ad_id, match_strategy, matched_at, captured_at, ads:matched_ad_id ( name, external_id )',
      )
      .eq('company_id', company.id as string)
      .eq('lead_id', id)
      .order('captured_at', { ascending: false }),
  ]);

  const lead = leadRes.data as unknown as LeadRow | null;
  if (!lead) notFound();

  const events = (eventsRes.data ?? []) as unknown as LeadEventRow[];
  const bookings = (bookingsRes.data ?? []) as unknown as BookingRow[];
  const deals = (dealsRes.data ?? []) as unknown as DealRow[];
  const attributions = (attributionRes.data ?? []) as unknown as AttributionRow[];

  const attributedAd = pickOne(lead.ads);
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || '(no name)';

  return (
    <div className="space-y-8">
      <div className="text-sm text-muted-foreground">
        <Link href={`/${slug}/leads`} className="hover:text-foreground">
          ← Leads
        </Link>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{fullName}</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {lead.email && <code className="rounded bg-muted px-1">{lead.email}</code>}
          {lead.phone && <code className="rounded bg-muted px-1">{lead.phone}</code>}
          {lead.source && <span>source: {lead.source}</span>}
          <span>created {formatDateTime(lead.created_at, fmt)}</span>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Stat label="Events" value={formatNumber(events.length, fmt)} />
        <Stat label="Bookings" value={formatNumber(bookings.length, fmt)} />
        <Stat label="Deals" value={formatNumber(deals.length, fmt)} />
        <Stat
          label="Attributed ad"
          value={
            attributedAd ? (
              <span className="text-base font-medium">
                {attributedAd.name ?? '(unnamed)'}
              </span>
            ) : (
              <span className="text-base text-muted-foreground">unattributed</span>
            )
          }
          hint={
            attributedAd
              ? `via ${lead.attributed_via ?? '?'} · ${attributedAd.external_id}`
              : undefined
          }
        />
      </section>

      <JourneySection events={events} />

      <section>
        <h2 className="text-base font-semibold">Timeline</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Append-only event log driving the funnel views. Bucketed by{' '}
          <code className="rounded bg-muted px-1">occurred_at</code>.
          The <strong>Funnel</strong> column shows which acquisition path
          each event belongs to — a lead can flow through multiple funnels
          over time, and past events keep their original tag.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          {events.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No events recorded for this lead yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">Event</th>
                  <th className="px-3 py-2 text-left">Funnel</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-left">Refs</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(e.occurred_at, fmt)}
                    </td>
                    <td className="px-3 py-2">
                      <EventBadge type={e.event_type} />
                      {e.event_subtype && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {e.event_subtype}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <FunnelPill funnelKey={e.funnel_key} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {e.source ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground space-x-2">
                      {e.ad_id && <span title={`ad_id ${e.ad_id}`}>📊 ad</span>}
                      {e.booking_id && <span title={`booking_id ${e.booking_id}`}>📅 booking</span>}
                      {e.deal_id && <span title={`deal_id ${e.deal_id}`}>💰 deal</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">
                      {e.amount != null ? formatMoney(e.amount, { ...fmt, currency: e.currency ?? fmt.currency }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-base font-semibold">Bookings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One row per scheduled meeting. Reschedule chain visible via
            <code className="mx-1 rounded bg-muted px-1">previous_booking_id</code>.
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            {bookings.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No bookings.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Scheduled</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr key={b.id} className="border-t border-border align-top">
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {formatDateTime(b.scheduled_at, fmt)}
                        {b.duration_minutes && (
                          <span className="ml-1 text-muted-foreground">({b.duration_minutes}m)</span>
                        )}
                        {b.previous_booking_id && (
                          <div className="text-[10px] text-muted-foreground">
                            ↳ reschedule of {b.previous_booking_id.slice(0, 8)}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {b.meeting_type ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <BookingStatusBadge status={b.status} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {b.status_source ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          <h2 className="text-base font-semibold">Deals</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sales-pipeline opportunities for this lead.
          </p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            {deals.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No deals.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Stage</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-right">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((d) => {
                    const stage = pickOne(d.pipeline_stages);
                    return (
                      <tr key={d.id} className="border-t border-border align-top">
                        <td className="px-3 py-2 text-xs">
                          {stage?.label ?? '—'}
                          {stage && (
                            <div className="text-[10px] text-muted-foreground">{stage.key}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <DealStatusBadge status={d.status} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs">
                          {d.amount != null
                            ? formatMoney(d.amount, { ...fmt, currency: d.currency ?? fmt.currency })
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {formatDate(d.updated_at, fmt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold">Attribution history</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every <code className="rounded bg-muted px-1">lead_attribution</code>{' '}
          row captured for this lead. The first row that resolved to an ad
          stamped <code className="mx-1 rounded bg-muted px-1">leads.attributed_ad_id</code>.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          {attributions.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No attribution rows.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Captured</th>
                  <th className="px-3 py-2 text-left">utm / fbclid</th>
                  <th className="px-3 py-2 text-left">Landing</th>
                  <th className="px-3 py-2 text-left">Match</th>
                </tr>
              </thead>
              <tbody>
                {attributions.map((a) => {
                  const matched = pickOne(a.ads);
                  return (
                    <tr key={a.id} className="border-t border-border align-top">
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {formatDateTime(a.captured_at, fmt)}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        <UtmList row={a} />
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
                        {a.landing_url ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {matched ? (
                          <div>
                            <div className="font-medium">{matched.name ?? '(unnamed)'}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {a.match_strategy} · {matched.external_id}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            {a.match_strategy ?? 'no match yet'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold">Attributes</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Raw <code className="rounded bg-muted px-1">leads.attributes</code> JSONB.
          Unknown / not-yet-promoted fields land here.
        </p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs">
{JSON.stringify(lead.attributes ?? {}, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function EventBadge({ type }: { type: string }) {
  const tone = (() => {
    if (type === 'won') return 'bg-emerald-50 text-emerald-700';
    if (type === 'lost' || type === 'disqualified' || type === 'refunded')
      return 'bg-red-50 text-red-700';
    if (type === 'booking_no_show') return 'bg-amber-50 text-amber-700';
    if (type === 'booking_held' || type === 'qualified' || type === 'proposal_sent')
      return 'bg-blue-50 text-blue-700';
    if (type === 'form_submitted' || type === 'booking_created') return 'bg-muted text-foreground';
    return 'bg-muted text-muted-foreground';
  })();
  return <span className={`rounded px-2 py-0.5 text-xs font-mono ${tone}`}>{type}</span>;
}

function BookingStatusBadge({ status }: { status: string }) {
  const tone = (() => {
    if (status === 'held') return 'bg-emerald-50 text-emerald-700';
    if (status === 'no_show') return 'bg-red-50 text-red-700';
    if (status === 'rescheduled') return 'bg-blue-50 text-blue-700';
    if (status === 'cancelled_by_lead' || status === 'cancelled_by_us')
      return 'bg-muted text-muted-foreground';
    return 'bg-amber-50 text-amber-700';
  })();
  return <span className={`rounded px-2 py-0.5 ${tone}`}>{status}</span>;
}

function DealStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'won'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'lost'
        ? 'bg-red-50 text-red-700'
        : 'bg-muted text-muted-foreground';
  return <span className={`rounded px-2 py-0.5 ${tone}`}>{status}</span>;
}

// =============================================================================
// Funnel-journey helpers
// =============================================================================

/**
 * Stable color per funnel_key so the same source looks the same wherever
 * it appears. Hashes the key to one of N HSL hues so we don't have to
 * maintain a palette by hand.
 */
function colorForFunnel(key: string | null | undefined): string {
  if (!key) return 'hsl(220 10% 60%)';
  if (key === 'meta') return 'hsl(220 70% 55%)';
  if (key === 'email') return 'hsl(35 90% 50%)';
  if (key === 'organic' || key === 'google') return 'hsl(160 60% 40%)';
  if (key === 'newsletter') return 'hsl(280 60% 55%)';
  // Hash to a hue
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 55% 45%)`;
}

function FunnelPill({ funnelKey }: { funnelKey: string | null | undefined }) {
  if (!funnelKey) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px]">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: colorForFunnel(funnelKey) }}
      />
      <span className="font-mono">{funnelKey}</span>
    </span>
  );
}

/**
 * "Journey" summary: shows the ordered chain of funnels the lead has
 * touched (form_submitted events are good entry-point markers; if the
 * lead has wins/losses, also call out the closing funnel). Sorted by
 * occurred_at ascending so it reads left → right.
 */
function JourneySection({ events }: { events: LeadEventRow[] }) {
  const ordered = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  // Compress consecutive same-funnel events into a single segment.
  const segments: Array<{ key: string | null; first: string; last: string; count: number; sawWon: boolean }> = [];
  for (const e of ordered) {
    const k = e.funnel_key;
    const last = segments[segments.length - 1];
    if (last && last.key === k) {
      last.last = e.occurred_at;
      last.count += 1;
      if (e.event_type === 'won') last.sawWon = true;
    } else {
      segments.push({
        key: k ?? null,
        first: e.occurred_at,
        last: e.occurred_at,
        count: 1,
        sawWon: e.event_type === 'won',
      });
    }
  }

  if (segments.length === 0) return null;

  const distinctFunnels = new Set(segments.map((s) => s.key));
  const closingSeg = segments.find((s) => s.sawWon);

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Journey</h2>
        <span className="text-xs text-muted-foreground">
          {distinctFunnels.size} {distinctFunnels.size === 1 ? 'funnel' : 'funnels'} touched
          {closingSeg && (
            <>
              {' '}
              · closed via{' '}
              <FunnelPill funnelKey={closingSeg.key} />
            </>
          )}
        </span>
      </div>
      <ol className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {segments.map((seg, i) => (
          <li key={i} className="flex items-center gap-2">
            {i > 0 && <span className="text-muted-foreground">→</span>}
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: colorForFunnel(seg.key) }}
              />
              <span className="font-mono">{seg.key ?? '(unattributed)'}</span>
              <span className="text-muted-foreground">
                {seg.count} event{seg.count === 1 ? '' : 's'}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function UtmList({ row }: { row: AttributionRow }) {
  const fields: Array<[string, string | null]> = [
    ['utm_source', row.utm_source],
    ['utm_medium', row.utm_medium],
    ['utm_campaign', row.utm_campaign],
    ['utm_content', row.utm_content],
    ['utm_term', row.utm_term],
    ['fbclid', row.fbclid],
  ];
  const present = fields.filter(([, v]) => v);
  if (present.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="space-y-0.5">
      {present.map(([k, v]) => (
        <li key={k}>
          <span className="text-muted-foreground">{k}=</span>
          <span>{v}</span>
        </li>
      ))}
    </ul>
  );
}
