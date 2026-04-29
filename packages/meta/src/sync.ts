/**
 * Meta sync orchestrator.
 *
 * Each call syncs one Meta ad account (`act_<id>`) into one company:
 *   1. Refresh ad account metadata (name, currency).
 *   2. Walk campaigns → ad sets → ads, upserting hierarchy first.
 *   3. Pull daily insights for the requested window and upsert
 *      `ad_metrics_daily` rows (one per ad per date).
 *
 * Idempotency:
 *   - Hierarchy upserts use `(company_id, external_id)` unique indexes.
 *   - `ad_metrics_daily` upserts use `(company_id, ad_id, date)`.
 *   - A safe re-run of the sweeper just refreshes the same rows.
 *
 * Attribution defaults:
 *   - Backfill window defaults to 7 days because Meta's attribution
 *     window updates spend / conversion numbers retroactively for that
 *     long. Cron callers pass `windowDays = 7`; manual backfills can
 *     pass larger numbers.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from 'db/types';
import { MetaApiError, MetaClient } from './client';

type Client = SupabaseClient<Database>;

export interface SyncOptions {
  /** Service-role Supabase client (bypasses RLS). */
  client: Client;
  /** Company that owns this ad account. */
  companyId: string;
  /** Internal `ad_accounts.id`. */
  adAccountInternalId: string;
  /** Meta `act_<id>` account id. */
  adAccountExternalId: string;
  /** Meta API access token (system user token recommended). */
  accessToken: string;
  /** Meta API version, e.g. 'v21.0'. */
  apiVersion?: string;
  /** Days of insights to refresh, ending today (UTC). Default 7. */
  windowDays?: number;
}

export interface SyncSummary {
  adAccountId: string;
  campaigns: number;
  adSets: number;
  ads: number;
  insightRows: number;
  skippedInsights: number;
  errors: string[];
  windowFrom: string;
  windowTo: string;
}

