/**
 * Apply a Zod-validated Plan to the database. The caller is the worker
 * (webhook ingest route or cron sweeper). Uses a service-role client so
 * RLS is bypassed; we still scope every query by `company_id` to be safe.
 *
 * Idempotency notes:
 *   - Leads upsert on (company_id, email) or (company_id, phone).
 *   - Bookings upsert on (company_id, external_id) when external_id present.
 *   - Field proposals upsert on (company_id, entity, field_key).
 *   - Lead events are always inserted (append-only). Replays are guarded
 *     at the inbox level by `webhook_inbox.idempotency_key`, not here.
 *
 * This function is not transactional across tables. Operations are ordered
 * so a partial-write retry converges on the same final state. If we ever
 * need true atomicity, wrap the body in a single Postgres function.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from 'db/types';
import {
  normalizeCurrency,
  normalizeDate,
  normalizeEmail,
  normalizeMoney,
  normalizePhone,
} from './normalize';
import type {
  AttributionInput,
  BookingInput,
  DealInput,
  FieldProposalInput,
  LeadEventInput,
  Plan,
} from './plan';

type Client = SupabaseClient<Database>;

export interface ApplyArgs {
  client: Client;
  companyId: string;
  webhookInboxId: string;
  source: string;
  /** ISO-3166-1 alpha-2 default country for phone parsing (usually company's). */
  defaultCountry?: string;
  plan: Plan;
}

export interface AppliedChanges {
  ignored: boolean;
  ignoreReason?: string;
  leadId?: string;
  bookingId?: string;
  previousBookingId?: string;
  dealId?: string;
  eventIds: string[];
  proposalIds: string[];
  warnings: string[];
  /** The ad_id stamped on lead_events for this run, if any. */
  attributedAdId?: string;
  /** Strategy that resolved the ad (e.g. 'utm_content_external_id'). */
  attributedVia?: string;
}

export async function applyPlan(args: ApplyArgs): Promise<AppliedChanges> {
  const { client, companyId, plan, source, defaultCountry } = args;
  const out: AppliedChanges = {
    ignored: false,
    eventIds: [],
    proposalIds: [],
    warnings: [],
  };

  if (plan.action === 'ignore') {
    out.ignored = true;
    out.ignoreReason = plan.ignore_reason;
    return out;
  }

  // ------------------------------------------------------------------
  // 1. Resolve / upsert the lead
  // ------------------------------------------------------------------
  const lead = await upsertLead(client, companyId, plan, source, defaultCountry, out.warnings);
  if (!lead) {
    out.ignored = true;
    out.ignoreReason = 'no lead identity could be resolved (missing email/phone)';
    return out;
  }
  out.leadId = lead.id;

  // The lead may already carry an attributed ad from an earlier visit.
  let attributedAdId: string | undefined = lead.attributed_ad_id ?? undefined;
  let attributedVia: string | undefined = lead.attributed_via ?? undefined;

  // ------------------------------------------------------------------
  // 2. Booking (with reschedule chain)
  // ------------------------------------------------------------------
  if (plan.booking) {
    const result = await upsertBooking(
      client,
      companyId,
      lead.id,
      plan.booking,
      source,
      out.warnings,
    );
    if (result) {
      out.bookingId = result.bookingId;
      out.previousBookingId = result.previousBookingId;
    }
  }

  // ------------------------------------------------------------------
  // 3. Deal
  // ------------------------------------------------------------------
  if (plan.deal) {
    const dealId = await upsertDeal(client, companyId, lead.id, plan.deal, out.warnings);
    if (dealId) out.dealId = dealId;
  }

  // ------------------------------------------------------------------
  // 4. Attribution — run BEFORE events so events get the ad_id stamp.
  // ------------------------------------------------------------------
  if (plan.attribution && hasAnyAttribution(plan.attribution)) {
    const matched = await insertAttribution(
      client,
      companyId,
      lead.id,
      plan.attribution,
    );
    if (matched.adId && !attributedAdId) {
      attributedAdId = matched.adId;
      attributedVia = matched.strategy ?? attributedVia;
    }
  }

  if (attributedAdId) {
    out.attributedAdId = attributedAdId;
    out.attributedVia = attributedVia;
  }

  // ------------------------------------------------------------------
  // 5. Events (append-only)
  // ------------------------------------------------------------------
  if (plan.events.length > 0) {
    const ids = await insertEvents(
      client,
      companyId,
      lead.id,
      plan.events,
      {
        bookingId: out.bookingId,
        dealId: out.dealId,
        adId: attributedAdId,
      },
      source,
    );
    out.eventIds.push(...ids);
  }

  // ------------------------------------------------------------------
  // 6. Field proposals
  // ------------------------------------------------------------------
  if (plan.field_proposals.length > 0) {
    const ids = await upsertFieldProposals(client, companyId, plan.field_proposals);
    out.proposalIds.push(...ids);
  }

  return out;
}

