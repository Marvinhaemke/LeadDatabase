-- =============================================================================
-- Funnel views
--
-- All metrics are derived from `lead_events` (append-only) joined with
-- `bookings`, `deals`, and `ad_metrics_daily`. The views are tenant-scoped
-- via company_id and inherit RLS from their underlying tables.
--
-- See docs/funnel-semantics.md for definitions.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- funnel_daily — one row per (company_id, date) with stage counts
--
-- Counts events on the day they OCCURRED, not when the lead first arrived.
-- This makes daily/weekly/monthly trends honest about *recent* activity.
-- ---------------------------------------------------------------------------
create or replace view funnel_daily as
select
  e.company_id,
  date_trunc('day', e.occurred_at)::date as day,
  count(*) filter (where e.event_type = 'form_submitted')      as form_submissions,
  count(*) filter (where e.event_type = 'booking_created')     as bookings_created,
  count(*) filter (where e.event_type = 'booking_held')        as bookings_held,
  count(*) filter (where e.event_type = 'booking_no_show')     as bookings_no_show,
  count(*) filter (where e.event_type = 'qualified')           as qualified,
  count(*) filter (where e.event_type = 'disqualified')        as disqualified,
  count(*) filter (where e.event_type = 'proposal_sent')       as proposals_sent,
  count(*) filter (where e.event_type = 'won')                 as wins,
  count(*) filter (where e.event_type = 'lost')                as losses,
  coalesce(sum(e.amount) filter (where e.event_type = 'won'), 0)::numeric(14,2) as revenue
from lead_events e
group by 1, 2;

-- ---------------------------------------------------------------------------
-- funnel_weekly / funnel_monthly — same metrics, larger buckets.
-- Use the company timezone-agnostic ISO week / calendar month.
-- ---------------------------------------------------------------------------
create or replace view funnel_weekly as
select
  e.company_id,
  date_trunc('week', e.occurred_at)::date as week_start,
  count(*) filter (where e.event_type = 'form_submitted')      as form_submissions,
  count(*) filter (where e.event_type = 'booking_created')     as bookings_created,
  count(*) filter (where e.event_type = 'booking_held')        as bookings_held,
  count(*) filter (where e.event_type = 'booking_no_show')     as bookings_no_show,
  count(*) filter (where e.event_type = 'qualified')           as qualified,
  count(*) filter (where e.event_type = 'disqualified')        as disqualified,
  count(*) filter (where e.event_type = 'proposal_sent')       as proposals_sent,
  count(*) filter (where e.event_type = 'won')                 as wins,
  count(*) filter (where e.event_type = 'lost')                as losses,
  coalesce(sum(e.amount) filter (where e.event_type = 'won'), 0)::numeric(14,2) as revenue
from lead_events e
group by 1, 2;

create or replace view funnel_monthly as
select
  e.company_id,
  date_trunc('month', e.occurred_at)::date as month_start,
  count(*) filter (where e.event_type = 'form_submitted')      as form_submissions,
  count(*) filter (where e.event_type = 'booking_created')     as bookings_created,
  count(*) filter (where e.event_type = 'booking_held')        as bookings_held,
  count(*) filter (where e.event_type = 'booking_no_show')     as bookings_no_show,
  count(*) filter (where e.event_type = 'qualified')           as qualified,
  count(*) filter (where e.event_type = 'disqualified')        as disqualified,
  count(*) filter (where e.event_type = 'proposal_sent')       as proposals_sent,
  count(*) filter (where e.event_type = 'won')                 as wins,
  count(*) filter (where e.event_type = 'lost')                as losses,
  coalesce(sum(e.amount) filter (where e.event_type = 'won'), 0)::numeric(14,2) as revenue
from lead_events e
group by 1, 2;

-- ---------------------------------------------------------------------------
-- show_up_rate_daily
--
-- Per-booking show-up rate, bucketed by the booking's SCHEDULED day.
-- Reschedules (status = 'rescheduled') and admin-cancellations are excluded
-- from the denominator: only meetings where the lead either showed up or
-- didn't (no_show, cancelled_by_lead) count as opportunities to show up.
--
-- Example from spec: lead books two setting calls, no-shows the first,
-- attends the second. The first is counted as 1/1 no-show on its day,
-- the second as 1/1 held on its day. Aggregated: 1 held / 2 = 50%.
-- ---------------------------------------------------------------------------
create or replace view show_up_rate_daily as
select
  b.company_id,
  date_trunc('day', b.scheduled_at)::date as day,
  count(*) filter (where b.status = 'held')           as held,
  count(*) filter (where b.status = 'no_show')        as no_show,
  count(*) filter (where b.status = 'cancelled_by_lead') as cancelled_by_lead,
  count(*) filter (where b.status in ('held','no_show','cancelled_by_lead')) as opportunities,
  case
    when count(*) filter (where b.status in ('held','no_show','cancelled_by_lead')) = 0 then null
    else round(
      count(*) filter (where b.status = 'held')::numeric
      / count(*) filter (where b.status in ('held','no_show','cancelled_by_lead'))::numeric,
      4
    )
  end as show_up_rate
from bookings b
where b.status in ('held', 'no_show', 'cancelled_by_lead', 'cancelled_by_us', 'rescheduled')
group by 1, 2;

-- ---------------------------------------------------------------------------
-- ad_performance — per-ad rollup with funnel + spend.
--
-- Joins lead_events.ad_id (set at attribution time) against ad_metrics_daily
-- to compute leads/bookings/wins/revenue/ROAS per ad over a window.
-- Window is left open here; the dashboard supplies date filters via where.
-- ---------------------------------------------------------------------------
create or replace view ad_performance as
with spend as (
  select
    company_id,
    ad_id,
    sum(spend) as spend_total
  from ad_metrics_daily
  group by 1, 2
),
funnel as (
  select
    company_id,
    ad_id,
    count(distinct lead_id) filter (where event_type = 'form_submitted') as leads,
    count(distinct lead_id) filter (where event_type = 'qualified')       as qualified_leads,
    count(*) filter (where event_type = 'booking_held')                   as calls_held,
    count(*) filter (where event_type = 'won')                            as wins,
    coalesce(sum(amount) filter (where event_type = 'won'), 0)::numeric(14,2) as revenue
  from lead_events
  where ad_id is not null
  group by 1, 2
)
select
  a.company_id,
  a.id as ad_id,
  a.name as ad_name,
  a.ad_set_id,
  coalesce(s.spend_total, 0)::numeric(14,2) as spend,
  coalesce(f.leads, 0)              as leads,
  coalesce(f.qualified_leads, 0)    as qualified_leads,
  coalesce(f.calls_held, 0)         as calls_held,
  coalesce(f.wins, 0)               as wins,
  coalesce(f.revenue, 0)            as revenue,
  case
    when coalesce(s.spend_total, 0) = 0 then null
    else round(coalesce(f.revenue, 0) / s.spend_total, 4)
  end as roas,
  case
    when coalesce(f.leads, 0) = 0 then null
    else round(coalesce(f.revenue, 0) / f.leads, 2)
  end as avg_revenue_per_lead,
  case
    when coalesce(f.wins, 0) = 0 then null
    else round(coalesce(f.revenue, 0) / f.wins, 2)
  end as avg_purchase_amount
from ads a
left join spend s on s.ad_id = a.id and s.company_id = a.company_id
left join funnel f on f.ad_id = a.id and f.company_id = a.company_id;
