import { describe, expect, it } from 'vitest';
import { applyPlan } from './apply';
import { PlanSchema } from './plan';
import { makeFakeClient, type FakeClient } from './test-utils/fake-supabase';

const COMPANY = 'co1';
const INBOX = 'inb1';

function baseArgs(client: FakeClient, planInput: unknown) {
  return {
    // The client shape doesn't match SupabaseClient<Database> precisely,
    // but apply.ts only uses the subset our fake implements.
    client: client as never,
    companyId: COMPANY,
    webhookInboxId: INBOX,
    source: 'zapier',
    plan: PlanSchema.parse(planInput),
  };
}

// -----------------------------------------------------------------------------
// action=ignore + identity-missing
// -----------------------------------------------------------------------------

describe('applyPlan / ignore paths', () => {
  it('action=ignore writes nothing', async () => {
    const c = makeFakeClient();
    const out = await applyPlan(
      baseArgs(c, { action: 'ignore', ignore_reason: 'heartbeat event' }),
    );
    expect(out.ignored).toBe(true);
    expect(out.ignoreReason).toBe('heartbeat event');
    expect(c.tableRows('leads')).toHaveLength(0);
    expect(c.tableRows('lead_events')).toHaveLength(0);
    expect(c.tableRows('bookings')).toHaveLength(0);
  });

  it('refuses to apply when neither email nor phone resolves', async () => {
    const c = makeFakeClient();
    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { first_name: 'Anonymous' },
        events: [{ type: 'form_submitted' }],
      }),
    );
    expect(out.ignored).toBe(true);
    expect(out.ignoreReason).toMatch(/no lead identity/i);
    expect(c.tableRows('leads')).toHaveLength(0);
    expect(c.tableRows('lead_events')).toHaveLength(0);
  });

  it('warns on unparseable email + phone but still applies if one resolves', async () => {
    const c = makeFakeClient();
    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        lead_typed: { phone: 'totally-not-a-phone' },
      }),
    );
    expect(out.ignored).toBe(false);
    expect(out.warnings.some((w) => w.includes('unparseable phone'))).toBe(true);
    expect(c.tableRows('leads')).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Lead dedup
// -----------------------------------------------------------------------------

describe('applyPlan / lead dedup', () => {
  it('reuses existing lead by normalized email (case-insensitive)', async () => {
    const c = makeFakeClient();
    c.seed('leads', [
      {
        id: 'lead-1',
        company_id: COMPANY,
        email: 'jane@example.com',
        phone: null,
        first_name: 'Jane',
        last_name: null,
        source: 'zapier',
        attributes: {},
        attributed_ad_id: null,
        attributed_via: null,
      },
    ]);

    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: '  Jane@EXAMPLE.com  ' },
        lead_typed: { last_name: 'Doe' },
      }),
    );

    expect(out.leadId).toBe('lead-1');
    const leads = c.tableRows('leads') as Array<{ id: string; last_name: string | null }>;
    expect(leads).toHaveLength(1);
    expect(leads[0]!.last_name).toBe('Doe'); // updated, not duplicated
  });

  it('reuses existing lead by phone when email differs', async () => {
    const c = makeFakeClient();
    c.seed('leads', [
      {
        id: 'lead-1',
        company_id: COMPANY,
        email: 'old@example.com',
        phone: '+493012345678',
        attributes: {},
        attributed_ad_id: null,
        attributed_via: null,
      },
    ]);

    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        // Use E.164 directly so the test doesn't depend on defaultCountry.
        lead_identity: { phone: '+493012345678' },
      }),
    );

    expect(out.leadId).toBe('lead-1');
    expect(c.tableRows('leads')).toHaveLength(1);
  });

  it('creates a new lead when neither email nor phone match', async () => {
    const c = makeFakeClient();
    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'new@example.com' },
        lead_typed: { first_name: 'New' },
      }),
    );
    expect(out.leadId).toBeDefined();
    expect(c.tableRows('leads')).toHaveLength(1);
    const lead = c.tableRows('leads')[0] as { email: string; first_name: string };
    expect(lead.email).toBe('new@example.com');
    expect(lead.first_name).toBe('New');
  });

  it('merges lead_attributes into the existing JSONB rather than clobbering', async () => {
    const c = makeFakeClient();
    c.seed('leads', [
      {
        id: 'lead-1',
        company_id: COMPANY,
        email: 'jane@example.com',
        attributes: { source_form: 'pricing-page', existing_key: 'keep-me' },
        attributed_ad_id: null,
        attributed_via: null,
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        lead_attributes: { company_size: '11-50' },
      }),
    );

    const lead = c.tableRows('leads')[0] as { attributes: Record<string, unknown> };
    expect(lead.attributes).toEqual({
      source_form: 'pricing-page',
      existing_key: 'keep-me',
      company_size: '11-50',
    });
  });
});