// =====================================================================
// Lead upsert
// =====================================================================

interface UpsertedLead {
  id: string;
  attributed_ad_id: string | null;
  attributed_via: string | null;
}

async function upsertLead(
  client: Client,
  companyId: string,
  plan: Plan,
  source: string,
  defaultCountry: string | undefined,
  warnings: string[],
): Promise<UpsertedLead | null> {
  const rawEmail = plan.lead_typed.email ?? plan.lead_identity.email;
  const rawPhone = plan.lead_typed.phone ?? plan.lead_identity.phone;
  const email = normalizeEmail(rawEmail);
  const phone = normalizePhone(rawPhone, defaultCountry);

  if (rawEmail && !email) warnings.push(`unparseable email: ${rawEmail}`);
  if (rawPhone && !phone) warnings.push(`unparseable phone: ${rawPhone}`);

  if (!email && !phone) return null;

  const existing = await findLead(client, companyId, email, phone);
  const typed = {
    email: email ?? existing?.email ?? null,
    phone: phone ?? existing?.phone ?? null,
    first_name: plan.lead_typed.first_name ?? plan.lead_identity.first_name ?? existing?.first_name ?? null,
    last_name: plan.lead_typed.last_name ?? plan.lead_identity.last_name ?? existing?.last_name ?? null,
    source: plan.lead_typed.source ?? existing?.source ?? source,
  };
  const mergedAttributes = mergeJson(existing?.attributes, plan.lead_attributes);

  if (existing) {
    const { error } = await client
      .from('leads')
      .update({ ...typed, attributes: mergedAttributes })
      .eq('id', existing.id)
      .eq('company_id', companyId);
    if (error) throw new Error(`lead update failed: ${error.message}`);
    return {
      id: existing.id,
      attributed_ad_id: existing.attributed_ad_id ?? null,
      attributed_via: existing.attributed_via ?? null,
    };
  }

  const { data, error } = await client
    .from('leads')
    .insert({ company_id: companyId, ...typed, attributes: mergedAttributes })
    .select('id')
    .single();
  if (error) throw new Error(`lead insert failed: ${error.message}`);
  return { id: data.id, attributed_ad_id: null, attributed_via: null };
}

interface ExistingLead {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  source: string | null;
  attributes: Json;
  attributed_ad_id: string | null;
  attributed_via: string | null;
}

async function findLead(
  client: Client,
  companyId: string,
  email: string | null,
  phone: string | null,
): Promise<ExistingLead | null> {
  const select =
    'id,email,phone,first_name,last_name,source,attributes,attributed_ad_id,attributed_via';
  if (email) {
    const { data } = await client
      .from('leads')
      .select(select)
      .eq('company_id', companyId)
      .eq('email', email)
      .maybeSingle();
    if (data) return data as unknown as ExistingLead;
  }
  if (phone) {
    const { data } = await client
      .from('leads')
      .select(select)
      .eq('company_id', companyId)
      .eq('phone', phone)
      .maybeSingle();
    if (data) return data as unknown as ExistingLead;
  }
  return null;
}

// =====================================================================
// Booking upsert (with reschedule chain)
// =====================================================================

