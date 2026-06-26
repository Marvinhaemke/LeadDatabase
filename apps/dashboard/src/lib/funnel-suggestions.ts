/**
 * Funnel-suggestion clustering.
 *
 * Given recent `lead_attribution` rows, group by (utm_campaign, URL path)
 * — coarse enough to merge `/vsl?ref=a` and `/vsl?ref=b`, fine enough to
 * separate `/vsl` from `/quiz` under the same campaign. Return the top
 * clusters by size so an operator can one-click pre-fill a funnel form
 * from a real observed group.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'db/types';
import type { FilterCondition } from 'ai/funnel-rules';

type Client = SupabaseClient<Database>;

export interface FunnelSuggestion {
  /** Stable identifier used as the React key + the "use this" button query string. */
  id: string;
  label: string;
  rowCount: number;
  /** Pre-built filter rules that would match this cluster. */
  filters: FilterCondition[];
}

export async function getFunnelSuggestions(
  client: Client,
  companyId: string,
  sinceDays = 60,
  limit = 6,
): Promise<FunnelSuggestion[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - sinceDays);

  const { data } = await client
    .from('lead_attribution')
    .select('utm_source, utm_campaign, landing_url, fbclid')
    .eq('company_id', companyId)
    .gte('captured_at', since.toISOString())
    .limit(2000);

  type Row = {
    utm_source: string | null;
    utm_campaign: string | null;
    landing_url: string | null;
    fbclid: string | null;
  };

  const groups = new Map<
    string,
    { campaign: string | null; path: string | null; source: string | null; count: number }
  >();
  for (const r of (data ?? []) as Row[]) {
    const path = normalisePath(r.landing_url);
    const campaign = (r.utm_campaign ?? '').trim().toLowerCase() || null;
    const source = inferredSource(r);
    const key = `${campaign ?? '_'}::${path ?? '_'}::${source ?? '_'}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { campaign, path, source, count: 1 });
  }

  const ranked = [...groups.values()]
    // Only suggest clusters with at least 3 rows — single-row clusters are noise.
    .filter((g) => g.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return ranked.map((g, i) => {
    const labelParts: string[] = [];
    if (g.source) labelParts.push(g.source);
    if (g.campaign) labelParts.push(g.campaign);
    if (g.path) labelParts.push(g.path);
    const label = labelParts.join(' · ') || `cluster ${i + 1}`;

    const filters: FilterCondition[] = [];
    if (g.source === 'meta') {
      filters.push({ field: 'fbclid', op: 'is_set' });
    } else if (g.source) {
      filters.push({ field: 'utm_source', op: 'eq', value: g.source });
    }
    if (g.campaign) {
      filters.push({ field: 'utm_campaign', op: 'eq', value: g.campaign });
    }
    if (g.path) {
      filters.push({ field: 'landing_url', op: 'contains', value: g.path });
    }
    if (filters.length === 0) {
      // Pathological cluster — skip it.
      return null;
    }

    return {
      id: `s${i}`,
      label,
      rowCount: g.count,
      filters,
    };
  }).filter(Boolean) as FunnelSuggestion[];
}

function inferredSource(r: {
  utm_source: string | null;
  fbclid: string | null;
}): string | null {
  if (r.fbclid && r.fbclid.trim().length > 0) return 'meta';
  const s = r.utm_source?.trim().toLowerCase();
  return s && s.length > 0 ? s : null;
}

function normalisePath(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return path || '/';
  } catch {
    // Already a path or malformed — best-effort strip the query string.
    const q = url.indexOf('?');
    const trimmed = (q === -1 ? url : url.slice(0, q)).trim();
    if (!trimmed) return null;
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
}
