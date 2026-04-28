import { createHash } from 'node:crypto';

/**
 * Deterministic idempotency key for a webhook delivery. The combination of
 * source + canonicalised body is stable across retries from the same sender.
 * Optional `clientKey` lets the sender supply their own idempotency hint
 * (e.g. Zapier's request id) which we prefer when present.
 */
export function buildIdempotencyKey(args: {
  source: string;
  body: unknown;
  clientKey?: string | null;
}): string {
  if (args.clientKey && args.clientKey.length > 0) {
    return `client:${args.source}:${args.clientKey}`;
  }
  const canonical = canonicalize(args.body);
  return `hash:${args.source}:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Stringify with sorted keys so two equivalent payloads produce the same hash
 * regardless of key insertion order.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