async function upsertBooking(
  client: Client,
  companyId: string,
  leadId: string,
  input: BookingInput,
  source: string,
  warnings: string[],
): Promise<{ bookingId: string; previousBookingId?: string } | null> {
  const scheduledAt = input.scheduled_at ? normalizeDate(input.scheduled_at) : null;
  if (input.scheduled_at && !scheduledAt) {
    warnings.push(`unparseable booking.scheduled_at: ${input.scheduled_at}`);
  }

  // Resolve previous booking (for reschedule chains).
  let previousBookingId: string | undefined;
  if (input.previous_external_id) {
    const { data } = await client
      .from('bookings')
      .select('id, scheduled_at, status')
      .eq('company_id', companyId)
      .eq('external_id', input.previous_external_id)
      .maybeSingle();

    if (data) {
      previousBookingId = data.id;
      // Only flip the previous to 'rescheduled' if its time hasn't passed —
      // otherwise it stays at its existing status (likely no_show).
      const oldTime = data.scheduled_at ? new Date(data.scheduled_at).getTime() : 0;
      if (oldTime > Date.now() && data.status === 'scheduled') {
        await client
          .from('bookings')
          .update({
            status: 'rescheduled',
            status_set_at: new Date().toISOString(),
            status_source: `webhook:${source}`,
          })
          .eq('id', data.id)
          .eq('company_id', companyId);
      }
    }
  }

  // Find existing booking by external_id.
  let existingId: string | null = null;
  if (input.external_id) {
    const { data } = await client
      .from('bookings')
      .select('id')
      .eq('company_id', companyId)
      .eq('external_id', input.external_id)
      .maybeSingle();
    if (data) existingId = data.id;
  }

  const row = {
    company_id: companyId,
    lead_id: leadId,
    previous_booking_id: previousBookingId ?? null,
    external_id: input.external_id ?? null,
    meeting_type: input.meeting_type ?? null,
    scheduled_at: scheduledAt,
    status: input.status ?? 'scheduled',
    status_set_at: new Date().toISOString(),
    status_source: `webhook:${source}`,
    duration_minutes: input.duration_minutes ?? null,
    attributes: input.attributes as Json,
  };

  if (!row.scheduled_at && !existingId) {
    warnings.push('booking skipped: no scheduled_at');
    return null;
  }

  if (existingId) {
    // Don't clobber attributes; merge.
    const { data: prev } = await client
      .from('bookings')
      .select('attributes')
      .eq('id', existingId)
      .single();
    const merged = mergeJson(prev?.attributes ?? null, input.attributes);
    const { error } = await client
      .from('bookings')
      .update({ ...row, attributes: merged })
      .eq('id', existingId)
      .eq('company_id', companyId);
    if (error) throw new Error(`booking update failed: ${error.message}`);
    return { bookingId: existingId, previousBookingId };
  }

  const { data, error } = await client
    .from('bookings')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(`booking insert failed: ${error.message}`);
  return { bookingId: data.id, previousBookingId };
}

// =====================================================================
// Deal upsert
// =====================================================================

async function upsertDeal(
  client: Client,
  companyId: string,
  leadId: string,
  input: DealInput,
  warnings: string[],
): Promise<string | null> {
  // Resolve stage_key → stage_id if provided.
  let stageId: string | null = null;
  if (input.stage_key) {
    const { data: stage } = await client
      .from('pipeline_stages')
      .select('id')
      .eq('company_id', companyId)
      .eq('key', input.stage_key)
      .maybeSingle();
    if (!stage) {
      warnings.push(`unknown pipeline stage: ${input.stage_key}`);
      return null;
    }
    stageId = stage.id;
  }

  const amount = input.amount != null ? normalizeMoney(input.amount) : null;
  const currency = normalizeCurrency(input.currency ?? null);
  const closedAt = input.closed_at ? normalizeDate(input.closed_at) : null;

  // Find an existing open deal for this lead — assumption: one open at a time.
  const { data: existing } = await client
    .from('deals')
    .select('id, stage_id, attributes')
    .eq('company_id', companyId)
    .eq('lead_id', leadId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    const merged = mergeJson(existing.attributes, input.attributes);
    const fromStageId = existing.stage_id;
    const toStageId = stageId ?? fromStageId;
    const update: Record<string, unknown> = {
      stage_id: toStageId,
      attributes: merged,
    };
    if (input.status) update.status = input.status;
    if (amount != null) update.amount = amount;
    if (currency) update.currency = currency;
    if (closedAt) update.closed_at = closedAt;

    const { error } = await client
      .from('deals')
      .update(update)
      .eq('id', existing.id)
      .eq('company_id', companyId);
    if (error) throw new Error(`deal update failed: ${error.message}`);

    // Stage history when the stage changed.
    if (stageId && stageId !== fromStageId) {
      await client.from('deal_stage_history').insert({
        company_id: companyId,
        deal_id: existing.id,
        from_stage_id: fromStageId,
        to_stage_id: stageId,
        source: 'webhook',
      });
    }
    return existing.id;
  }

  // New deal — must have a stage_id.
  if (!stageId) {
    warnings.push('deal skipped: no stage_key on new deal');
    return null;
  }

  const { data, error } = await client
    .from('deals')
    .insert({
      company_id: companyId,
      lead_id: leadId,
      stage_id: stageId,
      status: input.status ?? 'open',
      amount,
      currency,
      closed_at: closedAt,
      attributes: input.attributes as Json,
    })
    .select('id')
    .single();
  if (error) throw new Error(`deal insert failed: ${error.message}`);

  await client.from('deal_stage_history').insert({
    company_id: companyId,
    deal_id: data.id,
    from_stage_id: null,
    to_stage_id: stageId,
    source: 'webhook',
  });
  return data.id;
}

