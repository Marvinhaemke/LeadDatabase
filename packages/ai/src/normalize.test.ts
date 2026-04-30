import { describe, expect, it } from 'vitest';
import {
  normalizeCurrency,
  normalizeDate,
  normalizeEmail,
  normalizeMoney,
  normalizePhone,
} from './normalize';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Example.COM  ')).toBe('foo@example.com');
  });
  it('rejects malformed', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('foo@bar')).toBeNull();
    expect(normalizeEmail('@example.com')).toBeNull();
  });
  it('returns null for empty / undefined', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('formats a German national number with default country', () => {
    expect(normalizePhone('030 12345678', 'DE')).toBe('+493012345678');
  });
  it('round-trips an E.164 input', () => {
    expect(normalizePhone('+493012345678')).toBe('+493012345678');
  });
  it('handles US numbers with default country', () => {
    expect(normalizePhone('(415) 555-2671', 'US')).toBe('+14155552671');
  });
  it('returns null for unparseable', () => {
    expect(normalizePhone('garbage')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
  it('returns null for ambiguous national numbers without a default country', () => {
    expect(normalizePhone('030 12345678')).toBeNull();
  });
});

describe('normalizeDate', () => {
  it('returns ISO for ISO inputs', () => {
    expect(normalizeDate('2026-04-15T10:30:00Z')).toBe('2026-04-15T10:30:00.000Z');
  });
  it('promotes a date-only ISO to midnight UTC', () => {
    expect(normalizeDate('2026-04-15')).toBe('2026-04-15T00:00:00.000Z');
  });
  it('parses German DD.MM.YYYY HH:mm', () => {
    expect(normalizeDate('15.04.2026 10:30')).toBe('2026-04-15T10:30:00.000Z');
  });
  it('parses DD.MM.YYYY date-only', () => {
    expect(normalizeDate('15.04.2026')).toBe('2026-04-15T00:00:00.000Z');
  });
  it('treats epoch seconds and millis correctly', () => {
    expect(normalizeDate(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(normalizeDate(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });
  it('rejects suspiciously old / future years', () => {
    expect(normalizeDate('1850-01-01')).toBeNull();
    expect(normalizeDate('2200-01-01')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(normalizeDate('not a date')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate({})).toBeNull();
  });
});

describe('normalizeMoney', () => {
  it('parses plain numbers', () => {
    expect(normalizeMoney(1234.5)).toBe(1234.5);
    expect(normalizeMoney('1234.50')).toBe(1234.5);
  });
  it('handles US thousands + decimal: 1,234.56', () => {
    expect(normalizeMoney('1,234.56')).toBe(1234.56);
  });
  it('handles German thousands + decimal: 1.234,56', () => {
    expect(normalizeMoney('1.234,56')).toBe(1234.56);
  });
  it('handles single-comma decimal: 12,50', () => {
    expect(normalizeMoney('12,50')).toBe(12.5);
  });
  it('strips currency symbols and whitespace', () => {
    expect(normalizeMoney('€ 1.234,56')).toBe(1234.56);
    expect(normalizeMoney('$1,234.56')).toBe(1234.56);
  });
  it('handles negatives', () => {
    expect(normalizeMoney('-1,234.56')).toBe(-1234.56);
  });
  it('returns null for garbage', () => {
    expect(normalizeMoney('abc')).toBeNull();
    expect(normalizeMoney(null)).toBeNull();
    expect(normalizeMoney(undefined)).toBeNull();
  });
});

describe('normalizeCurrency', () => {
  it('uppercases valid 3-letter codes', () => {
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(normalizeCurrency(' usd ')).toBe('USD');
  });
  it('rejects anything else', () => {
    expect(normalizeCurrency('euros')).toBeNull();
    expect(normalizeCurrency('US')).toBeNull();
    expect(normalizeCurrency('€')).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
  });
});
