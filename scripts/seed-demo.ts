/**
 * Demo seed for the local Supabase instance.
 *
 *   pnpm seed:demo
 *
 * Wipes the demo company's existing data (leads, ads, attribution,
 * field proposals, webhook inbox) and inserts a deterministic
 * synthetic dataset covering the last 60 days. After running, every
 * dashboard page renders with realistic numbers and the multi-funnel
 * UI lights up immediately.
 *
 * Deterministic: same seed → same output, so two runs in a row are
 * byte-equivalent. Safe to re-run.
 *
 * Run via the npm script (it uses `node --env-file=` to load
 * apps/dashboard/.env.local for the Supabase keys).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error(
    'SUPABASE_SERVICE_ROLE_KEY is not set. Make sure apps/dashboard/.env.local has it (run `pnpm exec supabase status` to fetch the key).',
  );
  process.exit(1);
}

const COMPANY_SLUG = 'acme';

const client: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Deterministic RNG so reruns are stable.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260512);

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function rint(min: number, maxExclusive: number): number {
  return Math.floor(rng() * (maxExclusive - min)) + min;
}
function chance(p: number): boolean {
  return rng() < p;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Anna', 'Lukas', 'Sophie', 'Maximilian', 'Lena', 'Paul', 'Marie', 'Felix',
  'Laura', 'Jonas', 'Hannah', 'Tim', 'Emma', 'Niklas', 'Mia', 'Ben',
  'Klara', 'David', 'Lisa', 'Tobias', 'Sarah', 'Daniel', 'Julia', 'Florian',
];
const LAST_NAMES = [
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner',
  'Becker', 'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter',
  'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann',
];

const FUNNEL_KEYS = [
  { key: 'meta',    p: 0.50 },
  { key: 'email',   p: 0.25 },
  { key: 'organic', p: 0.10 },
  { key: 'newsletter', p: 0.07 },
  { key: null,      p: 0.08 }, // unattributed
] as const;

function pickFunnel(): string | null {
  let r = rng();
  for (const f of FUNNEL_KEYS) {
    if (r < f.p) return f.key;
    r -= f.p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { data: company, error: cErr } = await client
    .from('companies')
    .select('id, slug, name, currency')
    .eq('slug', COMPANY_SLUG)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!company) {
    console.error(`No company "${COMPANY_SLUG}" found. Run \`pnpm db:reset\` to apply seed.sql.`);
    process.exit(1);
  }
  const companyId = company.id as string;
  console.log(`→ Seeding demo data for "${company.name}" (${company.slug})`);

  await wipe(companyId);
  const ads = await seedAdHierarchy(companyId);
  await seedAdMetrics(companyId, ads);
  const summary = await seedLeads(companyId, ads);
  await seedFieldProposals(companyId);

  console.log('\nDone. Summary:');
  console.log(`  leads:              ${summary.leads}`);
  console.log(`  events:             ${summary.events}`);
  console.log(`  bookings:           ${summary.bookings}`);
  console.log(`  deals:              ${summary.deals}`);
  console.log(`  multi-funnel leads: ${summary.multiFunnelLeads}`);
  console.log(`  ads:                ${ads.length}`);
  console.log('\nOpen http://localhost:3000 — every page should now have realistic numbers.');
}

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

async function wipe(companyId: string): Promise<void> {
  // FKs cascade from leads → events / bookings / deals / lead_attribution.
  // FKs cascade from ad_accounts → campaigns → ad_sets → ads → ad_metrics_daily.
  const tables: Array<string> = [
    'webhook_processing_log',
    'webhook_inbox',
    'field_proposals',
    'lead_events',
    'lead_attribution',
    'deal_stage_history',
    'deals',
    'bookings',
    'leads',
    'ad_metrics_daily',
    'ads',
    'ad_sets',
    'campaigns',
    'ad_accounts',
  ];
  for (const t of tables) {
    const { error } = await client.from(t).delete().eq('company_id', companyId);
    if (error) throw new Error(`wipe ${t}: ${error.message}`);
  }
  console.log('  wiped existing demo data');
}

// ---------------------------------------------------------------------------
// Ad hierarchy
// ---------------------------------------------------------------------------

interface SeededAd {
  id: string;
  external_id: string;
  name: string;
  campaign: string;
}

async function seedAdHierarchy(companyId: string): Promise<SeededAd[]> {
  const { data: acct, error: aErr } = await client
    .from('ad_accounts')
    .insert({
      company_id: companyId,
      platform: 'meta',
      external_id: 'act_DEMO123',
      name: 'Acme Meta Ad Account',
      currency: 'EUR',
      attributes: {},
    })
    .select('id')
    .single();
  if (aErr || !acct) throw aErr;
  const acctId = acct.id as string;

  const campaignDefs = [
    { external_id: 'camp_consulting_q2', name: 'Consulting — Lead Gen', objective: 'OUTCOME_LEADS' },
    { external_id: 'camp_dach_awareness', name: 'DACH Awareness', objective: 'OUTCOME_AWARENESS' },
  ];
  const campaigns: Array<{ id: string; external_id: string; name: string }> = [];
  for (const c of campaignDefs) {
    const { data, error } = await client
      .from('campaigns')
      .insert({
        company_id: companyId,
        ad_account_id: acctId,
        external_id: c.external_id,
        name: c.name,
        status: 'ACTIVE',
        objective: c.objective,
        attributes: {},
      })
      .select('id, external_id, name')
      .single();
    if (error || !data) throw error;
    campaigns.push(data as { id: string; external_id: string; name: string });
  }

  const adSetDefs = [
    { campaign: campaigns[0]!, external_id: 'adset_consult_dach', name: 'Consult — DACH lookalike' },
    { campaign: campaigns[0]!, external_id: 'adset_consult_retarget', name: 'Consult — Site retargeting' },
    { campaign: campaigns[1]!, external_id: 'adset_awareness_b2b', name: 'Awareness — B2B SMB' },
  ];
  const adSets: Array<{ id: string; campaignName: string }> = [];
  for (const s of adSetDefs) {
    const { data, error } = await client
      .from('ad_sets')
      .insert({
        company_id: companyId,
        campaign_id: s.campaign.id,
        external_id: s.external_id,
        name: s.name,
        status: 'ACTIVE',
        daily_budget: 50 + rng() * 100,
        attributes: {},
      })
      .select('id')
      .single();
    if (error || !data) throw error;
    adSets.push({ id: data.id as string, campaignName: s.campaign.name });
  }

  const adDefs = [
    { adSet: adSets[0]!, external_id: 'ad_hero_carousel', name: 'Hero carousel — Consultant case study' },
    { adSet: adSets[0]!, external_id: 'ad_hero_video',    name: 'Hero video — Founder testimonial' },
    { adSet: adSets[1]!, external_id: 'ad_retarget_pdf',  name: 'Retarget — Whitepaper PDF' },
    { adSet: adSets[1]!, external_id: 'ad_retarget_demo', name: 'Retarget — Demo call CTA' },
    { adSet: adSets[2]!, external_id: 'ad_awareness_explainer', name: 'Awareness — 30s explainer' },
    { adSet: adSets[2]!, external_id: 'ad_awareness_quote', name: 'Awareness — Customer quote' },
  ];
  const ads: SeededAd[] = [];
  for (const a of adDefs) {
    const { data, error } = await client
      .from('ads')
      .insert({
        company_id: companyId,
        ad_set_id: a.adSet.id,
        external_id: a.external_id,
        name: a.name,
        status: 'ACTIVE',
        creative_id: `creative_${a.external_id}`,
        attributes: {},
      })
      .select('id')
      .single();
    if (error || !data) throw error;
    ads.push({
      id: data.id as string,
      external_id: a.external_id,
      name: a.name,
      campaign: a.adSet.campaignName,
    });
  }
  console.log(`  inserted ${campaigns.length} campaigns, ${adSets.length} ad sets, ${ads.length} ads`);
  return ads;
}

// ---------------------------------------------------------------------------
// Ad metrics (60 days × 6 ads)
// ---------------------------------------------------------------------------

async function seedAdMetrics(companyId: string, ads: SeededAd[]): Promise<void> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rows: Array<Record<string, unknown>> = [];
  for (let dOffset = 60; dOffset >= 1; dOffset--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - dOffset);
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const weekendDip = dow === 0 || dow === 6 ? 0.65 : 1;

    for (const ad of ads) {
      // Different ads have different cost baselines.
      const base = 25 + (ad.external_id.length % 10) * 8;
      const spend = +(base * weekendDip * (0.6 + rng() * 0.9)).toFixed(2);
      const impressions = Math.floor(spend * (800 + rng() * 600));
      const clicks = Math.floor(impressions * (0.005 + rng() * 0.025));
      rows.push({
        company_id: companyId,
        ad_id: ad.id,
        date: dateStr,
        spend,
        impressions,
        clicks,
        reach: Math.floor(impressions * (0.55 + rng() * 0.3)),
        cpm: +((spend / impressions) * 1000).toFixed(4),
        cpc: clicks > 0 ? +(spend / clicks).toFixed(4) : null,
        ctr: +(clicks / impressions).toFixed(5),
        attributes: {},
        fetched_at: new Date().toISOString(),
      });
    }
  }
  // Batch upsert.
  for (const chunk of chunked(rows, 500)) {
    const { error } = await client
      .from('ad_metrics_daily')
      .upsert(chunk, { onConflict: 'company_id,ad_id,date' });
    if (error) throw new Error(`ad_metrics_daily: ${error.message}`);
  }
  console.log(`  inserted ${rows.length} ad_metrics_daily rows (60 days × ${ads.length} ads)`);
}

// ---------------------------------------------------------------------------
// Leads + attribution + events + bookings + deals
// ---------------------------------------------------------------------------

interface SeedSummary {
  leads: number;
  events: number;
  bookings: number;
  deals: number;
  multiFunnelLeads: number;
}

async function seedLeads(companyId: string, ads: SeededAd[]): Promise<SeedSummary> {
  const NUM_LEADS = 80;
  const now = Date.now();
  const summary: SeedSummary = { leads: 0, events: 0, bookings: 0, deals: 0, multiFunnelLeads: 0 };

  // Stage IDs for the pipeline (already seeded in supabase/seed.sql).
  const { data: stages, error: sErr } = await client
    .from('pipeline_stages')
    .select('id, key')
    .eq('company_id', companyId);
  if (sErr) throw sErr;
  const stageByKey = new Map(
    (stages ?? []).map((s) => [s.key as string, s.id as string]),
  );

  for (let i = 0; i < NUM_LEADS; i++) {
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`
      .normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/\s/g, '');
    const phone = `+4915${rint(10_000_000, 99_999_999)}`;

    // Lead created some time in the last 60 days.
    const ageDays = rint(0, 60);
    const createdAt = new Date(now - ageDays * 24 * 60 * 60 * 1000);
    // Slight intra-day skew so timestamps aren't all midnight UTC.
    createdAt.setUTCHours(rint(8, 20), rint(0, 60), rint(0, 60), 0);

    let funnelKey = pickFunnel();
    let attributedAdId: string | null = null;
    let attributedVia: string | null = null;

    // ~70% of meta leads attribute to a specific ad.
    if (funnelKey === 'meta' && chance(0.7)) {
      const ad = pick(ads);
      attributedAdId = ad.id;
      attributedVia = 'utm_content_external_id';
    }

    // Insert lead.
    const { data: leadRow, error: lErr } = await client
      .from('leads')
      .insert({
        company_id: companyId,
        email,
        phone,
        first_name: firstName,
        last_name: lastName,
        attributes: {},
        source: funnelKey ? `webhook:${funnelKey}` : 'webhook:zapier',
        attributed_ad_id: attributedAdId,
        attributed_via: attributedVia,
        attributed_at: attributedAdId ? createdAt.toISOString() : null,
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
      })
      .select('id')
      .single();
    if (lErr || !leadRow) throw new Error(`lead insert: ${lErr?.message}`);
    const leadId = leadRow.id as string;
    summary.leads++;

    // Attribution row.
    await client.from('lead_attribution').insert({
      company_id: companyId,
      lead_id: leadId,
      fbclid: funnelKey === 'meta' ? `IwAR_demo_${i}` : null,
      utm_source: funnelKey,
      utm_medium: funnelKey === 'meta' ? 'paid_social' : funnelKey === 'email' ? 'email' : null,
      utm_campaign: funnelKey === 'meta' ? 'consulting_leadgen' : null,
      utm_content: attributedAdId ? ads.find((a) => a.id === attributedAdId)!.external_id : null,
      landing_url: 'https://acme.example.com/pricing',
      matched_ad_id: attributedAdId,
      match_strategy: attributedVia,
      matched_at: attributedAdId ? createdAt.toISOString() : null,
      captured_at: createdAt.toISOString(),
    });

    // form_submitted event.
    await insertEvent(companyId, leadId, {
      event_type: 'form_submitted',
      occurred_at: createdAt.toISOString(),
      ad_id: attributedAdId,
      funnel_key: funnelKey,
      source: 'webhook:zapier',
    });
    summary.events++;

    // Funnel progression (chained probabilities).
    let lastTs = createdAt;
    let currentFunnel = funnelKey;

    // ~10% of leads have a second attribution from a different source ("multi-funnel").
    const multiFunnel = chance(0.12);
    let switchAfter: Date | null = null;
    let newFunnel: string | null = null;
    if (multiFunnel) {
      switchAfter = addHours(createdAt, rint(48, 24 * 14));
      newFunnel = pick(FUNNEL_KEYS.filter((f) => f.key && f.key !== funnelKey)).key;
      summary.multiFunnelLeads++;
    }

    // 60% book a call.
    if (chance(0.6)) {
      const bookingAt = addHours(lastTs, rint(2, 96));
      lastTs = bookingAt;
      if (switchAfter && bookingAt > switchAfter) currentFunnel = newFunnel;

      // Booking time itself (when the call happens):
      const scheduledAt = addHours(bookingAt, rint(24, 24 * 5));

      // Create the booking
      const bookingStatus = pickBookingStatus();
      const bookingId = await insertBooking(companyId, leadId, {
        external_id: `cal_evt_${i}_1`,
        meeting_type: 'setting_call',
        scheduled_at: scheduledAt.toISOString(),
        status: bookingStatus,
        duration_minutes: 30,
      });
      summary.bookings++;

      // booking_created event at booking time
      await insertEvent(companyId, leadId, {
        event_type: 'booking_created',
        occurred_at: bookingAt.toISOString(),
        booking_id: bookingId,
        ad_id: attributedAdId,
        funnel_key: currentFunnel,
        source: 'webhook:calendly',
      });
      summary.events++;

      // Terminal status event (only if scheduled_at is in the past; otherwise pending).
      if (scheduledAt.getTime() < now) {
        const terminalAt = addHours(scheduledAt, 0);
        if (switchAfter && terminalAt > switchAfter) currentFunnel = newFunnel;
        const eventType = bookingStatus === 'held' ? 'booking_held'
          : bookingStatus === 'no_show' ? 'booking_no_show'
          : 'booking_cancelled';
        await insertEvent(companyId, leadId, {
          event_type: eventType,
          occurred_at: terminalAt.toISOString(),
          booking_id: bookingId,
          ad_id: attributedAdId,
          funnel_key: currentFunnel,
          source: 'auto:sweeper',
        });
        summary.events++;
        lastTs = terminalAt;

        // 5% reschedule chain: insert a second booking after a no_show.
        if (bookingStatus === 'no_show' && chance(0.5)) {
          const reAt = addHours(terminalAt, rint(24, 24 * 7));
          const newScheduledAt = addHours(reAt, rint(24, 24 * 5));
          const newStatus = pickBookingStatus();
          const newBookingId = await insertBooking(companyId, leadId, {
            external_id: `cal_evt_${i}_2`,
            meeting_type: 'setting_call',
            scheduled_at: newScheduledAt.toISOString(),
            status: newStatus,
            duration_minutes: 30,
            previous_booking_id: bookingId,
          });
          summary.bookings++;
          await insertEvent(companyId, leadId, {
            event_type: 'booking_created',
            occurred_at: reAt.toISOString(),
            booking_id: newBookingId,
            ad_id: attributedAdId,
            funnel_key: currentFunnel,
            source: 'webhook:calendly',
          });
          summary.events++;
          if (newScheduledAt.getTime() < now) {
            const newTerminalAt = newScheduledAt;
            const newEventType = newStatus === 'held' ? 'booking_held'
              : newStatus === 'no_show' ? 'booking_no_show'
              : 'booking_cancelled';
            await insertEvent(companyId, leadId, {
              event_type: newEventType,
              occurred_at: newTerminalAt.toISOString(),
              booking_id: newBookingId,
              ad_id: attributedAdId,
              funnel_key: currentFunnel,
              source: 'auto:sweeper',
            });
            summary.events++;
            lastTs = newTerminalAt;
          }
        }

        // If they held, progress through the pipeline.
        if (bookingStatus === 'held') {
          if (chance(0.55)) {
            const qAt = addHours(lastTs, rint(1, 48));
            if (switchAfter && qAt > switchAfter) currentFunnel = newFunnel;
            await insertEvent(companyId, leadId, {
              event_type: 'qualified',
              occurred_at: qAt.toISOString(),
              ad_id: attributedAdId,
              funnel_key: currentFunnel,
              source: 'manual',
            });
            summary.events++;
            lastTs = qAt;

            // Deal lifecycle.
            const stageQualified = stageByKey.get('qualified');
            if (stageQualified) {
              const dealId = await insertDeal(companyId, leadId, stageQualified, 'open', qAt);
              summary.deals++;

              if (chance(0.7)) {
                const pAt = addHours(lastTs, rint(24, 24 * 5));
                if (switchAfter && pAt > switchAfter) currentFunnel = newFunnel;
                await transitionDealStage(
                  dealId, companyId,
                  stageQualified, stageByKey.get('proposal_sent')!,
                  pAt,
                );
                await insertEvent(companyId, leadId, {
                  event_type: 'proposal_sent',
                  occurred_at: pAt.toISOString(),
                  deal_id: dealId,
                  ad_id: attributedAdId,
                  funnel_key: currentFunnel,
                  source: 'manual',
                });
                summary.events++;
                lastTs = pAt;

                const wonRoll = rng();
                if (wonRoll < 0.45) {
                  const closeAt = addHours(lastTs, rint(24, 24 * 14));
                  if (switchAfter && closeAt > switchAfter) currentFunnel = newFunnel;
                  const amount = 2_000 + Math.floor(rng() * 13_000);
                  await transitionDealStage(
                    dealId, companyId,
                    stageByKey.get('proposal_sent')!, stageByKey.get('won')!,
                    closeAt, 'won', amount, 'EUR',
                  );
                  await insertEvent(companyId, leadId, {
                    event_type: 'won',
                    occurred_at: closeAt.toISOString(),
                    deal_id: dealId,
                    ad_id: attributedAdId,
                    funnel_key: currentFunnel,
                    amount,
                    currency: 'EUR',
                    source: 'manual',
                  });
                  summary.events++;
                } else if (wonRoll < 0.75) {
                  const closeAt = addHours(lastTs, rint(24, 24 * 14));
                  if (switchAfter && closeAt > switchAfter) currentFunnel = newFunnel;
                  await transitionDealStage(
                    dealId, companyId,
                    stageByKey.get('proposal_sent')!, stageByKey.get('lost')!,
                    closeAt, 'lost',
                  );
                  await insertEvent(companyId, leadId, {
                    event_type: 'lost',
                    occurred_at: closeAt.toISOString(),
                    deal_id: dealId,
                    ad_id: attributedAdId,
                    funnel_key: currentFunnel,
                    source: 'manual',
                  });
                  summary.events++;
                }
              }
            }
          } else if (chance(0.4)) {
            await insertEvent(companyId, leadId, {
              event_type: 'disqualified',
              occurred_at: addHours(lastTs, rint(1, 48)).toISOString(),
              ad_id: attributedAdId,
              funnel_key: currentFunnel,
              source: 'manual',
            });
            summary.events++;
          }
        }
      }
    }
  }

  console.log(
    `  inserted ${summary.leads} leads, ${summary.events} events, ${summary.bookings} bookings, ${summary.deals} deals (${summary.multiFunnelLeads} multi-funnel)`,
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Field proposals (read-only demo for the proposals page)
// ---------------------------------------------------------------------------

async function seedFieldProposals(companyId: string): Promise<void> {
  const proposals = [
    {
      proposal_kind: 'attribute',
      entity: 'leads',
      field_key: 'company_size',
      example_value: '11-50',
      inferred_type: 'text',
      occurrence_count: 23,
      status: 'pending',
    },
    {
      proposal_kind: 'attribute',
      entity: 'leads',
      field_key: 'budget_range',
      example_value: '10000-25000',
      inferred_type: 'text',
      occurrence_count: 18,
      status: 'pending',
    },
    {
      proposal_kind: 'attribute',
      entity: 'bookings',
      field_key: 'preferred_language',
      example_value: 'de',
      inferred_type: 'text',
      occurrence_count: 14,
      status: 'pending',
    },
    {
      proposal_kind: 'attribute',
      entity: 'leads',
      field_key: 'lead_score',
      example_value: 72,
      inferred_type: 'number',
      occurrence_count: 9,
      status: 'rejected',
      notes: 'duplicate of qualification score we already compute',
    },
  ];

  for (const p of proposals) {
    const { error } = await client.from('field_proposals').insert({
      company_id: companyId,
      ...p,
    });
    if (error) throw new Error(`field_proposals: ${error.message}`);
  }
  console.log(`  inserted ${proposals.length} field proposals`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EventInput {
  event_type: string;
  occurred_at: string;
  booking_id?: string | null;
  deal_id?: string | null;
  ad_id?: string | null;
  funnel_key?: string | null;
  amount?: number | null;
  currency?: string | null;
  source: string;
}

async function insertEvent(companyId: string, leadId: string, e: EventInput): Promise<void> {
  const { error } = await client.from('lead_events').insert({
    id: randomUUID(),
    company_id: companyId,
    lead_id: leadId,
    event_type: e.event_type,
    occurred_at: e.occurred_at,
    booking_id: e.booking_id ?? null,
    deal_id: e.deal_id ?? null,
    ad_id: e.ad_id ?? null,
    funnel_key: e.funnel_key ?? null,
    amount: e.amount ?? null,
    currency: e.currency ?? null,
    attributes: {},
    source: e.source,
  });
  if (error) throw new Error(`event ${e.event_type}: ${error.message}`);
}

async function insertBooking(
  companyId: string,
  leadId: string,
  b: {
    external_id: string;
    meeting_type: string;
    scheduled_at: string;
    status: string;
    duration_minutes: number;
    previous_booking_id?: string;
  },
): Promise<string> {
  const { data, error } = await client
    .from('bookings')
    .insert({
      company_id: companyId,
      lead_id: leadId,
      external_id: b.external_id,
      meeting_type: b.meeting_type,
      scheduled_at: b.scheduled_at,
      status: b.status,
      status_set_at: b.scheduled_at,
      status_source: b.status === 'scheduled' ? 'webhook:calendly' : 'auto:sweeper',
      duration_minutes: b.duration_minutes,
      previous_booking_id: b.previous_booking_id ?? null,
      attributes: {},
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`booking: ${error?.message}`);
  return data.id as string;
}

async function insertDeal(
  companyId: string,
  leadId: string,
  stageId: string,
  status: string,
  createdAt: Date,
): Promise<string> {
  const { data, error } = await client
    .from('deals')
    .insert({
      company_id: companyId,
      lead_id: leadId,
      stage_id: stageId,
      status,
      attributes: {},
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`deal: ${error?.message}`);
  const dealId = data.id as string;
  await client.from('deal_stage_history').insert({
    company_id: companyId,
    deal_id: dealId,
    from_stage_id: null,
    to_stage_id: stageId,
    changed_at: createdAt.toISOString(),
    source: 'demo-seed',
  });
  return dealId;
}

async function transitionDealStage(
  dealId: string,
  companyId: string,
  fromStage: string,
  toStage: string,
  at: Date,
  status?: string,
  amount?: number,
  currency?: string,
): Promise<void> {
  const update: Record<string, unknown> = { stage_id: toStage, updated_at: at.toISOString() };
  if (status) update.status = status;
  if (status === 'won' || status === 'lost') update.closed_at = at.toISOString();
  if (amount != null) update.amount = amount;
  if (currency) update.currency = currency;
  await client.from('deals').update(update).eq('id', dealId);
  await client.from('deal_stage_history').insert({
    company_id: companyId,
    deal_id: dealId,
    from_stage_id: fromStage,
    to_stage_id: toStage,
    changed_at: at.toISOString(),
    source: 'demo-seed',
  });
}

function pickBookingStatus(): 'held' | 'no_show' | 'cancelled_by_lead' {
  const r = rng();
  if (r < 0.65) return 'held';
  if (r < 0.88) return 'no_show';
  return 'cancelled_by_lead';
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 60 * 60 * 1000);
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