// =====================================================================
// Events
// =====================================================================

async function insertEvents(
  client: Client,
  companyId: string,
  leadId: string,
  events: LeadEventInput[],
  refs: { bookingId?: string; dealId?: string; adId?: string },
  source: string,
): Promise<string[]> {
  const rows = events.map((e) => ({
    company_id: companyId,
    lead_id: leadId,
    event_type: e.type,
    event_subtype: e.subtype ?? null,
    occurred_at: e.occurred_at ? (normalizeDate(e.occurred_at) ?? new Date().toISOString()) : new Date().toISOString(),
    booking_id: refs.bookingId ?? null,
    deal_id: refs.dealId ?? null,
    ad_id: refs.adId ?? null,
    amount: e.amount != null ? normalizeMoney(e.amount) : null,
    currency: normalizeCurrency(e.currency ?? null),
    attributes: e.attributes as Json,
    source: `webhook:${source}`,
  }));

  const { data, error } = await client.from('lead_events').insert(rows).select('id');
  if (error) throw new Error(`lead_events insert failed: ${error.message}`);
  return (data ?? []).map((r) => r.id);
}

// =====================================================================
// Attribution
// =====================================================================

function hasAnyAttribution(a: AttributionInput): boolean {
  return Boolean(
    a.fbclid ||
      a.utm_source ||
      a.utm_medium ||
      a.utm_campaign ||
      a.utm_content ||
      a.utm_term ||
      a.landing_url ||
      a.referrer_url,
  );
}

interface AttributionResult {
  attributionId?: string;
  adId?: string;
  strategy?: string;
}

async function insertAttribution(
  client: Client,
  companyId: string,
  leadId: string,
  attr: AttributionInput,
): Promise<AttributionResult> {
  const { data: inserted, error } = await client
    .from('lead_attribution')
    .insert({
      company_id: companyId,
      lead_id: leadId,
      fbclid: attr.fbclid ?? null,
      utm_source: attr.utm_source ?? null,
      utm_medium: attr.utm_medium ?? null,
      utm_campaign: attr.utm_campaign ?? null,
      utm_content: attr.utm_content ?? null,
      utm_term: attr.utm_term ?? null,
      landing_url: attr.landing_url ?? null,
      referrer_url: attr.referrer_url ?? null,
    })
    .select('id')
    .single();

  if (error || !inserted) return {};

  // Run the SQL match. Idempotent and side-effect-bounded: only updates
  // the attribution row + (first time only) the lead's attributed_ad_id.
  const { data: matched } = await client.rpc('match_and_stamp_lead_attribution', {
    p_attribution_id: inserted.id,
  });
  const row = (matched?.[0] ?? null) as
    | { matched_ad_id: string | null; strategy: string | null }
    | null;

  return {
    attributionId: inserted.id,
    adId: row?.matched_ad_id ?? undefined,
    strategy: row?.strategy ?? undefined,
  };
}

// =====================================================================
// Field proposals
// =====================================================================

async function upsertFieldProposals(
  client: Client,
  companyId: string,
  proposals: FieldProposalInput[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const p of proposals) {
    // Try increment-on-conflict first (the unique constraint added in
    // migration 20260101000007 is what makes this idempotent).
    const { data: existing } = await client
      .from('field_proposals')
      .select('id, occurrence_count, status')
      .eq('company_id', companyId)
      .eq('entity', p.entity)
      .eq('field_key', p.field_key)
      .maybeSingle();

    if (existing) {
      // Don't disturb decided proposals — but always bump last_seen_at so
      // the operator can tell whether a rejected key is still arriving.
      if (existing.status === 'pending') {
        await client
          .from('field_proposals')
          .update({
            occurrence_count: existing.occurrence_count + 1,
            last_seen_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await client
          .from('field_proposals')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', existing.id);
      }
      ids.push(existing.id);
      continue;
    }

    const { data, error } = await client
      .from('field_proposals')
      .insert({
        company_id: companyId,
        proposal_kind: 'attribute',
        entity: p.entity,
        field_key: p.field_key,
        example_value: p.example_value as Json,
        inferred_type: p.inferred_type,
        occurrence_count: 1,
        notes: p.rationale ?? null,
      })
      .select('id')
      .single();
    if (error) throw new Error(`field_proposals insert failed: ${error.message}`);
    ids.push(data.id);
  }
  return ids;
}

// =====================================================================
// Helpers
// =====================================================================

function mergeJson(existing: Json | null | undefined, incoming: Record<string, unknown>): Json {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...incoming } as Json;
}
