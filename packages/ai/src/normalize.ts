/**
 * Deterministic normalizers.
 *
 * Anything format-sensitive (phone, email, dates, money) goes through here,
 * NOT through the LLM. The LLM picks which field is which; the parsing
 * itself is rule-based so we get reproducible results across replays.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // Cheap shape check; full RFC 5322 parsing isn't useful at this layer.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Normalize a phone string to E.164. Falls back to null if unparseable.
 * Pass `defaultCountry` (ISO-3166-1 alpha-2) to disambiguate national-format
 * numbers — usually the company's country.
 */
export function normalizePhone(
  input: string | null | undefined,
  defaultCountry?: string,
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(
    trimmed,
    defaultCountry as Parameters<typeof parsePhoneNumberFromString>[1],
  );
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Best-effort date normalization to an ISO 8601 string with timezone.
 * Accepts:
 *   - ISO strings (returned as-is, normalized to T separator)
 *   - Common locale formats (DD.MM.YYYY, MM/DD/YYYY) when unambiguous
 *   - Numeric epoch seconds or millis
 * Returns null if nothing safe can be inferred.
 */
export function normalizeDate(input: unknown): string | null {
  if (input == null) return null;

  if (typeof input === 'number') {
    const ms = input < 1e12 ? input * 1000 : input;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  if (ISO_RE.test(s)) {
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // DD.MM.YYYY [HH:mm[:ss]]
  const dotMatch = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dotMatch) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = dotMatch;
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`).toISOString();
  }

  // Fallback to Date constructor; reject obvious nonsense (it's permissive).
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // Reject years before 2000 / after 2100 — almost always a parse error.
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return d.toISOString();
}

/**
 * Money string → number. Strips currency symbols, thousands separators.
 * Detects "1.234,56" (German) vs "1,234.56" (US) by which separator is last.
 */
export function normalizeMoney(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;

  let s = input.trim().replace(/[^\d.,\-]/g, '');
  if (!s) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) {
      // German: 1.234,56
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US: 1,234.56
      s = s.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only commas — assume decimal separator if exactly one and ≤2 digits after.
    const afterComma = s.length - lastComma - 1;
    if (s.indexOf(',') === lastComma && afterComma <= 2) {
      s = s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a 3-letter currency code. Accepts mixed case; rejects anything else.
 */
export function normalizeCurrency(input: string | null | undefined): string | null {
  if (!input) return null;
  const upper = input.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}