export async function syncAdAccount(opts: SyncOptions): Promise<SyncSummary> {
  const meta = new MetaClient({ accessToken: opts.accessToken, apiVersion: opts.apiVersion });
  const summary: SyncSummary = {
    adAccountId: opts.adAccountExternalId,
    campaigns: 0,
    adSets: 0,
    ads: 0,
    insightRows: 0,
    skippedInsights: 0,
    errors: [],
    windowFrom: '',
    windowTo: '',
  };

  // ------------------------------------------------------------------
  // 1. Refresh ad account metadata
  // ------------------------------------------------------------------
  try {
    const acct = await meta.getAdAccount(opts.adAccountExternalId);
    await opts.client
      .from('ad_accounts')
      .update({
        name: acct.name ?? null,
        currency: acct.currency ?? null,
        attributes: { timezone_name: acct.timezone_name ?? null } as Json,
      })
      .eq('id', opts.adAccountInternalId)
      .eq('company_id', opts.companyId);
  } catch (e) {
    summary.errors.push(`account meta: ${formatError(e)}`);
  }

  // ------------------------------------------------------------------
  // 2. Hierarchy: campaigns → ad sets → ads
  //    We build internal-id maps so insights upsert can resolve ad_id.
  // ------------------------------------------------------------------
  const campaignByExternalId = new Map<string, string>();
  const adSetByExternalId = new Map<string, string>();
  const adByExternalId = new Map<string, string>();

  try {
    for await (const c of meta.campaigns(opts.adAccountExternalId)) {
      const id = await upsertCampaign(opts, c);
      if (id) {
        campaignByExternalId.set(c.id, id);
        summary.campaigns += 1;
      }
    }
  } catch (e) {
    summary.errors.push(`campaigns: ${formatError(e)}`);
  }

  try {
    for await (const s of meta.adSets(opts.adAccountExternalId)) {
      const campaignInternalId = campaignByExternalId.get(s.campaign_id);
      if (!campaignInternalId) {
        summary.errors.push(`ad set ${s.id}: parent campaign ${s.campaign_id} not synced`);
        continue;
      }
      const id = await upsertAdSet(opts, s, campaignInternalId);
      if (id) {
        adSetByExternalId.set(s.id, id);
        summary.adSets += 1;
      }
    }
  } catch (e) {
    summary.errors.push(`ad sets: ${formatError(e)}`);
  }

  try {
    for await (const a of meta.ads(opts.adAccountExternalId)) {
      const adSetInternalId = adSetByExternalId.get(a.adset_id);
      if (!adSetInternalId) {
        summary.errors.push(`ad ${a.id}: parent ad set ${a.adset_id} not synced`);
        continue;
      }
      const id = await upsertAd(opts, a, adSetInternalId);
      if (id) {
        adByExternalId.set(a.id, id);
        summary.ads += 1;
      }
    }
  } catch (e) {
    summary.errors.push(`ads: ${formatError(e)}`);
  }

  // ------------------------------------------------------------------
  // 3. Insights → ad_metrics_daily
  // ------------------------------------------------------------------
  const range = buildDateRange(opts.windowDays ?? 7);
  summary.windowFrom = range.since;
  summary.windowTo = range.until;

  try {
    const rows: Array<{
      company_id: string;
      ad_id: string;
      date: string;
      spend: number;
      impressions: number;
      clicks: number;
      reach: number | null;
      cpm: number | null;
      cpc: number | null;
      ctr: number | null;
      attributes: Json;
      fetched_at: string;
    }> = [];

    for await (const ins of meta.insights(opts.adAccountExternalId, range)) {
      const adInternalId = adByExternalId.get(ins.ad_id);
      if (!adInternalId) {
        summary.skippedInsights += 1;
        continue;
      }
      rows.push({
        company_id: opts.companyId,
        ad_id: adInternalId,
        date: ins.date_start,
        spend: ins.spend ?? 0,
        impressions: ins.impressions ?? 0,
        clicks: ins.clicks ?? 0,
        reach: ins.reach ?? null,
        cpm: ins.cpm ?? null,
        cpc: ins.cpc ?? null,
        ctr: ins.ctr ?? null,
        attributes: {} as Json,
        fetched_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      // Batch into chunks to keep request payloads sane.
      for (const chunk of chunked(rows, 500)) {
        const { error } = await opts.client
          .from('ad_metrics_daily')
          .upsert(chunk, { onConflict: 'company_id,ad_id,date' });
        if (error) {
          summary.errors.push(`ad_metrics_daily upsert: ${error.message}`);
          break;
        }
      }
      summary.insightRows = rows.length;
    }
  } catch (e) {
    summary.errors.push(`insights: ${formatError(e)}`);
  }

  return summary;
}

// =====================================================================
// Hierarchy upserts
// =====================================================================

async function upsertCampaign(
  opts: SyncOptions,
  c: { id: string; name?: string; status?: string; objective?: string; effective_status?: string },
): Promise<string | null> {
  const { data, error } = await opts.client
    .from('campaigns')
    .upsert(
      {
        company_id: opts.companyId,
        ad_account_id: opts.adAccountInternalId,
        external_id: c.id,
        name: c.name ?? null,
        status: c.effective_status ?? c.status ?? null,
        objective: c.objective ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,external_id' },
    )
    .select('id')
    .single();
  if (error) return null;
  return data.id as string;
}

async function upsertAdSet(
  opts: SyncOptions,
  s: {
    id: string;
    name?: string;
    status?: string;
    effective_status?: string;
    daily_budget?: string;
  },
  campaignInternalId: string,
): Promise<string | null> {
  const { data, error } = await opts.client
    .from('ad_sets')
    .upsert(
      {
        company_id: opts.companyId,
        campaign_id: campaignInternalId,
        external_id: s.id,
        name: s.name ?? null,
        status: s.effective_status ?? s.status ?? null,
        daily_budget: s.daily_budget != null ? Number(s.daily_budget) / 100 : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,external_id' },
    )
    .select('id')
    .single();
  if (error) return null;
  return data.id as string;
}

async function upsertAd(
  opts: SyncOptions,
  a: {
    id: string;
    name?: string;
    status?: string;
    effective_status?: string;
    creative?: { id: string };
  },
  adSetInternalId: string,
): Promise<string | null> {
  const { data, error } = await opts.client
    .from('ads')
    .upsert(
      {
        company_id: opts.companyId,
        ad_set_id: adSetInternalId,
        external_id: a.id,
        name: a.name ?? null,
        status: a.effective_status ?? a.status ?? null,
        creative_id: a.creative?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,external_id' },
    )
    .select('id')
    .single();
  if (error) return null;
  return data.id as string;
}

// =====================================================================
// Helpers
// =====================================================================

function buildDateRange(days: number): { since: string; until: string } {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - Math.max(1, days) + 1);
  return { since: isoDate(since), until: isoDate(today) };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function formatError(e: unknown): string {
  if (e instanceof MetaApiError) return `${e.status} ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// =====================================================================
// Entry: sync every Meta ad account for a company (or for all companies)
// =====================================================================

export interface SyncCompanyOptions {
  client: Client;
  companyId: string;
  accessToken: string;
  apiVersion?: string;
  windowDays?: number;
}

export async function syncCompanyMetaAccounts(
  opts: SyncCompanyOptions,
): Promise<SyncSummary[]> {
  const { data, error } = await opts.client
    .from('ad_accounts')
    .select('id, external_id')
    .eq('company_id', opts.companyId)
    .eq('platform', 'meta');
  if (error) throw new Error(`load ad_accounts: ${error.message}`);

  const accounts = (data ?? []) as Array<{ id: string; external_id: string }>;
  const summaries: SyncSummary[] = [];
  for (const acct of accounts) {
    const summary = await syncAdAccount({
      client: opts.client,
      companyId: opts.companyId,
      adAccountInternalId: acct.id,
      adAccountExternalId: acct.external_id,
      accessToken: opts.accessToken,
      apiVersion: opts.apiVersion,
      windowDays: opts.windowDays,
    });
    summaries.push(summary);
  }
  return summaries;
}

export async function syncAllMetaAccounts(opts: {
  client: Client;
  accessToken: string;
  apiVersion?: string;
  windowDays?: number;
}): Promise<Array<SyncSummary & { companyId: string; companySlug: string | null }>> {
  const { data, error } = await opts.client
    .from('ad_accounts')
    .select('id, external_id, company_id, companies:company_id ( slug )')
    .eq('platform', 'meta');
  if (error) throw new Error(`load ad_accounts: ${error.message}`);

  const accounts = (data ?? []) as unknown as Array<{
    id: string;
    external_id: string;
    company_id: string;
    companies: { slug: string } | { slug: string }[] | null;
  }>;

  const out: Array<SyncSummary & { companyId: string; companySlug: string | null }> = [];
  for (const acct of accounts) {
    const summary = await syncAdAccount({
      client: opts.client,
      companyId: acct.company_id,
      adAccountInternalId: acct.id,
      adAccountExternalId: acct.external_id,
      accessToken: opts.accessToken,
      apiVersion: opts.apiVersion,
      windowDays: opts.windowDays,
    });
    const slug = Array.isArray(acct.companies) ? (acct.companies[0]?.slug ?? null) : (acct.companies?.slug ?? null);
    out.push({ ...summary, companyId: acct.company_id, companySlug: slug });
  }
  return out;
}
