'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createSupabaseAdminClient } from 'db/admin';
import {
  FilterSchema,
  type AttributionContext,
  type FilterCondition,
  matchFunnel,
  type FunnelDefinition,
} from 'ai/funnel-rules';
import { deriveFunnelKey } from 'ai';
import { getCurrentUser } from '@/lib/auth';

async function requireCompanyAdmin(slug: string) {
  const user = await getCurrentUser();
  if (!user) throw new Error('unauthorized');
  if (user.role !== 'admin' && user.companySlug !== slug) {
    throw new Error('forbidden');
  }
  return user;
}

// ----------------------------------------------------------------------------
// Form payload parsing
// ----------------------------------------------------------------------------

const FormSchema = z
  .object({
    label: z.string().trim().min(1, 'label is required').max(200),
    key: z
      .string()
      .trim()
      .min(1, 'key is required')
      .max(120)
      .regex(/^[a-z0-9_-]+$/, 'key may only contain lowercase letters, digits, underscores, hyphens'),
    description: z.string().trim().max(2000).optional().nullable(),
    priority: z.coerce.number().int().min(0).max(10_000),
    filters: z.array(FilterSchema).min(1, 'add at least one filter'),
  })
  .strict();

function parseForm(formData: FormData) {
  const filtersRaw = String(formData.get('filters') ?? '[]');
  let filtersParsed: unknown;
  try {
    filtersParsed = JSON.parse(filtersRaw);
  } catch {
    return { ok: false as const, error: 'filters JSON malformed' };
  }
  const parsed = FormSchema.safeParse({
    label: formData.get('label') ?? '',
    key: formData.get('key') ?? '',
    description: formData.get('description') ?? null,
    priority: formData.get('priority') ?? 100,
    filters: filtersParsed,
  });
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true as const, data: parsed.data };
}

// ----------------------------------------------------------------------------
// CRUD
// ----------------------------------------------------------------------------

export async function createFunnel(formData: FormData): Promise<void> {
  const slug = String(formData.get('company_slug') ?? '');
  const user = await requireCompanyAdmin(slug);

  const parsed = parseForm(formData);
  if (!parsed.ok) {
    redirect(`/${slug}/funnels/new?error=${encodeURIComponent(parsed.error)}`);
  }

  const admin = createSupabaseAdminClient();
  const company = await resolveCompanyId(admin, slug);

  const { error } = await admin.from('funnel_definitions').insert({
    company_id: company,
    key: parsed.data.key,
    label: parsed.data.label,
    description: parsed.data.description || null,
    priority: parsed.data.priority,
    filters: parsed.data.filters,
    created_by: user.userId,
  });
  if (error) {
    const message =
      error.code === '23505'
        ? `a funnel with key "${parsed.data.key}" already exists`
        : error.message;
    redirect(`/${slug}/funnels/new?error=${encodeURIComponent(message)}`);
  }

  const updated = await rematchForCompany(slug);
  revalidatePath(`/${slug}/funnels`);
  redirect(
    `/${slug}/funnels?created=${encodeURIComponent(parsed.data.key)}&rematched=${updated}`,
  );
}

