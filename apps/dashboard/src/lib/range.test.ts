import { describe, expect, it } from 'vitest';
import { resolveRange } from './range';

describe('resolveRange', () => {
  it('defaults to 30 days when no params', () => {
    const r = resolveRange({});
    expect(r.preset).toBe('30d');
    expect(r.days).toBe(30);
  });

  it('handles 7d / 30d / 90d presets', () => {
    expect(resolveRange({ range: '7d' }).days).toBe(7);
    expect(resolveRange({ range: '30d' }).days).toBe(30);
    expect(resolveRange({ range: '90d' }).days).toBe(90);
  });

  it('produces a length-equal previous period', () => {
    const r = resolveRange({ range: '30d' });
    const cur = r.to.getTime() - r.from.getTime();
    const prev = r.prevTo.getTime() - r.prevFrom.getTime();
    expect(prev).toBe(cur);
    expect(r.prevTo.getTime()).toBe(r.from.getTime());
  });

  it('parses a custom range with inclusive `to`', () => {
    const r = resolveRange({ from: '2026-04-01', to: '2026-04-10' });
    expect(r.preset).toBe('custom');
    expect(r.fromIso).toBe('2026-04-01');
    expect(r.toIsoInclusive).toBe('2026-04-10');
    // 10 inclusive days
    expect(r.days).toBe(10);
  });

  it('falls back to 30d on inverted custom range', () => {
    const r = resolveRange({ from: '2026-04-30', to: '2026-04-01' });
    expect(r.preset).toBe('30d');
  });

  it('falls back when range param is unknown', () => {
    const r = resolveRange({ range: 'forever' });
    expect(r.preset).toBe('30d');
  });

  it('mtd starts on day 1 of the current month', () => {
    const r = resolveRange({ range: 'mtd' });
    const today = new Date();
    expect(r.from.getUTCDate()).toBe(1);
    expect(r.from.getUTCMonth()).toBe(today.getUTCMonth());
    expect(r.from.getUTCFullYear()).toBe(today.getUTCFullYear());
  });

  it('ytd starts on Jan 1', () => {
    const r = resolveRange({ range: 'ytd' });
    expect(r.from.getUTCMonth()).toBe(0);
    expect(r.from.getUTCDate()).toBe(1);
  });
});
