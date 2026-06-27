/**
 * Metric aggregators for the dashboard. Each function takes a Supabase
 * server client (RLS-scoped) and a company_id + date window, hits the
 * relevant view or table, and returns a flat object.
 *
 * All windows are inclusive of `from`, exclusive of `to` (`[from, to)`),
 * which matches the semantics used by Postgres `<` comparisons.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'db/types';

type Client = SupabaseClient<Database>;

export interface FunnelTotals {
  form_submissions: number;
  bookings_created: number;
  bookings_held: number;
  bookings_no_show: number;
  qualified: number;
  disqualified: number;
  proposals_sent: number;
  wins: number;
  losses: number;
  revenue: number;
}

const ZERO_FUNNEL: FunnelTotals = {
  form_submissions: 0,
  bookings_created: 0,
  bookings_held: 0,
  bookings_no_show: 0,
  qualified: 0,
  disqualified: 0,
  proposals_sent: 0,
  wins: 0,
  losses: 0,
  revenue: 0,
};

export async function getFunnelTotals(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
): Promise<FunnelTotals> {
  const { data } = await client
    .from('funnel_daily')
    .select(
      'form_submissions,bookings_created,bookings_held,bookings_no_show,qualified,disqualified,proposals_sent,wins,losses,revenue',
    )
    .eq('company_id', companyId)
    .gte('day', isoDate(from))
    .lt('day', isoDate(to));

  if (!data) return { ...ZERO_FUNNEL };
  return data.reduce<FunnelTotals>((acc, row) => {
    return {
      form_submissions: acc.form_submissions + Number(row.form_submissions ?? 0),
      bookings_created: acc.bookings_created + Number(row.bookings_created ?? 0),
      bookings_held: acc.bookings_held + Number(row.bookings_held ?? 0),
      bookings_no_show: acc.bookings_no_show + Number(row.bookings_no_show ?? 0),
      qualified: acc.qualified + Number(row.qualified ?? 0),
      disqualified: acc.disqualified + Number(row.disqualified ?? 0),
      proposals_sent: acc.proposals_sent + Number(row.proposals_sent ?? 0),
      wins: acc.wins + Number(row.wins ?? 0),
      losses: acc.losses + Number(row.losses ?? 0),
      revenue: acc.revenue + Number(row.revenue ?? 0),
    };
  }, { ...ZERO_FUNNEL });
}

export interface SpendTotals {
  spend: number;
  impressions: number;
  clicks: number;
}

export async function getSpendTotals(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
): Promise<SpendTotals> {
  const { data } = await client
    .from('ad_metrics_daily')
    .select('spend,impressions,clicks')
    .eq('company_id', companyId)
    .gte('date', isoDate(from))
    .lt('date', isoDate(to));

  if (!data) return { spend: 0, impressions: 0, clicks: 0 };
  return data.reduce<SpendTotals>(
    (acc, row) => ({
      spend: acc.spend + Number(row.spend ?? 0),
      impressions: acc.impressions + Number(row.impressions ?? 0),
      clicks: acc.clicks + Number(row.clicks ?? 0),
    }),
    { spend: 0, impressions: 0, clicks: 0 },
  );
}

export interface FunnelDailyRow {
  day: string;
  form_submissions: number;
  bookings_created: number;
  bookings_held: number;
  bookings_no_show: number;
  qualified: number;
  wins: number;
  revenue: number;
}

export async function getFunnelDaily(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
): Promise<FunnelDailyRow[]> {
  const { data } = await client
    .from('funnel_daily')
    .select(
      'day,form_submissions,bookings_created,bookings_held,bookings_no_show,qualified,wins,revenue',
    )
    .eq('company_id', companyId)
    .gte('day', isoDate(from))
    .lt('day', isoDate(to))
    .order('day', { ascending: false });

  return (data ?? []) as unknown as FunnelDailyRow[];
}

export interface ShowUpRow {
  day: string;
  held: number;
  no_show: number;
  cancelled_by_lead: number;
  opportunities: number;
  show_up_rate: number | null;
}

export async function getShowUpDaily(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
): Promise<ShowUpRow[]> {
  const { data } = await client
    .from('show_up_rate_daily')
    .select('day,held,no_show,cancelled_by_lead,opportunities,show_up_rate')
    .eq('company_id', companyId)
    .gte('day', isoDate(from))
    .lt('day', isoDate(to))
    .order('day', { ascending: false });

  return (data ?? []) as unknown as ShowUpRow[];
}

export interface AdPerformanceRow {
  ad_id: string;
  ad_name: string | null;
  spend: number;
  leads: number;
  qualified_leads: number;
  calls_held: number;
  wins: number;
  revenue: number;
  roas: number | null;
  avg_revenue_per_lead: number | null;
  avg_purchase_amount: number | null;
}

export async function getAdPerformance(
  client: Client,
  companyId: string,
  limit = 200,
): Promise<AdPerformanceRow[]> {
  // ad_performance is computed across all time. Use getAdPerformanceWindow
  // when the dashboard supplies a date range — this is just the lifetime
  // fallback.
  const { data } = await client
    .from('ad_performance')
    .select(
      'ad_id,ad_name,spend,leads,qualified_leads,calls_held,wins,revenue,roas,avg_revenue_per_lead,avg_purchase_amount',
    )
    .eq('company_id', companyId)
    .order('spend', { ascending: false })
    .limit(limit);

  return (data ?? []) as unknown as AdPerformanceRow[];
}

/**
 * Date-windowed ad performance. Aggregates `lead_events` (filtered by
 * occurred_at) and `ad_metrics_daily` (filtered by date) per ad in JS,
 * then joins against `ads` for names. Cheap enough at sales-funnel
 * volume; for big accounts we'd push this into a SQL function.
 */
