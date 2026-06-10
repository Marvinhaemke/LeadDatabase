import { describe, expect, it } from 'vitest';
import { evaluateFilter, matchFunnel, type FunnelDefinition } from './funnel-rules';

function f(overrides: Partial<FunnelDefinition>): FunnelDefinition {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    key: 'default',
    label: 'Default',
    priority: 100,
    filters: [],
    ...overrides,
  };
}

describe('evaluateFilter', () => {
  it('eq is case-insensitive', () => {
    expect(
      evaluateFilter(
        { field: 'utm_source', op: 'eq', value: 'Meta' },
        { utm_source: 'meta' },
      ),
    ).toBe(true);
  });
  it('eq fails on mismatch', () => {
    expect(
      evaluateFilter(
        { field: 'utm_source', op: 'eq', value: 'meta' },
        { utm_source: 'email' },
      ),
    ).toBe(false);
  });
  it('eq treats null as empty', () => {
    expect(
      evaluateFilter(
        { field: 'utm_source', op: 'eq', value: '' },
        { utm_source: null },
      ),
    ).toBe(true);
  });

  it('contains substring-matches case-insensitively', () => {
    expect(
      evaluateFilter(
        { field: 'landing_url', op: 'contains', value: '/VSL' },
        { landing_url: 'https://acme.example.com/vsl-page' },
      ),
    ).toBe(true);
  });
  it('contains returns false on null', () => {
    expect(
      evaluateFilter(
        { field: 'landing_url', op: 'contains', value: '/vsl' },
        { landing_url: null },
      ),
    ).toBe(false);
  });

  it('not_contains is true when field is null (vacuous)', () => {
    expect(
      evaluateFilter(
        { field: 'landing_url', op: 'not_contains', value: '/vsl' },
        { landing_url: null },
      ),
    ).toBe(true);
  });

  it('in matches any value (case-insensitive)', () => {
    expect(
      evaluateFilter(
        { field: 'utm_campaign', op: 'in', value: ['consulting', 'awareness'] },
        { utm_campaign: 'AWARENESS' },
      ),
    ).toBe(true);
  });
  it('in returns false on no match', () => {
    expect(
      evaluateFilter(
        { field: 'utm_campaign', op: 'in', value: ['consulting', 'awareness'] },
        { utm_campaign: 'newsletter' },
      ),
    ).toBe(false);
  });

  it('is_set treats empty string as not set', () => {
    expect(
      evaluateFilter({ field: 'utm_source', op: 'is_set' }, { utm_source: '' }),
    ).toBe(false);
    expect(
      evaluateFilter({ field: 'utm_source', op: 'is_set' }, { utm_source: 'meta' }),
    ).toBe(true);
  });

  it('is_not_set is true on undefined and null and empty string', () => {
    for (const v of [undefined, null, '']) {
      expect(
        evaluateFilter(
          { field: 'fbclid', op: 'is_not_set' },
          { fbclid: v as null },
        ),
      ).toBe(true);
    }
  });
});

describe('matchFunnel', () => {
  it('returns null when no funnels match', () => {
    const result = matchFunnel(
      [
        f({
          key: 'vsl',
          filters: [{ field: 'landing_url', op: 'contains', value: '/vsl' }],
        }),
      ],
      { landing_url: 'https://example.com/quiz' },
    );
    expect(result).toBeNull();
  });

  it('returns the funnel whose filters all pass', () => {
    const result = matchFunnel(
      [
        f({
          key: 'vsl',
          filters: [{ field: 'landing_url', op: 'contains', value: '/vsl' }],
        }),
      ],
      { landing_url: 'https://example.com/vsl-page' },
    );
    expect(result?.key).toBe('vsl');
  });

  it('AND-s all filters of one funnel', () => {
    const funnel = f({
      key: 'vsl_consulting',
      filters: [
        { field: 'landing_url', op: 'contains', value: '/vsl' },
        { field: 'utm_campaign', op: 'eq', value: 'consulting' },
      ],
    });
    expect(
      matchFunnel([funnel], {
        landing_url: 'https://example.com/vsl',
        utm_campaign: 'consulting',
      })?.key,
    ).toBe('vsl_consulting');
    // Second filter fails — no match.
    expect(
      matchFunnel([funnel], {
        landing_url: 'https://example.com/vsl',
        utm_campaign: 'awareness',
      }),
    ).toBeNull();
  });

  it('picks the lower priority funnel when multiple match', () => {
    const ctx = { landing_url: 'https://example.com/vsl', utm_campaign: 'consulting' };
    const broad = f({
      key: 'meta',
      priority: 100,
      filters: [{ field: 'landing_url', op: 'contains', value: '/' }],
    });
    const specific = f({
      key: 'vsl_consulting',
      priority: 10,
      filters: [{ field: 'landing_url', op: 'contains', value: '/vsl' }],
    });
    expect(matchFunnel([broad, specific], ctx)?.key).toBe('vsl_consulting');
  });

  it('skips funnels with zero filters (would match everything)', () => {
    const empty = f({ key: 'catchall', filters: [] });
    expect(matchFunnel([empty], {})).toBeNull();
  });

  it('breaks priority ties by key for deterministic ordering', () => {
    const ctx = { utm_source: 'meta' };
    const a = f({
      key: 'aaa',
      priority: 50,
      filters: [{ field: 'utm_source', op: 'eq', value: 'meta' }],
    });
    const b = f({
      key: 'bbb',
      priority: 50,
      filters: [{ field: 'utm_source', op: 'eq', value: 'meta' }],
    });
    expect(matchFunnel([b, a], ctx)?.key).toBe('aaa');
  });
});
