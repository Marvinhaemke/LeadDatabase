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

Attribution flows: at form submission, ingest captures `fbclid` / utm
parameters into `lead_attribution`. The first matched ad becomes the
lead's attributed ad and is denormalized onto subsequent `lead_events`
via `ad_id`. If attribution is later corrected, only future events use
the new ad — past events keep their ad_id (immutable).

## Schema flexibility (JSONB → typed column promotion)

When a webhook arrives with a field Gemini doesn't recognise, the field is
written into the entity's `attributes jsonb` column. The ingest worker also
emits a row in `field_proposals` (deduped on `(company_id, entity, field_key)`).

Once a proposal accumulates enough usage, an operator approves it via the
dashboard. Approval triggers a normal SQL migration (`pnpm db:diff`) that:

1. Adds a typed column on the entity table.
2. Backfills it from `attributes ->> 'key'`.
3. Drops the key from `attributes` (optional, configurable per proposal).
4. Updates `field_proposals.status = 'applied'`.

The AI never issues DDL directly — see the architecture discussion for why.