// -----------------------------------------------------------------------------
// Reschedule chain (the spec's marquee case)
// -----------------------------------------------------------------------------

describe('applyPlan / reschedule chain', () => {
  it('marks the previous booking as rescheduled when its time is still in the future', async () => {
    const c = seedLeadAndBookings(c0(), {
      leadEmail: 'jane@example.com',
      previous: {
        id: 'old-booking',
        external_id: 'cal_evt_1',
        scheduled_at: futureIso(2 * 60 * 60 * 1000), // 2h from now
        status: 'scheduled',
      },
    });

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        booking: {
          external_id: 'cal_evt_2',
          previous_external_id: 'cal_evt_1',
          scheduled_at: futureIso(48 * 60 * 60 * 1000),
          status: 'scheduled',
        },
      }),
    );

    const bookings = c.tableRows('bookings') as Array<{
      external_id: string;
      status: string;
      previous_booking_id: string | null;
    }>;
    const old = bookings.find((b) => b.external_id === 'cal_evt_1')!;
    const fresh = bookings.find((b) => b.external_id === 'cal_evt_2')!;
    expect(old.status).toBe('rescheduled');
    expect(fresh.previous_booking_id).toBe('old-booking');
    expect(fresh.status).toBe('scheduled');
  });

  it('leaves the previous booking alone when its scheduled time has already passed', async () => {
    const c = seedLeadAndBookings(c0(), {
      leadEmail: 'jane@example.com',
      previous: {
        id: 'old-booking',
        external_id: 'cal_evt_1',
        scheduled_at: pastIso(72 * 60 * 60 * 1000), // 3 days ago
        status: 'no_show',
      },
    });

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        booking: {
          external_id: 'cal_evt_2',
          previous_external_id: 'cal_evt_1',
          scheduled_at: futureIso(2 * 60 * 60 * 1000),
          status: 'scheduled',
        },
      }),
    );

    const bookings = c.tableRows('bookings') as Array<{
      external_id: string;
      status: string;
      previous_booking_id: string | null;
    }>;
    const old = bookings.find((b) => b.external_id === 'cal_evt_1')!;
    const fresh = bookings.find((b) => b.external_id === 'cal_evt_2')!;
    expect(old.status).toBe('no_show'); // preserved — this is the spec rule
    expect(fresh.previous_booking_id).toBe('old-booking');
  });
});

// -----------------------------------------------------------------------------
// Event ad_id stamping (attribution propagation)
// -----------------------------------------------------------------------------

