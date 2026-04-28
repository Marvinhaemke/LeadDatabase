/**
 * The structured plan returned by Gemini Flash for each webhook payload.
 *
 * Design notes:
 *  - The model returns free-form JSON (not constrained by Gemini's
 *    `responseSchema`, which doesn't cover record / discriminated-union
 *    types we want here). Zod is the trust boundary — anything that
 *    doesn't parse is rejected and the row goes back to `pending`.
 *  - `*_attributes` carry "AI-recognised but not yet promoted" fields.
 *    The worker stores them in the entity's `attributes jsonb` column.
 *  - `field_proposals` surface unknown keys for human approval, after
 *    which a real migration promotes them to typed columns.
 *  - `events[]` is the funnel-truth output. Even if the model also
 *    asks us to update a booking/deal, the events row(s) are what
 *    drive metrics — we don't infer events from state transitions.
 */
import { z } from 'zod';

export const LEAD_EVENT_TYPES = [
  'form_submitted',
  'booking_created',
  'booking_rescheduled',
  'booking_held',
  'booking_no_show',
  'booking_cancelled',
  'qualified',
  'disqualified',
  'proposal_sent',
  'won',
  'lost',
  'refunded',
  'custom',
] as const;

export const BOOKING_STATUSES = [
  'scheduled',
  'held',
  'no_show',
  'cancelled_by_lead',
  'cancelled_by_us',
  'rescheduled',
] as const;

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;

export const ATTRIBUTE_VALUE_TYPES = [
  'text',
  'number',
  'boolean',
  'date',
  'enum',
  'json',
] as const;

const JsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([JsonScalar, z.array(JsonValue), z.record(JsonValue)]),
);

const AttributeBag = z.record(JsonValue).default({});

const LeadIdentity = z
  .object({
    email: z.string().optional(),
    phone: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    external_id: z.string().optional(),
  });

const Booking = z
  .object({
    external_id: z.string().optional(),
    meeting_type: z.string().optional(),
    scheduled_at: z.string().optional(),
    status: z.enum(BOOKING_STATUSES).optional(),
    duration_minutes: z.number().int().positive().optional(),
    /** External id of the booking this one supersedes (reschedule chain). */
    previous_external_id: z.string().optional(),
    attributes: AttributeBag,
  });

const Deal = z
  .object({
    /** Maps to pipeline_stages.key for the company. */
    stage_key: z.string().optional(),
    status: z.enum(DEAL_STATUSES).optional(),
    amount: z.number().optional(),
    currency: z.string().length(3).optional(),
    closed_at: z.string().optional(),
    attributes: AttributeBag,
  });

const LeadEvent = z
  .object({
    type: z.enum(LEAD_EVENT_TYPES),
    /** Required when type='custom'; ignored otherwise. */
    subtype: z.string().optional(),
    occurred_at: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().length(3).optional(),
    attributes: AttributeBag,
  });

const Attribution = z
  .object({
    fbclid: z.string().optional(),
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
    landing_url: z.string().optional(),
    referrer_url: z.string().optional(),
  });

const FieldProposal = z
  .object({
    entity: z.enum(['leads', 'bookings', 'deals']),
    field_key: z.string().min(1),
    example_value: JsonValue,
    inferred_type: z.enum(ATTRIBUTE_VALUE_TYPES),
    rationale: z.string().optional(),
  });

export const PlanSchema = z
  .object({
    /** 'apply' = act on it; 'ignore' = drop with reason. */
    action: z.enum(['apply', 'ignore']).default('apply'),
    ignore_reason: z.string().optional(),

    /** Identity + lead-level fields are required for any 'apply' plan. */
    lead_identity: LeadIdentity.default({}),
    lead_typed: z
      .object({
        email: z.string().optional(),
        phone: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        source: z.string().optional(),
      })
      .default({}),
    lead_attributes: AttributeBag,

    booking: Booking.optional(),
    deal: Deal.optional(),
    events: z.array(LeadEvent).default([]),
    attribution: Attribution.optional(),
    field_proposals: z.array(FieldProposal).default([]),

    /** 0..1 — used to flag low-confidence rows for human review. */
    confidence: z.number().min(0).max(1).optional(),
    notes: z.string().optional(),
  });

export type Plan = z.infer<typeof PlanSchema>;
export type LeadEventInput = z.infer<typeof LeadEvent>;
export type BookingInput = z.infer<typeof Booking>;
export type DealInput = z.infer<typeof Deal>;
export type AttributionInput = z.infer<typeof Attribution>;
export type FieldProposalInput = z.infer<typeof FieldProposal>;
