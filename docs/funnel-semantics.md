# Funnel semantics

This document is the source of truth for how the funnel is modelled and how
metrics are computed. The SQL views in `supabase/migrations/*_views.sql`
implement these definitions; if you change a definition here, change the view.

## Core principle: the event log is the source of truth

`lead_events` is **append-only**. Once an event is written it is never
updated or deleted (RLS revokes update/delete from non-service roles, and
service-role corrections are audited).

Everything else — `bookings`, `deals`, `funnel_daily`, `show_up_rate_daily`,
`ad_performance` — is a projection derived from events plus typed entity
state. This is what makes "show up rate" honest in the rescheduling case
described below: the no-show event is permanent.

## Bookings: one row per meeting, never mutated to "fix history"

Each scheduled meeting is a row in `bookings`. The row's lifecycle:

```
scheduled → held
          → no_show
          → cancelled_by_lead
          → cancelled_by_us
          → rescheduled
```

Terminal statuses are set when the calendar webhook (or a sweeper) fires.
The row is **never** flipped from `no_show` back to `held` later.

### Reschedules

A reschedule = create a *new* booking row, with `previous_booking_id`
pointing at the old one. The old row's status depends on **when** the
reschedule arrived:

- If the reschedule was received **before** the old booking's
  `scheduled_at`, the old row's status becomes `rescheduled`. It does **not**
  count toward show-up stats.
- If the reschedule was received **after** the old booking's `scheduled_at`,
  the old row's status stays `no_show` (it had already been swept). The new
  row is its own opportunity.

This is the rule the spec asks for: "no-show then rescheduled and showed up"
= **one no-show + one held**, not zero no-shows.

### The `no_show` sweeper

A scheduled job (Vercel Cron, every 5 min) flips
`status = 'scheduled' → 'no_show'` for any booking whose `scheduled_at +
duration_minutes + grace_period` is in the past and which never received a
`held` confirmation. It also writes a `booking_no_show` event so the funnel
view picks it up.

## Lead events emitted per booking transition

| Booking change                 | Event written           |
| ------------------------------ | ----------------------- |
| status = scheduled (new row)   | `booking_created`       |
| status = held                  | `booking_held`          |
| status = no_show               | `booking_no_show`       |
| status = cancelled_by_lead     | `booking_cancelled`     |
| status = cancelled_by_us       | `booking_cancelled`     |
| status = rescheduled (old row) | `booking_rescheduled`   |

`booking_rescheduled` does **not** count as a no-show.

## Metric definitions

### Show-up rate (per period)

```
held / (held + no_show + cancelled_by_lead)
```

- Counted **per booking**, bucketed by the booking's `scheduled_at` (the
  meeting's date, not the lead's first-seen date).
- `cancelled_by_us` and `rescheduled` are excluded from both numerator and
  denominator — they aren't lead failures.
- `cancelled_by_lead` counts in the denominator: from the operator's POV,
  a same-day cancel is functionally a no-show.

### Lead show-up rate (per period) — separate metric

% of leads with at least one `booking_held` divided by leads with at least
one booking opportunity, bucketed by the lead's first booking date. Useful
for ad-level questions ("does this audience eventually show up?"). Not
implemented in the v1 view; add when the dashboard needs it.

### Funnel conversion (per period)

`funnel_daily` / `funnel_weekly` / `funnel_monthly` count events on the
day they **occurred**, not the lead's first-seen date. Conversion rates are
computed in the dashboard layer as ratios over the same period:

- form → booking      = `bookings_created / form_submissions`
- booking → held      = `bookings_held / bookings_created`
- held → won          = `wins / bookings_held`
- form → won          = `wins / form_submissions`

This makes the "form-to-won" conversion lag-aware: you can compare last
month's wins to last month's form submissions, even though those wins came
from forms submitted earlier. Use cohorted views (TODO) when you need
strict cohort conversion.

### Per-ad metrics (`ad_performance`)

| Metric                 | Definition                                       |
| ---------------------- | ------------------------------------------------ |
| spend                  | sum of `ad_metrics_daily.spend` for the ad       |
| leads                  | distinct leads with `form_submitted` and ad_id   |
| qualified_leads        | distinct leads with `qualified` and ad_id        |
| calls_held             | count of `booking_held` events with ad_id        |
| wins                   | count of `won` events with ad_id                 |
| revenue                | sum of `won` event amounts with ad_id            |
| roas                   | revenue / spend                                  |
| avg_revenue_per_lead   | revenue / leads                                  |
| avg_purchase_amount    | revenue / wins                                   |

### Attribution flow

1. **Capture**: at form submission, ingest writes a row into
   `lead_attribution` with the raw `fbclid`, `utm_*` params, and
   landing-page URL.