describe('applyPlan / event attribution', () => {
  it('stamps lead_events.ad_id from an existing leads.attributed_ad_id', async () => {
    const c = makeFakeClient();
    c.seed('leads', [
      {
        id: 'lead-1',
        company_id: COMPANY,
        email: 'jane@example.com',
        attributes: {},
        attributed_ad_id: 'ad-123',
        attributed_via: 'utm_content_external_id',
      },
    ]);

    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        events: [{ type: 'booking_held' }, { type: 'qualified' }],
      }),
    );

    expect(out.attributedAdId).toBe('ad-123');
    expect(out.attributedVia).toBe('utm_content_external_id');
    const events = c.tableRows('lead_events') as Array<{ ad_id: string | null; event_type: string }>;
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.ad_id).toBe('ad-123');
  });

  it('runs match_and_stamp RPC for fresh attribution and propagates ad_id to events', async () => {
    const c = makeFakeClient();
    c.registerRpc('match_and_stamp_lead_attribution', () => [
      { matched_ad_id: 'ad-999', strategy: 'utm_content_external_id', stamped_lead: true },
    ]);

    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'fresh@example.com' },
        attribution: { utm_content: '120211000000000', utm_source: 'meta' },
        events: [{ type: 'form_submitted' }],
      }),
    );

    expect(out.attributedAdId).toBe('ad-999');
    expect(out.attributedVia).toBe('utm_content_external_id');
    const events = c.tableRows('lead_events') as Array<{ ad_id: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.ad_id).toBe('ad-999');

    const attrs = c.tableRows('lead_attribution') as Array<{ utm_content: string }>;
    expect(attrs).toHaveLength(1);
    expect(attrs[0]!.utm_content).toBe('120211000000000');
  });

  it('does not overwrite an existing attribution when fresh match also resolves', async () => {
    const c = makeFakeClient();
    c.seed('leads', [
      {
        id: 'lead-1',
        company_id: COMPANY,
        email: 'jane@example.com',
        attributes: {},
        attributed_ad_id: 'ad-original',
        attributed_via: 'utm_content_external_id',
      },
    ]);
    c.registerRpc('match_and_stamp_lead_attribution', () => [
      { matched_ad_id: 'ad-different', strategy: 'utm_content_name', stamped_lead: false },
    ]);

    const out = await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        attribution: { utm_content: 'AcmeAdName' },
        events: [{ type: 'won', amount: 5000, currency: 'EUR' }],
      }),
    );

    // The existing lead's ad wins for event-stamping (first-touch).
    expect(out.attributedAdId).toBe('ad-original');
    const events = c.tableRows('lead_events') as Array<{ ad_id: string | null; amount: number | null }>;
    expect(events[0]!.ad_id).toBe('ad-original');
    expect(events[0]!.amount).toBe(5000);
  });
});

// -----------------------------------------------------------------------------
// Multi-funnel: funnel_key stamping
// -----------------------------------------------------------------------------

describe('applyPlan / funnel_key', () => {
  it('derives funnel_key=meta when fbclid is present', async () => {
    const c = makeFakeClient();
    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        attribution: { fbclid: 'IwAR...' },
        events: [{ type: 'form_submitted' }],
      }),
    );
    const events = c.tableRows('lead_events') as Array<{ funnel_key: string | null }>;
    expect(events[0]!.funnel_key).toBe('meta');
  });

  it('uses utm_source lowercased when fbclid is absent', async () => {
    const c = makeFakeClient();
    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        attribution: { utm_source: 'Newsletter' },
        events: [{ type: 'form_submitted' }],
      }),
    );
    const events = c.tableRows('lead_events') as Array<{ funnel_key: string | null }>;
    expect(events[0]!.funnel_key).toBe('newsletter');
  });

  it("falls back to the lead's most-recent prior attribution when this webhook carries none", async () => {
    const c = makeFakeClient();
    c.seed('leads', [
      {
        id: 'lead-1',
        company_id: COMPANY,
        email: 'jane@example.com',
        attributes: {},
        attributed_ad_id: null,
        attributed_via: null,
      },
    ]);
    c.seed('lead_attribution', [
      {
        id: 'attr-1',
        company_id: COMPANY,
        lead_id: 'lead-1',
        fbclid: null,
        utm_source: 'meta',
        captured_at: '2026-04-01T10:00:00Z',
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        // no attribution on this webhook (e.g. a booking-created event)
        events: [{ type: 'booking_held' }],
      }),
    );

    const events = c.tableRows('lead_events') as Array<{ funnel_key: string | null }>;
    expect(events[0]!.funnel_key).toBe('meta');
  });

  it('new attribution with a different source overrides for THIS run, preserving past events', async () => {
    // Past events stay tagged 'meta'; this run's events get tagged 'email'.
    const c = makeFakeClient();
    c.seed('leads', [
      {
        id: 'lead-1',
        company_id: COMPANY,
        email: 'jane@example.com',
        attributes: {},
        attributed_ad_id: null,
        attributed_via: null,
      },
    ]);
    c.seed('lead_attribution', [
      {
        id: 'attr-1',
        company_id: COMPANY,
        lead_id: 'lead-1',
        utm_source: 'meta',
        captured_at: '2026-04-01T10:00:00Z',
      },
    ]);
    c.seed('lead_events', [
      {
        id: 'ev-old',
        company_id: COMPANY,
        lead_id: 'lead-1',
        event_type: 'form_submitted',
        occurred_at: '2026-04-01T10:00:00Z',
        funnel_key: 'meta',
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        attribution: { utm_source: 'email' },
        events: [{ type: 'form_submitted' }, { type: 'won', amount: 5000, currency: 'EUR' }],
      }),
    );

    const events = c.tableRows('lead_events') as Array<{
      id: string;
      funnel_key: string | null;
      event_type: string;
    }>;
    const oldEvent = events.find((e) => e.id === 'ev-old')!;
    const newEvents = events.filter((e) => e.id !== 'ev-old');
    expect(oldEvent.funnel_key).toBe('meta');
    expect(newEvents).toHaveLength(2);
    for (const e of newEvents) expect(e.funnel_key).toBe('email');
  });
});