export async function updateFunnel(formData: FormData): Promise<void> {
  const slug = String(formData.get('company_slug') ?? '');
  const id = String(formData.get('funnel_id') ?? '');
  await requireCompanyAdmin(slug);
  if (!id) throw new Error('funnel_id missing');

  const parsed = parseForm(formData);
  if (!parsed.ok) {
    redirect(`/${slug}/funnels/${id}?error=${encodeURIComponent(parsed.error)}`);
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('funnel_definitions')
    .update({
      key: parsed.data.key,
      label: parsed.data.label,
      description: parsed.data.description || null,
      priority: parsed.data.priority,
      filters: parsed.data.filters,
    })
    .eq('id', id);
  if (error) {
    const message =
      error.code === '23505'
        ? `a funnel with key "${parsed.data.key}" already exists`
        : error.message;
    redirect(`/${slug}/funnels/${id}?error=${encodeURIComponent(message)}`);
  }

  const updated = await rematchForCompany(slug);
  revalidatePath(`/${slug}/funnels`);
  redirect(
    `/${slug}/funnels?updated=${encodeURIComponent(parsed.data.key)}&rematched=${updated}`,
  );
}

export async function archiveFunnel(formData: FormData): Promise<void> {
  const slug = String(formData.get('company_slug') ?? '');
  const id = String(formData.get('funnel_id') ?? '');
  await requireCompanyAdmin(slug);
  if (!id) throw new Error('funnel_id missing');

  const admin = createSupabaseAdminClient();
  await admin
    .from('funnel_definitions')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id);

  const updated = await rematchForCompany(slug);
  revalidatePath(`/${slug}/funnels`);
  redirect(`/${slug}/funnels?archived=1&rematched=${updated}`);
}

export async function restoreFunnel(formData: FormData): Promise<void> {
  const slug = String(formData.get('company_slug') ?? '');
  const id = String(formData.get('funnel_id') ?? '');
  await requireCompanyAdmin(slug);
  if (!id) throw new Error('funnel_id missing');

  const admin = createSupabaseAdminClient();
  await admin.from('funnel_definitions').update({ archived_at: null }).eq('id', id);
  const updated = await rematchForCompany(slug);
  revalidatePath(`/${slug}/funnels`);
  redirect(`/${slug}/funnels?restored=1&rematched=${updated}`);
}

// ----------------------------------------------------------------------------
// Rematch: re-stamp lead_events.funnel_key for the current rule set
// ----------------------------------------------------------------------------

/**
 * Iterate every event for the company, build its attribution context
 * (the lead's most-recent attribution at-or-before the event's
 * occurred_at, plus the resolved ad/campaign external_ids when the
 * event has an ad_id), and re-evaluate the active funnel rules. If
 * the rules return a key, write it; if not, fall back to
 * deriveFunnelKey from the same context. Only writes when the result
 * differs from what's already on the event.
 *
 * For the synthetic-seed scale (~300 events) this is well under a
 * second. At thousands of events it would belong in a worker / RPC.
 */
export async function rematchFunnels(formData: FormData): Promise<void> {
  const slug = String(formData.get('company_slug') ?? '');
  await requireCompanyAdmin(slug);
  const updated = await rematchForCompany(slug);
  revalidatePath(`/${slug}/funnels`);
  redirect(`/${slug}/funnels?rematched=${updated}`);
}

/**
 * Re-stamp every lead_event for the company under the current rule set.
 * Returns the number of events whose `funnel_key` actually changed (so
 * the operator sees a meaningful count after every save). Caller is
 * responsible for the redirect/revalidation.
 *
 * IMPORTANT: this is auth-trusted on entry — only call from server
 * actions that have already passed requireCompanyAdmin(slug).
 */
