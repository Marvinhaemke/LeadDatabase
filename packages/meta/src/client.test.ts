import { describe, expect, it } from 'vitest';
import { MetaApiError, MetaClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
}

function makeFetchStub(
  responses: Array<{ url?: string | RegExp; body: unknown; status?: number }>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url });
    const next = responses[i++];
    if (!next) throw new Error(`unexpected fetch #${i}: ${url}`);
    if (next.url && (typeof next.url === 'string' ? !url.includes(next.url) : !next.url.test(url))) {
      throw new Error(`url mismatch on call ${i}: ${url}`);
    }
    return jsonResponse(next.body, next.status ?? 200);
  };
  return { fetchImpl, calls };
}

describe('MetaClient.getAdAccount', () => {
  it('returns the parsed account', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      {
        url: '/v21.0/act_123',
        body: { id: 'act_123', name: 'Acme', currency: 'EUR' },
      },
    ]);
    const client = new MetaClient({ accessToken: 'tok', fetchImpl });
    const acct = await client.getAdAccount('act_123');
    expect(acct.id).toBe('act_123');
    expect(acct.currency).toBe('EUR');
    expect(calls[0]!.url).toContain('access_token=tok');
  });

  it('uses the configured api version', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { body: { id: 'act_999' } },
    ]);
    const client = new MetaClient({ accessToken: 'tok', apiVersion: 'v18.0', fetchImpl });
    await client.getAdAccount('act_999');
    expect(calls[0]!.url).toContain('/v18.0/act_999');
  });
});

describe('MetaClient.campaigns (pagination)', () => {
  it('walks paging.next until exhausted', async () => {
    const { fetchImpl } = makeFetchStub([
      {
        body: {
          data: [{ id: 'c1', name: 'Camp 1' }],
          paging: { next: 'https://graph.facebook.com/v21.0/act_x/campaigns?after=cur1' },
        },
      },
      {
        body: {
          data: [{ id: 'c2', name: 'Camp 2' }],
          paging: { next: 'https://graph.facebook.com/v21.0/act_x/campaigns?after=cur2' },
        },
      },
      { body: { data: [{ id: 'c3', name: 'Camp 3' }] } },
    ]);
    const client = new MetaClient({ accessToken: 'tok', fetchImpl });
    const collected: string[] = [];
    for await (const c of client.campaigns('act_x')) {
      collected.push(c.id);
    }
    expect(collected).toEqual(['c1', 'c2', 'c3']);
  });

  it('stops on the first page when no next cursor', async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { body: { data: [{ id: 'c1' }, { id: 'c2' }] } },
    ]);
    const client = new MetaClient({ accessToken: 'tok', fetchImpl });
    const ids: string[] = [];
    for await (const c of client.campaigns('act_x')) ids.push(c.id);
    expect(ids).toEqual(['c1', 'c2']);
    expect(calls).toHaveLength(1);
  });
});

describe('MetaClient.insights', () => {
  it('coerces string numerics to numbers', async () => {
    const { fetchImpl } = makeFetchStub([
      {
        body: {
          data: [
            {
              ad_id: 'a1',
              date_start: '2026-04-22',
              date_stop: '2026-04-22',
              spend: '12.34',
              impressions: '1234',
              clicks: '12',
            },
          ],
        },
      },
    ]);
    const client = new MetaClient({ accessToken: 'tok', fetchImpl });
    const rows: Array<{ spend?: number; impressions?: number }> = [];
    for await (const r of client.insights('act_x', { since: '2026-04-22', until: '2026-04-22' })) {
      rows.push(r);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spend).toBe(12.34);
    expect(rows[0]!.impressions).toBe(1234);
  });
});

describe('MetaClient errors', () => {
  it('throws MetaApiError with parsed body on non-2xx', async () => {
    const { fetchImpl } = makeFetchStub([
      {
        body: { error: { message: 'Invalid OAuth access token.', code: 190 } },
        status: 401,
      },
    ]);
    const client = new MetaClient({ accessToken: 'tok', fetchImpl });
    let caught: unknown;
    try {
      await client.getAdAccount('act_bad');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    const err = caught as MetaApiError;
    expect(err.status).toBe(401);
    expect(err.message).toContain('Invalid OAuth');
  });
});