export async function getAdPerformanceWindow(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
): Promise<AdPerformanceRow[]> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const fromDate = isoDate(from);
  const toDate = isoDate(to);

  const [eventsRes, spendRes, adsRes] = await Promise.all([
    client
      .from('lead_events')
      .select('lead_id, event_type, ad_id, amount')
      .eq('company_id', companyId)
      .gte('occurred_at', fromIso)
      .lt('occurred_at', toIso)
      .not('ad_id', 'is', null),
    client
      .from('ad_metrics_daily')
      .select('ad_id, spend')
      .eq('company_id', companyId)
      .gte('date', fromDate)
      .lt('date', toDate),
    client.from('ads').select('id, name, ad_set_id').eq('company_id', companyId),
  ]);

  interface PerAd {
    formLeads: Set<string>;
    qualifiedLeads: Set<string>;
    callsHeld: number;
    wins: number;
    revenue: number;
  }
  const perAd = new Map<string, PerAd>();
  const ensure = (adId: string): PerAd => {
    let v = perAd.get(adId);
    if (!v) {
      v = {
        formLeads: new Set(),
        qualifiedLeads: new Set(),
        callsHeld: 0,
        wins: 0,
        revenue: 0,
      };
      perAd.set(adId, v);
    }
    return v;
  };

  for (const e of (eventsRes.data ?? []) as Array<{
    lead_id: string;
    event_type: string;
    ad_id: string | null;
    amount: number | null;
  }>) {
    if (!e.ad_id) continue;
    const acc = ensure(e.ad_id);
    if (e.event_type === 'form_submitted') acc.formLeads.add(e.lead_id);
    if (e.event_type === 'qualified') acc.qualifiedLeads.add(e.lead_id);
    if (e.event_type === 'booking_held') acc.callsHeld += 1;
    if (e.event_type === 'won') {
      acc.wins += 1;
      acc.revenue += Number(e.amount ?? 0);
    }
  }

  const spendByAd = new Map<string, number>();
  for (const s of (spendRes.data ?? []) as Array<{ ad_id: string; spend: number | null }>) {
    spendByAd.set(s.ad_id, (spendByAd.get(s.ad_id) ?? 0) + Number(s.spend ?? 0));
  }

  const ads = (adsRes.data ?? []) as Array<{ id: string; name: string | null; ad_set_id: string }>;

  const rows: AdPerformanceRow[] = ads.map((a) => {
    const f = perAd.get(a.id);
    const spend = spendByAd.get(a.id) ?? 0;
    const leads = f?.formLeads.size ?? 0;
    const qualifiedLeads = f?.qualifiedLeads.size ?? 0;
    const callsHeld = f?.callsHeld ?? 0;
    const wins = f?.wins ?? 0;
    const revenue = f?.revenue ?? 0;
    return {
      ad_id: a.id,
      ad_name: a.name,
      spend,
      leads,
      qualified_leads: qualifiedLeads,
      calls_held: callsHeld,
      wins,
      revenue,
      roas: spend > 0 ? Number((revenue / spend).toFixed(4)) : null,
      avg_revenue_per_lead: leads > 0 ? Number((revenue / leads).toFixed(2)) : null,
      avg_purchase_amount: wins > 0 ? Number((revenue / wins).toFixed(2)) : null,
    };
  });

  // Hide ads with zero activity in the window.
  return rows
    .filter((r) => r.spend > 0 || r.leads > 0 || r.calls_held > 0 || r.wins > 0)
    .sort((a, b) => (b.spend || 0) - (a.spend || 0));
}

