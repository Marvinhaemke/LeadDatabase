/**
 * Thin Meta Marketing API client.
 *
 * Auth: bearer access token (System User token recommended for server-to-
 * server). The token is required at construction; we don't fall back to
 * env vars here so the client is testable in isolation.
 *
 * Pagination: `paginate()` follows `paging.next` URLs until exhausted.
 * Meta returns absolute URLs there, so we use them verbatim.
 *
 * Errors: any non-2xx response throws a `MetaApiError` carrying the
 * parsed Meta error body; the sync layer logs + skips, doesn't crash
 * the cron.
 */
import { z } from 'zod';
import {
  AdAccountSchema,
  AdSchema,
  AdSetSchema,
  CampaignSchema,
  InsightRowSchema,
  ListResponse,
  type AdAccountResponse,
  type AdResponse,
  type AdSetResponse,
  type CampaignResponse,
  type InsightRow,
} from './types';

export interface MetaClientOptions {
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

export class MetaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

const MetaErrorBody = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        type: z.string().optional(),
        code: z.number().optional(),
        error_subcode: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export class MetaClient {
  private readonly token: string;
  private readonly version: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MetaClientOptions) {
    this.token = opts.accessToken;
    this.version = opts.apiVersion ?? 'v21.0';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ------------------------------------------------------------------
  // High-level convenience methods
  // ------------------------------------------------------------------

  async getAdAccount(actId: string): Promise<AdAccountResponse> {
    const data = await this.get(`/${actId}`, {
      fields: 'id,account_id,name,currency,timezone_name',
    });
    return AdAccountSchema.parse(data);
  }

  campaigns(actId: string): AsyncIterable<CampaignResponse> {
    return this.paginate(`/${actId}/campaigns`, CampaignSchema, {
      fields: 'id,name,objective,status,effective_status',
      limit: '500',
    });
  }

  adSets(actId: string): AsyncIterable<AdSetResponse> {
    return this.paginate(`/${actId}/adsets`, AdSetSchema, {
      fields:
        'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget',
      limit: '500',
    });
  }

  ads(actId: string): AsyncIterable<AdResponse> {
    return this.paginate(`/${actId}/ads`, AdSchema, {
      fields: 'id,name,adset_id,status,effective_status,creative{id}',
      limit: '500',
    });
  }

  /**
   * Daily ad-level insights for a date range. Meta updates attribution
   * for ~7 days post-conversion, so callers should pass a 7+ day window
   * even on a per-hour cron to avoid stale numbers.
   */
  insights(
    actId: string,
    range: { since: string; until: string },
  ): AsyncIterable<InsightRow> {
    return this.paginate(`/${actId}/insights`, InsightRowSchema, {
      level: 'ad',
      time_increment: '1',
      time_range: JSON.stringify({ since: range.since, until: range.until }),
      fields: 'ad_id,date_start,date_stop,spend,impressions,clicks,reach,cpm,cpc,ctr',
      limit: '500',
    });
  }

  // ------------------------------------------------------------------
  // Low-level
  // ------------------------------------------------------------------

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`https://graph.facebook.com/${this.version}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return this.request(url.toString());
  }

  private async *paginate<T extends z.ZodTypeAny>(
    path: string,
    item: T,
    params: Record<string, string>,
  ): AsyncIterable<z.infer<T>> {
    const list = ListResponse(item);
    let url: string | null = (() => {
      const u = new URL(`https://graph.facebook.com/${this.version}${path}`);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u.toString();
    })();

    while (url) {
      const raw = await this.request(url);
      const parsed = list.parse(raw);
      for (const row of parsed.data) yield row;
      url = parsed.paging?.next ?? null;
    }
  }

  private async request(url: string): Promise<unknown> {
    const u = new URL(url);
    if (!u.searchParams.has('access_token')) {
      u.searchParams.set('access_token', this.token);
    }

    const res = await this.fetchImpl(u.toString(), { method: 'GET' });
    const text = await res.text();

    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!res.ok) {
      const parsed = MetaErrorBody.safeParse(body);
      const message = parsed.success
        ? (parsed.data.error.message ?? `meta api error (status ${res.status})`)
        : `meta api error (status ${res.status})`;
      throw new MetaApiError(res.status, body, message);
    }

    return body;
  }
}