2. **Match** (in the same ingest call):
   `match_and_stamp_lead_attribution()` runs `resolve_ad_for_attribution`
   which tries, in order:
   1. `utm_content == ads.external_id` — strategy `utm_content_external_id`.
   2. `utm_content == ads.name` (case-insensitive) — strategy
      `utm_content_name`.
   3. `utm_campaign == campaigns.external_id` or `.name` — strategy
      `utm_campaign_only` (no ad_id picked; logged for QA).
   4. `fbclid` present but unresolved — strategy `fbclid_unresolved`
      (placeholder for a future Meta CAPI-based resolution).
3. **Stamp the lead**: the first match wins. `leads.attributed_ad_id`
   and `leads.attributed_via` are set once and never overwritten — "the
   ad that brought them in" is canonical.
4. **Stamp every event**: `apply.ts` reads `leads.attributed_ad_id`
   before inserting events, so every `lead_events.ad_id` for that lead
   is the same ad.
5. **Backfill**: an hourly cron (`/api/cron/backfill-attribution`) calls
   `backfill_lead_event_attribution()` to retro-stamp `lead_events.ad_id`
   for events that were inserted before their lead's attribution
   resolved (e.g. booking webhook arrived in parallel with the form
   webhook, or `ads` rows hadn't synced yet).

`lead_events` rows are still immutable beyond this single field: the
backfill ONLY fills `ad_id` where it was NULL. We never overwrite an
existing ad_id, so attribution corrections require ad-hoc SQL and
leave a clear audit trail.

To make attribution work, the landing page's CTA URLs need to carry
`utm_content={{ad.id}}` (or the ad name) — Meta's URL parameters
template handles this automatically once configured.

## Schema flexibility (JSONB → typed column promotion)

When a webhook arrives with a field Gemini doesn't recognise, the field is
written into the entity's `attributes jsonb` column. The ingest worker also
emits a row in `field_proposals` (deduped on `(company_id, entity, field_key)`).

### Data-preservation invariant

**Review is non-blocking.** Unknown fields are stored in `attributes` from the
moment they arrive. They stay there forever unless explicitly dropped by an
operator. If a proposal sits pending for 30 days, no data is lost — the AI
keeps writing every value into `attributes`, the dashboard can read them via
`attributes ->> 'key'`, and the proposal's `occurrence_count` keeps climbing.

### Promotion flow

1. Operator opens `/[company]/proposals/<id>`, sees:
   - sample of recent values (from real rows in the entity table),
   - inferred Postgres type,
   - count of rows already carrying the attribute.
2. Operator approves with `(target_column_name, target_column_type,
   drop_attribute_after)`.
3. The dashboard calls the `apply_field_proposal(p_proposal_id, p_actor)`
   SQL function (admin-only, service-role-only). Inside one transaction it:
   - validates `target_column_name` against `^[a-z_][a-z0-9_]{0,62}$`,
   - validates `target_column_type` against an allow-list
     (`text`, `citext`, `numeric`, `integer`, `bigint`, `boolean`,
     `timestamptz`, `date`, `jsonb`),
   - `ALTER TABLE entity ADD COLUMN IF NOT EXISTS …` (idempotent),
   - `UPDATE entity SET col = (attributes ->> 'key')::type WHERE company_id =
     proposal.company_id AND attributes ? 'key'`,
   - if `drop_attribute_after = true`: `UPDATE entity SET attributes =
     attributes - 'key' …`,
   - marks the proposal `applied` with `applied_at` / `applied_by`.
4. The dashboard invalidates the per-company schema-summary cache. The next
   ingest call shows Gemini the new typed column under "PROMOTED TYPED
   COLUMNS" so future payloads land directly on the column.

### Why `drop_attribute_after` is off by default

Until Gemini's schema-summary cache refreshes (10-min TTL) AND the AI starts
writing to the typed column, fresh writes still go to `attributes`. With the
key kept in `attributes`, the daily `backfill_applied_proposals` cron
(03:31 UTC) re-runs the `attributes → column` UPDATE so the column never
falls behind by more than a day.

Once the AI is reliably writing to the typed column (check by inspecting
`webhook_processing_log.applied_changes`), an operator can re-open the
proposal and re-apply it with `drop_attribute_after = true` to remove the
duplication. (Or just leave both — disk is cheap.)

### Rejection

Rejection is purely a queue cleanup. It does **not** delete any data from
`attributes`. The same key can be re-proposed by a later webhook (we may
later teach the AI to skip rejected keys via the schema-summary; for now the
operator just rejects again).

The AI never issues DDL directly — see the architecture discussion for why.
