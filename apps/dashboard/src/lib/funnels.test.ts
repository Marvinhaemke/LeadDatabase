import { describe, expect, it } from 'vitest';
import { CANONICAL_FUNNEL, computeFunnel } from './funnels';

describe('computeFunnel', () => {
  it('returns empty stages when no events are observed', () => {
    const f = computeFunnel(new Map());
    expect(f.stages).toEqual([]);
    expect(f.extras).toEqual([]);
  });

  it('renders the canonical sequence with step rates between consecutive stages', () => {
    const f = computeFunnel(
      new Map([
        ['form_submitted', 100],
        ['booking_created', 40],
        ['booking_held', 24],
        ['qualified', 18],
        ['proposal_sent', 10],
        ['won', 6],
      ]),
    );
    expect(f.stages).toHaveLength(6);
    expect(f.stages.map((s) => s.type)).toEqual(CANONICAL_FUNNEL.map((s) => s.type));
    expect(f.stages[0]!.stepRate).toBeNull();
    expect(f.stages[1]!.stepRate).toBeCloseTo(0.4, 4); // 40/100
    expect(f.stages[5]!.stepRate).toBeCloseTo(0.6, 4); // 6/10
  });

  it('trims leading and trailing zero stages', () => {
    const f = computeFunnel(
      new Map([
        ['booking_created', 5],
        ['booking_held', 3],
      ]),
    );
    // No form_submitted ahead, no qualified after → first/last shown are
    // booking_created and booking_held.
    expect(f.stages.map((s) => s.type)).toEqual(['booking_created', 'booking_held']);
  });

  it('keeps zero-count stages between non-zero ones (pipeline-break visibility)', () => {
    const f = computeFunnel(
      new Map([
        ['form_submitted', 10],
        // no booking_created
        ['booking_held', 3],
      ]),
    );
    expect(f.stages.map((s) => s.type)).toEqual([
      'form_submitted',
      'booking_created',
      'booking_held',
    ]);
    expect(f.stages[1]!.count).toBe(0);
    expect(f.stages[1]!.stepRate).toBeCloseTo(0, 4);
  });

  it('surfaces non-canonical events as extras, ranked by count', () => {
    const f = computeFunnel(
      new Map([
        ['form_submitted', 5],
        ['booking_held', 2],
        ['booking_no_show', 4],
        ['lost', 1],
        ['custom', 7],
      ]),
    );
    expect(f.stages.map((s) => s.type)).toEqual([
      'form_submitted',
      'booking_created',
      'booking_held',
    ]);
    expect(f.extras.map((s) => `${s.type}:${s.count}`)).toEqual([
      'custom:7',
      'booking_no_show:4',
      'lost:1',
    ]);
  });

  it('returns stepRate = null when previous stage is zero (avoids divide-by-zero)', () => {
    const f = computeFunnel(
      new Map([
        ['form_submitted', 0],
        ['booking_created', 0],
        ['booking_held', 5],
      ]),
    );
    // After trim — first non-zero is booking_held only
    expect(f.stages.map((s) => s.type)).toEqual(['booking_held']);
    expect(f.stages[0]!.stepRate).toBeNull();
  });

  it('marks canonical stages canonical=true and extras canonical=false', () => {
    const f = computeFunnel(
      new Map([
        ['form_submitted', 1],
        ['booking_held', 1],
        ['booking_no_show', 1],
      ]),
    );
    for (const s of f.stages) expect(s.canonical).toBe(true);
    for (const s of f.extras) expect(s.canonical).toBe(false);
  });
});