// ---------------------------------------------------------------------------

export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

// ---------------------------------------------------------------------------
// Per-funnel spend / revenue / ROAS
//
// An ad can serve multiple funnels (e.g. one Meta ad whose leads split
// across a VSL landing-page funnel and a Quiz funnel via different
// landing URLs). To answer "what did THIS funnel cost?" we proportionally
// allocate each ad's window spend across the funnels its events landed
// in, weighted by event count. Win revenue is summed directly off the
// funnel-tagged won events. ROAS = revenue / allocated spend.
//
// Honest about its assumption: event-count weighting treats every event
// equally, which over-credits funnels that fire many low-value events.
// For high-fidelity attribution swap in a different weighting (per-lead,
// per-conversion) — the helper interface stays the same.
// ---------------------------------------------------------------------------

export interface FunnelEconomics {
  spend: number;
  revenue: number;
  roas: number | null;
  /** Total events with ad_id for this funnel — denominator for spend share. */
  attributedEvents: number;
}

export async function getFunnelEconomics(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
  funnelKey: string,
): Promise<FunnelEconomics> {
  // 1) Every event-with-ad in the window. We need per-ad funnel mix to
  //    allocate spend.
  const { data: adEvents } = await client
    .from('lead_events')
    .select('ad_id, funnel_key')
    .eq('company_id', companyId)
    .not('ad_id', 'is', null)
    .gte('occurred_at', from.toISOString())
    .lt('occurred_at', to.toISOString());

  const adMix = new Map<string, { thisFunnel: number; total: number }>();
  for (const r of (adEvents ?? []) as Array<{ ad_id: string; funnel_key: string | null }>) {
    const stats = adMix.get(r.ad_id) ?? { thisFunnel: 0, total: 0 };
    stats.total += 1;
    if (r.funnel_key === funnelKey) stats.thisFunnel += 1;
    adMix.set(r.ad_id, stats);
  }

  // 2) Spend per ad in the window.
  let allocatedSpend = 0;
  const adIds = [...adMix.keys()];
  if (adIds.length > 0) {
    const { data: spendRows } = await client
      .from('ad_metrics_daily')
      .select('ad_id, spend')
      .eq('company_id', companyId)
      .in('ad_id', adIds)
      .gte('date', isoDate(from))
      .lt('date', isoDate(to));

    const spendByAd = new Map<string, number>();
    for (const r of (spendRows ?? []) as Array<{ ad_id: string; spend: number | null }>) {
      spendByAd.set(r.ad_id, (spendByAd.get(r.ad_id) ?? 0) + Number(r.spend ?? 0));
    }

    for (const [adId, spend] of spendByAd) {
      const stats = adMix.get(adId);
      if (!stats || stats.total === 0) continue;
      allocatedSpend += spend * (stats.thisFunnel / stats.total);
    }
  }

  // 3) Revenue: sum of won-event amounts for this funnel in the window.
  const { data: wonRows } = await client
    .from('lead_events')
    .select('amount')
    .eq('company_id', companyId)
    .eq('funnel_key', funnelKey)
    .eq('event_type', 'won')
    .gte('occurred_at', from.toISOString())
    .lt('occurred_at', to.toISOString());
  const revenue = ((wonRows ?? []) as Array<{ amount: number | null }>).reduce(
    (n, r) => n + Number(r.amount ?? 0),
    0,
  );

  const attributedEvents = [...adMix.values()].reduce((n, s) => n + s.thisFunnel, 0);

  return {
    spend: Math.round(allocatedSpend * 100) / 100,
    revenue,
    roas: allocatedSpend > 0 ? Number((revenue / allocatedSpend).toFixed(4)) : null,
    attributedEvents,
  };
}

/**
 * Per-ad detail behind `getFunnelEconomics`'s `spend` total. Each row
 * shows the allocation math (total spend, this funnel's event share,
 * resulting attributed spend). Used by the explain page so operators
 * can audit how the funnel's spend number was computed.
 */
export interface SpendAllocationRow {
  adId: string;
  adName: string | null;
  adExternalId: string | null;
  totalSpend: number;
  thisFunnelEvents: number;
  totalEvents: number;
  share: number;
  allocatedSpend: number;
}

