import { describe, expect, it } from 'vitest';
import { PlanSchema } from './plan';

describe('PlanSchema', () => {
  it('accepts a minimal apply plan', () => {
    const parsed = PlanSchema.parse({
      action: 'apply',
      lead_identity: { email: 'a@b.com' },
      lead_typed: {},
      lead_attributes: {},
      events: [],
      field_proposals: [],
    });
    expect(parsed.action).toBe('apply');
    expect(parsed.lead_identity.email).toBe('a@b.com');
  });

  it('accepts an ignore plan with reason', () => {
    const parsed = PlanSchema.parse({
      action: 'ignore',
      ignore_reason: 'heartbeat event, not a lead',
    });
    expect(parsed.action).toBe('ignore');
    expect(parsed.ignore_reason).toBe('heartbeat event, not a lead');
  });

  it('defaults action to apply', () => {
    const parsed = PlanSchema.parse({});
    expect(parsed.action).toBe('apply');
    expect(parsed.events).toEqual([]);
    expect(parsed.field_proposals).toEqual([]);
    expect(parsed.lead_attributes).toEqual({});
  });

  it('strips unknown top-level keys', () => {
    const parsed = PlanSchema.parse({
      action: 'apply',
      garbage_key: 'should disappear',
    });
    expect((parsed as unknown as Record<string, unknown>).garbage_key).toBeUndefined();
  });

  it('parses a full plan with booking, deal, events, attribution, proposals', () => {
    const parsed = PlanSchema.parse({
      action: 'apply',
      lead_identity: { email: 'jane@example.com' },
      lead_typed: { first_name: 'Jane', last_name: 'Doe' },
      lead_attributes: { source_form: 'pricing-page' },
      booking: {
        external_id: 'cal_evt_123',
        meeting_type: 'setting_call',
        scheduled_at: '2026-05-01T14:00:00Z',
        status: 'scheduled',
        attributes: {},
      },
      deal: {
        stage_key: 'qualified',
        status: 'open',
        amount: 5000,
        currency: 'EUR',
        attributes: {},
      },
      events: [
        { type: 'form_submitted', occurred_at: '2026-05-01T13:00:00Z', attributes: {} },
        { type: 'booking_created', attributes: {} },
      ],
      attribution: {
        utm_source: 'meta',
        utm_content: '120211000000000',
        fbclid: 'IwAR...',
      },
      field_proposals: [
        {
          entity: 'leads',
          field_key: 'company_size',
          example_value: '11-50',
          inferred_type: 'text',
        },
      ],
      confidence: 0.92,
    });
    expect(parsed.booking?.status).toBe('scheduled');
    expect(parsed.deal?.amount).toBe(5000);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.field_proposals).toHaveLength(1);
    expect(parsed.confidence).toBe(0.92);
  });

  it('rejects an out-of-range confidence', () => {
    expect(() => PlanSchema.parse({ confidence: 1.5 })).toThrow();
    expect(() => PlanSchema.parse({ confidence: -0.1 })).toThrow();
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      PlanSchema.parse({
        events: [{ type: 'not_a_real_event', attributes: {} }],
      }),
    ).toThrow();
  });

  it('rejects an unknown booking status', () => {
    expect(() =>
      PlanSchema.parse({
        booking: { status: 'pending_review', attributes: {} },
      }),
    ).toThrow();
  });

  it('rejects a 4-letter currency on a deal', () => {
    expect(() =>
      PlanSchema.parse({
        deal: { currency: 'EURO', attributes: {} },
      }),
    ).toThrow();
  });

  it('coerces missing event attributes to {}', () => {
    const parsed = PlanSchema.parse({
      events: [{ type: 'form_submitted' }],
    });
    expect(parsed.events[0]!.attributes).toEqual({});
  });
});