// -----------------------------------------------------------------------------
// User-defined funnel definitions override the source-based fallback
// -----------------------------------------------------------------------------

describe('applyPlan / funnel_definitions', () => {
  it('matches a user-defined funnel by landing_url and stamps its key', async () => {
    const c = makeFakeClient();
    c.seed('funnel_definitions', [
      {
        id: '11111111-1111-1111-1111-111111111111',
        company_id: COMPANY,
        key: 'vsl_consulting',
        label: 'VSL — Consulting',
        priority: 10,
        filters: [{ field: 'landing_url', op: 'contains', value: '/vsl' }],
        archived_at: null,
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        attribution: {
          utm_source: 'meta',
          fbclid: 'IwAR_x',
          landing_url: 'https://acme.example.com/vsl-page',
        },
        events: [{ type: 'form_submitted' }],
      }),
    );

    const events = c.tableRows('lead_events') as Array<{ funnel_key: string | null }>;
    // The user-defined funnel wins over the meta-source fallback.
    expect(events[0]!.funnel_key).toBe('vsl_consulting');
  });

  it("falls back to deriveFunnelKey when no defined funnel matches", async () => {
    const c = makeFakeClient();
    c.seed('funnel_definitions', [
      {
        id: '22222222-2222-2222-2222-222222222222',
        company_id: COMPANY,
        key: 'vsl_consulting',
        label: 'VSL',
        priority: 10,
        filters: [{ field: 'landing_url', op: 'contains', value: '/vsl' }],
        archived_at: null,
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        attribution: { utm_source: 'meta', fbclid: 'IwAR_x', landing_url: 'https://acme.example.com/quiz' },
        events: [{ type: 'form_submitted' }],
      }),
    );
    const events = c.tableRows('lead_events') as Array<{ funnel_key: string | null }>;
    expect(events[0]!.funnel_key).toBe('meta');
  });

  it('picks the lowest-priority defined funnel when multiple would match', async () => {
    const c = makeFakeClient();
    c.seed('funnel_definitions', [
      {
        id: '33333333-3333-3333-3333-333333333333',
        company_id: COMPANY,
        key: 'meta_broad',
        label: 'Meta broad',
        priority: 100,
        filters: [{ field: 'utm_source', op: 'eq', value: 'meta' }],
        archived_at: null,
      },
      {
        id: '44444444-4444-4444-4444-444444444444',
        company_id: COMPANY,
        key: 'vsl_consulting',
        label: 'VSL — Consulting',
        priority: 10,
        filters: [
          { field: 'utm_source', op: 'eq', value: 'meta' },
          { field: 'landing_url', op: 'contains', value: '/vsl' },
        ],
        archived_at: null,
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        attribution: {
          utm_source: 'meta',
          landing_url: 'https://acme.example.com/vsl',
        },
        events: [{ type: 'form_submitted' }],
      }),
    );
    const events = c.tableRows('lead_events') as Array<{ funnel_key: string | null }>;
    expect(events[0]!.funnel_key).toBe('vsl_consulting');
  });
});