export async function getFunnelSpendBreakdown(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
  funnelKey: string,
): Promise<SpendAllocationRow[]> {
  const { data: adEvents } = await client
    .from('lead_events')
    .select('ad_id, funnel_key')
    .eq('company_id', companyId)
    .not('ad_id', 'is', null)
    .gte('occurred_at', from.toISOString())
    .lt('occurred_at', to.toISOString());

  const adMix = new Map<string, { thisFunnel: number; total: number }>();
  for (const r of (adEvents ?? []) as Array<{ ad_id: string; funnel_key: string | null }>) {
    const s = adMix.get(r.ad_id) ?? { thisFunnel: 0, total: 0 };
    s.total += 1;
    if (r.funnel_key === funnelKey) s.thisFunnel += 1;
    adMix.set(r.ad_id, s);
  }

  const adIds = [...adMix.keys()];
  if (adIds.length === 0) return [];

  const [{ data: spendRows }, { data: adRows }] = await Promise.all([
    client
      .from('ad_metrics_daily')
      .select('ad_id, spend')
      .eq('company_id', companyId)
      .in('ad_id', adIds)
      .gte('date', isoDate(from))
      .lt('date', isoDate(to)),
    client
      .from('ads')
      .select('id, name, external_id')
      .eq('company_id', companyId)
      .in('id', adIds),
  ]);

  const spendByAd = new Map<string, number>();
  for (const r of (spendRows ?? []) as Array<{ ad_id: string; spend: number | null }>) {
    spendByAd.set(r.ad_id, (spendByAd.get(r.ad_id) ?? 0) + Number(r.spend ?? 0));
  }
  const adById = new Map(
    ((adRows ?? []) as Array<{ id: string; name: string | null; external_id: string | null }>).map(
      (a) => [a.id, a],
    ),
  );

  const rows: SpendAllocationRow[] = adIds.map((id) => {
    const mix = adMix.get(id)!;
    const totalSpend = spendByAd.get(id) ?? 0;
    const share = mix.total > 0 ? mix.thisFunnel / mix.total : 0;
    const ad = adById.get(id);
    return {
      adId: id,
      adName: ad?.name ?? null,
      adExternalId: ad?.external_id ?? null,
      totalSpend,
      thisFunnelEvents: mix.thisFunnel,
      totalEvents: mix.total,
      share,
      allocatedSpend: totalSpend * share,
    };
  });
  // Sort by allocated spend descending, then by total spend so zero-event
  // ads still sort sensibly.
  return rows.sort(
    (a, b) => b.allocatedSpend - a.allocatedSpend || b.totalSpend - a.totalSpend,
  );
}

/**
 * Individual `won` events that sum to the funnel's revenue. One row per
 * event with the lead it came from and the ad (if any) attributed at
 * event time.
 */
export interface RevenueLineRow {
  eventId: string;
  occurredAt: string;
  leadId: string;
  leadFirstName: string | null;
  leadLastName: string | null;
  leadEmail: string | null;
  adId: string | null;
  adName: string | null;
  amount: number;
  currency: string | null;
}

export async function getFunnelRevenueLines(
  client: Client,
  companyId: string,
  from: Date,
  to: Date,
  funnelKey: string,
): Promise<RevenueLineRow[]> {
  const { data } = await client
    .from('lead_events')
    .select(
      'id, occurred_at, lead_id, ad_id, amount, currency, leads:lead_id ( first_name, last_name, email ), ads:ad_id ( name )',
    )
    .eq('company_id', companyId)
    .eq('event_type', 'won')
    .eq('funnel_key', funnelKey)
    .gte('occurred_at', from.toISOString())
    .lt('occurred_at', to.toISOString())
    .order('occurred_at', { ascending: false });

  return ((data ?? []) as Array<{
    id: string;
    occurred_at: string;
    lead_id: string;
    ad_id: string | null;
    amount: number | null;
    currency: string | null;
    leads: unknown;
    ads: unknown;
  }>).map((r) => {
    const lead = pickJoinOne<{ first_name: string | null; last_name: string | null; email: string | null }>(r.leads);
    const ad = pickJoinOne<{ name: string | null }>(r.ads);
    return {
      eventId: r.id,
      occurredAt: r.occurred_at,
      leadId: r.lead_id,
      leadFirstName: lead?.first_name ?? null,
      leadLastName: lead?.last_name ?? null,
      leadEmail: lead?.email ?? null,
      adId: r.ad_id,
      adName: ad?.name ?? null,
      amount: Number(r.amount ?? 0),
      currency: r.currency,
    };
  });
}

function pickJoinOne<T>(value: unknown): T | null {
  if (value == null) return null;
  if (Array.isArray(value)) return ((value[0] as T) ?? null);
  return value as T;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
