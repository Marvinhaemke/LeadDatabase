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
  // ad_performance is computed across all time. Date-windowed perf will
  // come from a parameterised SQL function in a follow-up; for now the
  // dashboard page exposes the all-time view.
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

// ---------------------------------------------------------------------------

export function defaultRange(days = 30): { from: Date; to: Date; prevFrom: Date; prevTo: Date } {
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  to.setUTCDate(to.getUTCDate() + 1); // include today

  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);

  const prevTo = new Date(from);
  const prevFrom = new Date(from);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - days);

  return { from, to, prevFrom, prevTo };
}

export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