// -----------------------------------------------------------------------------
// Field proposals
// -----------------------------------------------------------------------------

describe('applyPlan / field proposals', () => {
  it('inserts a fresh proposal on first sighting', async () => {
    const c = makeFakeClient();
    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        field_proposals: [
          {
            entity: 'leads',
            field_key: 'company_size',
            example_value: '11-50',
            inferred_type: 'text',
          },
        ],
      }),
    );
    const proposals = c.tableRows('field_proposals') as Array<{
      field_key: string;
      occurrence_count: number;
      status: string;
    }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.field_key).toBe('company_size');
    expect(proposals[0]!.occurrence_count).toBe(1);
  });

  it('bumps occurrence_count + last_seen_at on a pending duplicate', async () => {
    const c = makeFakeClient();
    c.seed('field_proposals', [
      {
        id: 'p1',
        company_id: COMPANY,
        entity: 'leads',
        field_key: 'company_size',
        occurrence_count: 4,
        status: 'pending',
        last_seen_at: '2026-04-01T00:00:00Z',
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        field_proposals: [
          {
            entity: 'leads',
            field_key: 'company_size',
            example_value: '51-200',
            inferred_type: 'text',
          },
        ],
      }),
    );
    const p = c.tableRows('field_proposals')[0] as {
      occurrence_count: number;
      last_seen_at: string;
    };
    expect(p.occurrence_count).toBe(5);
    expect(new Date(p.last_seen_at).getTime()).toBeGreaterThan(
      new Date('2026-04-01T00:00:00Z').getTime(),
    );
    expect(c.tableRows('field_proposals')).toHaveLength(1); // no duplicate
  });

  it('only bumps last_seen_at on a rejected proposal (no count change)', async () => {
    const c = makeFakeClient();
    c.seed('field_proposals', [
      {
        id: 'p1',
        company_id: COMPANY,
        entity: 'leads',
        field_key: 'rejected_key',
        occurrence_count: 7,
        status: 'rejected',
        last_seen_at: '2026-04-01T00:00:00Z',
      },
    ]);

    await applyPlan(
      baseArgs(c, {
        action: 'apply',
        lead_identity: { email: 'jane@example.com' },
        field_proposals: [
          {
            entity: 'leads',
            field_key: 'rejected_key',
            example_value: 'still arriving',
            inferred_type: 'text',
          },
        ],
      }),
    );
    const p = c.tableRows('field_proposals')[0] as {
      occurrence_count: number;
      last_seen_at: string;
      status: string;
    };
    expect(p.status).toBe('rejected');
    expect(p.occurrence_count).toBe(7); // unchanged
    expect(new Date(p.last_seen_at).getTime()).toBeGreaterThan(
      new Date('2026-04-01T00:00:00Z').getTime(),
    );
  });
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function c0() {
  return makeFakeClient();
}

function seedLeadAndBookings(
  c: FakeClient,
  args: {
    leadEmail: string;
    previous: { id: string; external_id: string; scheduled_at: string; status: string };
  },
): FakeClient {
  c.seed('leads', [
    {
      id: 'lead-1',
      company_id: COMPANY,
      email: args.leadEmail,
      attributes: {},
      attributed_ad_id: null,
      attributed_via: null,
    },
  ]);
  c.seed('bookings', [
    {
      id: args.previous.id,
      company_id: COMPANY,
      lead_id: 'lead-1',
      external_id: args.previous.external_id,
      scheduled_at: args.previous.scheduled_at,
      status: args.previous.status,
      attributes: {},
    },
  ]);
  return c;
}

function futureIso(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}
function pastIso(deltaMs: number): string {
  return new Date(Date.now() - deltaMs).toISOString();
}