async function rematchForCompany(slug: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const companyId = await resolveCompanyId(admin, slug);

  const { data: funnelsRaw } = await admin
    .from('funnel_definitions')
    .select('id, key, label, priority, filters')
    .eq('company_id', companyId)
    .is('archived_at', null)
    .order('priority', { ascending: true });
  const funnels = (funnelsRaw ?? []) as FunnelDefinition[];

  const { data: events } = await admin
    .from('lead_events')
    .select('id, lead_id, occurred_at, ad_id, funnel_key')
    .eq('company_id', companyId)
    .order('occurred_at', { ascending: true });

  // Pre-fetch every attribution row for the company so the per-event
  // "most-recent at or before" lookup is in-memory rather than N queries.
  const { data: attrRows } = await admin
    .from('lead_attribution')
    .select(
      'lead_id, fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_url, referrer_url, captured_at',
    )
    .eq('company_id', companyId)
    .order('captured_at', { ascending: true });

  const attrsByLead = new Map<string, Array<Record<string, unknown>>>();
  for (const r of (attrRows ?? []) as Array<Record<string, unknown>>) {
    const leadId = String(r.lead_id);
    let arr = attrsByLead.get(leadId);
    if (!arr) {
      arr = [];
      attrsByLead.set(leadId, arr);
    }
    arr.push(r);
  }

  // Resolve external_ids for every ad referenced by any event.
  const adIds = new Set<string>();
  for (const e of (events ?? []) as Array<{ ad_id: string | null }>) {
    if (e.ad_id) adIds.add(e.ad_id);
  }
  const adExternalById = new Map<string, { ad: string | null; campaign: string | null }>();
  if (adIds.size > 0) {
    const { data: adRows } = await admin
      .from('ads')
      .select('id, external_id, ad_sets:ad_set_id ( campaigns:campaign_id ( external_id ) )')
      .in('id', [...adIds])
      .eq('company_id', companyId);
    for (const ad of (adRows ?? []) as Array<{
      id: string;
      external_id: string | null;
      ad_sets: unknown;
    }>) {
      const adSets = ad.ad_sets;
      const adSet = Array.isArray(adSets)
        ? (adSets[0] as { campaigns?: unknown } | undefined)
        : (adSets as { campaigns?: unknown } | undefined);
      const camps = adSet?.campaigns;
      const camp = Array.isArray(camps)
        ? (camps[0] as { external_id?: string } | undefined)
        : (camps as { external_id?: string } | undefined);
      adExternalById.set(ad.id, {
        ad: ad.external_id ?? null,
        campaign: camp?.external_id ?? null,
      });
    }
  }

  let updated = 0;
  for (const evt of (events ?? []) as Array<{
    id: string;
    lead_id: string;
    occurred_at: string;
    ad_id: string | null;
    funnel_key: string | null;
  }>) {
    const ctx = buildContext(
      attrsByLead.get(evt.lead_id) ?? [],
      evt.occurred_at,
      evt.ad_id ? adExternalById.get(evt.ad_id) : undefined,
    );
    let nextKey: string | null = null;
    if (ctx) {
      const matched = matchFunnel(funnels, ctx);
      nextKey = matched?.key ?? deriveFunnelKey(ctx) ?? null;
    }
    if (nextKey !== evt.funnel_key) {
      await admin
        .from('lead_events')
        .update({ funnel_key: nextKey })
        .eq('id', evt.id);
      updated += 1;
    }
  }

  return updated;
}

function buildContext(
  attrs: Array<Record<string, unknown>>,
  occurredAt: string,
  adExt: { ad: string | null; campaign: string | null } | undefined,
): AttributionContext | null {
  // Most-recent attribution at-or-before occurred_at (attrs sorted ascending).
  let chosen: Record<string, unknown> | null = null;
  for (const a of attrs) {
    if (String(a.captured_at) <= occurredAt) chosen = a;
    else break;
  }
  if (!chosen && !adExt) return null;
  return {
    fbclid: (chosen?.fbclid as string | null) ?? null,
    utm_source: (chosen?.utm_source as string | null) ?? null,
    utm_medium: (chosen?.utm_medium as string | null) ?? null,
    utm_campaign: (chosen?.utm_campaign as string | null) ?? null,
    utm_content: (chosen?.utm_content as string | null) ?? null,
    utm_term: (chosen?.utm_term as string | null) ?? null,
    landing_url: (chosen?.landing_url as string | null) ?? null,
    referrer_url: (chosen?.referrer_url as string | null) ?? null,
    ad_external_id: adExt?.ad ?? null,
    campaign_external_id: adExt?.campaign ?? null,
  };
}

// ----------------------------------------------------------------------------

async function resolveCompanyId(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  slug: string,
): Promise<string> {
  const { data, error } = await admin
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .single();
  if (error || !data) throw new Error(`unknown company: ${slug}`);
  return data.id as string;
}

// Used by FilterCondition typing; keeping a re-export here so the form
// can `import { FilterCondition } from './actions'` without dragging
// the entire 'ai' package into the client bundle.
export type { FilterCondition };
