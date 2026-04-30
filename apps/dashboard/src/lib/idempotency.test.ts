import { describe, expect, it } from 'vitest';
import { buildIdempotencyKey } from './idempotency';

describe('buildIdempotencyKey', () => {
  it('prefers the client-supplied key when present', () => {
    expect(
      buildIdempotencyKey({
        source: 'zapier',
        body: { foo: 1 },
        clientKey: 'abc123',
      }),
    ).toBe('client:zapier:abc123');
  });

  it('hashes the body when no client key is supplied', () => {
    const key = buildIdempotencyKey({ source: 'zapier', body: { foo: 1, bar: 2 } });
    expect(key).toMatch(/^hash:zapier:[0-9a-f]{64}$/);
  });

  it('produces the same hash regardless of object key order', () => {
    const a = buildIdempotencyKey({ source: 'zapier', body: { a: 1, b: 2, c: 3 } });
    const b = buildIdempotencyKey({ source: 'zapier', body: { c: 3, b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('canonicalises nested objects too', () => {
    const a = buildIdempotencyKey({
      source: 's',
      body: { outer: { z: 1, a: 2 }, x: [1, 2] },
    });
    const b = buildIdempotencyKey({
      source: 's',
      body: { x: [1, 2], outer: { a: 2, z: 1 } },
    });
    expect(a).toBe(b);
  });

  it('different sources yield different keys for the same body', () => {
    const body = { foo: 'bar' };
    const a = buildIdempotencyKey({ source: 'zapier', body });
    const b = buildIdempotencyKey({ source: 'calendly', body });
    expect(a).not.toBe(b);
  });

  it('different bodies yield different keys', () => {
    const a = buildIdempotencyKey({ source: 'zapier', body: { v: 1 } });
    const b = buildIdempotencyKey({ source: 'zapier', body: { v: 2 } });
    expect(a).not.toBe(b);
  });

  it('treats array order as significant', () => {
    const a = buildIdempotencyKey({ source: 's', body: { xs: [1, 2, 3] } });
    const b = buildIdempotencyKey({ source: 's', body: { xs: [3, 2, 1] } });
    expect(a).not.toBe(b);
  });

  it('falls back to hash when clientKey is empty string', () => {
    const key = buildIdempotencyKey({ source: 'zapier', body: { foo: 1 }, clientKey: '' });
    expect(key.startsWith('hash:')).toBe(true);
  });
});
