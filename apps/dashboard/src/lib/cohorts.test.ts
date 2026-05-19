import { describe, expect, it } from 'vitest';
import { computeCohorts } from './cohorts';

const NOW = new Date('2026-05-15T00:00:00Z');

function leadsFor(entries: Array<[string, string]>): Map<string, Date> {
  return new Map(entries.map(([id, iso]) => [id, new Date(iso)]));
}

describe('computeCohorts', () => {
  it('returns empty rows when no entries', () => {
    const rows = computeCohorts({
      entries: new Map(),
      targets: new Map(),
      bucket: 'week',
      columns: [0, 7, 14],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it('buckets entries by ISO week (Monday start)', () => {
    // 2026-04-06 is a Monday — both leads land in the same cohort.
    const entries = leadsFor([
      ['a', '2026-04-06T10:00:00Z'],
      ['b', '2026-04-12T18:00:00Z'], // Sunday — same week
      ['c', '2026-04-13T08:00:00Z'], // next Monday — new cohort
    ]);
    const rows = computeCohorts({
      entries,
      targets: new Map(),
      bucket: 'week',
      columns: [0],
      now: NOW,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cohortStart).toBe('2026-04-06');
    expect(rows[0]!.cohortSize).toBe(2);
    expect(rows[1]!.cohortStart).toBe('2026-04-13');
    expect(rows[1]!.cohortSize).toBe(1);
  });

  it('buckets entries by calendar month', () => {
    const entries = leadsFor([
      ['a', '2026-03-31T23:00:00Z'],
      ['b', '2026-04-01T00:30:00Z'],
      ['c', '2026-04-15T12:00:00Z'],
    ]);
    const rows = computeCohorts({
      entries,
      targets: new Map(),
      bucket: 'month',
      columns: [0],
      now: NOW,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cohortStart).toBe('2026-03-01');
    expect(rows[1]!.cohortStart).toBe('2026-04-01');
    expect(rows[1]!.cohortSize).toBe(2);
  });

  it('counts conversions at each column offset (cumulative)', () => {
    const entries = leadsFor([
      ['a', '2026-04-06T00:00:00Z'],
      ['b', '2026-04-07T00:00:00Z'],
      ['c', '2026-04-08T00:00:00Z'],
      ['d', '2026-04-09T00:00:00Z'],
    ]);
    const targets = leadsFor([
      ['a', '2026-04-09T00:00:00Z'], // a converts after 3 days
      ['b', '2026-04-21T00:00:00Z'], // b converts after 14 days
      ['c', '2026-05-01T00:00:00Z'], // c converts after 23 days
      // d never converts
    ]);
    const rows = computeCohorts({
      entries,
      targets,
      bucket: 'week',
      columns: [0, 7, 14, 21, 28],
      now: NOW,
    });
    const cohort = rows[0]!;
    expect(cohort.cohortSize).toBe(4);
    // Day 0: none converted (a needed 3 days)
    expect(cohort.cells[0]!.converted).toBe(0);
    // Day 7: just a
    expect(cohort.cells[1]!.converted).toBe(1);
    expect(cohort.cells[1]!.rate).toBeCloseTo(0.25, 4);
    // Day 14: a + b
    expect(cohort.cells[2]!.converted).toBe(2);
    expect(cohort.cells[2]!.rate).toBeCloseTo(0.5, 4);
    // Day 21: a + b (c is 23 days, still not in)
    expect(cohort.cells[3]!.converted).toBe(2);
    // Day 28: a + b + c
    expect(cohort.cells[4]!.converted).toBe(3);
    expect(cohort.cells[4]!.rate).toBeCloseTo(0.75, 4);
  });

  it('marks cells as TBD when the cohort has not aged enough', () => {
    // Cohort started 10 days ago. Asking about day 30 is meaningless yet.
    const entryAt = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    const entries = new Map([['a', entryAt]]);
    const rows = computeCohorts({
      entries,
      targets: new Map(),
      bucket: 'week',
      columns: [0, 7, 14, 21, 28],
      now: NOW,
    });
    const cohort = rows[0]!;
    // Bucket end is approximately Monday after entryAt, ~3-6 days ago.
    // Youngest lead's age = today - bucketEnd ≈ 4 days. So day 0 is
    // resolved (4 > 0), day 7+ is TBD (4 < 7).
    expect(cohort.cells[0]!.converted).toBe(0); // day 0 resolved
    expect(cohort.cells[1]!.converted).toBeNull(); // day 7 TBD
    expect(cohort.cells[1]!.rate).toBeNull();
    expect(cohort.cells[4]!.converted).toBeNull(); // day 28 TBD
  });

  it('ignores conversions that pre-date entry (data hygiene)', () => {
    const entries = leadsFor([['a', '2026-04-10T00:00:00Z']]);
    const targets = leadsFor([['a', '2026-04-05T00:00:00Z']]); // before entry
    const rows = computeCohorts({
      entries,
      targets,
      bucket: 'week',
      columns: [0, 7, 14],
      now: NOW,
    });
    // No conversions counted.
    for (const cell of rows[0]!.cells) {
      if (cell.converted != null) expect(cell.converted).toBe(0);
    }
  });

  it('orders rows ascending by cohort start', () => {
    const entries = leadsFor([
      ['a', '2026-04-20T00:00:00Z'],
      ['b', '2026-04-06T00:00:00Z'],
      ['c', '2026-04-13T00:00:00Z'],
    ]);
    const rows = computeCohorts({
      entries,
      targets: new Map(),
      bucket: 'week',
      columns: [0],
      now: NOW,
    });
    expect(rows.map((r) => r.cohortStart)).toEqual([
      '2026-04-06',
      '2026-04-13',
      '2026-04-20',
    ]);
  });
});
