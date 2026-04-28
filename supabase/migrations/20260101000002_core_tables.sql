-- =============================================================================
-- Core schema
--
-- Design rules (see docs/funnel-semantics.md):
--   1. Every tenant-scoped table has `company_id uuid not null`.
--   2. No foreign keys cross company_id boundaries.
--   3. `attributes jsonb` on every entity holds AI-recognised but
--      not-yet-promoted fields. Frequently-used keys get promoted to
--      typed columns via a normal migration after human approval.
--   4. `lead_events` is append-only. Funnel metrics are derived from it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type app_role as enum ('admin', 'member');

create type lead_event_type as enum (
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
  'custom'
);

create type booking_status as enum (
  'scheduled',
  'held',
  'no_show',
  'cancelled_by_lead',
  'cancelled_by_us',
  'rescheduled'
);

create type deal_status as enum ('open', 'won', 'lost');

create type webhook_status as enum (
  'pending',
  'processing',
  'processed',
  'failed',
  'ignored'
);

create type field_proposal_status as enum (
  'pending',
  'approved',
  'rejected',
  'applied'
);

-- ---------------------------------------------------------------------------
-- Tenancy: companies + user/company linkage
-- ---------------------------------------------------------------------------

create table companies (
  id          uuid primary key default gen_random_uuid(),
  slug        citext not null unique,
  name        text not null,
  timezone    text not null default 'UTC',
  currency    text not null default 'USD',
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

-- Links a Supabase auth user to a company + role. Read by the access-token
-- hook to inject company_id / app_role claims into the JWT.
create table app_users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid references companies(id) on delete cascade,
  role        app_role not null default 'member',
  created_at  timestamptz not null default now(),
  -- Admins have company_id = null and see all companies.
  constraint app_users_company_role_chk
    check ((role = 'admin') or (company_id is not null))
);

-- ---------------------------------------------------------------------------
-- Pipeline configuration (per company)
-- ---------------------------------------------------------------------------

create table pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  key         text not null,
  label       text not null,
  position    int  not null,
  is_terminal boolean not null default false,
  is_won      boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (company_id, key)
);

-- ---------------------------------------------------------------------------
-- Ads hierarchy: account → campaign → ad_set → ad → daily metrics
-- ---------------------------------------------------------------------------

create table ad_accounts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  platform        text not null default 'meta',
  external_id     text not null,
  name            text,
  currency        text,
  attributes      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, platform, external_id)
);

create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  ad_account_id   uuid not null references ad_accounts(id) on delete cascade,
  external_id     text not null,
  name            text,
  status          text,
  objective       text,
  attributes      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, external_id)
);

create table ad_sets (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  campaign_id     uuid not null references campaigns(id) on delete cascade,
  external_id     text not null,
  name            text,
  status          text,
  daily_budget    numeric(14,2),
  attributes      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, external_id)
);

create table ads (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  ad_set_id       uuid not null references ad_sets(id) on delete cascade,
  external_id     text not null,
  name            text,
  status          text,
  creative_id     text,
  attributes      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, external_id)
);

create table ad_metrics_daily (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  ad_id           uuid not null references ads(id) on delete cascade,
  date            date not null,
  spend           numeric(14,2) not null default 0,
  impressions     bigint not null default 0,
  clicks          bigint not null default 0,
  reach           bigint,
  cpm             numeric(14,4),
  cpc             numeric(14,4),
  ctr             numeric(8,5),
  attributes      jsonb not null default '{}'::jsonb,
  fetched_at      timestamptz not null default now(),
  unique (company_id, ad_id, date)
);

-- ---------------------------------------------------------------------------
-- Leads + attribution
-- ---------------------------------------------------------------------------

create table leads (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  email           citext,
  phone           text, -- E.164 normalized by ingest layer
  first_name      text,
  last_name       text,
  attributes      jsonb not null default '{}'::jsonb,
  source          text, -- e.g., 'zapier:landing_form', 'meta:lead_ad'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Soft uniqueness; ingest dedupes on email or phone within a company.
  unique (company_id, email),
  unique (company_id, phone)
);

create trigger leads_touch_updated_at before update on leads
  for each row execute function app.touch_updated_at();

create table lead_attribution (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  lead_id         uuid not null references leads(id) on delete cascade,
  ad_id           uuid references ads(id) on delete set null,
  fbclid          text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  utm_term        text,
  landing_url     text,
  referrer_url    text,
  attributes      jsonb not null default '{}'::jsonb,
  captured_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Bookings (calls / meetings)
-- One row per scheduled meeting. Reschedules create a new row pointing to
-- the previous via `previous_booking_id`. The old row's status flips to
-- `rescheduled` (or stays `no_show` if its time had already passed).
-- ---------------------------------------------------------------------------

create table bookings (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id) on delete cascade,
  lead_id              uuid not null references leads(id) on delete cascade,
  previous_booking_id  uuid references bookings(id) on delete set null,
  external_id          text, -- calendly/cal.com event id, etc
  meeting_type         text, -- 'setting_call', 'closing_call', etc
  scheduled_at         timestamptz not null,
  status               booking_status not null default 'scheduled',
  status_set_at        timestamptz not null default now(),
  status_source        text, -- 'webhook:calendly', 'manual', 'auto:no_show_sweeper'
  duration_minutes     int,
  attributes           jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger bookings_touch_updated_at before update on bookings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Deals (sales pipeline opportunities)
-- ---------------------------------------------------------------------------

create table deals (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  lead_id         uuid not null references leads(id) on delete cascade,
  stage_id        uuid not null references pipeline_stages(id),
  status          deal_status not null default 'open',
  amount          numeric(14,2),
  currency        text,
  closed_at       timestamptz,
  attributes      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger deals_touch_updated_at before update on deals
  for each row execute function app.touch_updated_at();

create table deal_stage_history (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  deal_id         uuid not null references deals(id) on delete cascade,
  from_stage_id   uuid references pipeline_stages(id),
  to_stage_id     uuid not null references pipeline_stages(id),
  changed_at      timestamptz not null default now(),
  changed_by      uuid references auth.users(id) on delete set null,
  source          text -- 'webhook', 'manual', 'auto'
);

-- ---------------------------------------------------------------------------
-- Lead events (append-only event log — source of truth for funnel metrics)
-- ---------------------------------------------------------------------------

create table lead_events (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  lead_id         uuid not null references leads(id) on delete cascade,
  event_type      lead_event_type not null,
  event_subtype   text, -- e.g. for 'custom' events
  occurred_at     timestamptz not null default now(),
  -- Optional links to specific projection rows (booking/deal) if relevant.
  booking_id      uuid references bookings(id) on delete set null,
  deal_id         uuid references deals(id) on delete set null,
  ad_id           uuid references ads(id) on delete set null,
  amount          numeric(14,2),
  currency        text,
  attributes      jsonb not null default '{}'::jsonb,
  source          text, -- 'webhook:zapier', 'meta_capi', 'manual', 'auto'
  inserted_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Ingestion: webhook inbox + processing log + field proposals + aliases
-- ---------------------------------------------------------------------------

create table webhook_inbox (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  source            text not null, -- 'zapier', 'calendly', 'meta', 'native'
  source_event      text,          -- 'form_submitted', 'event.created', etc
  idempotency_key   text not null, -- hash of source + body, supplied by ingest
  payload           jsonb not null,
  headers           jsonb,
  status            webhook_status not null default 'pending',
  attempts          int not null default 0,
  last_error        text,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  unique (company_id, idempotency_key)
);

create table webhook_processing_log (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  webhook_inbox_id    uuid not null references webhook_inbox(id) on delete cascade,
  model               text not null,
  prompt_version      text not null,
  decision            jsonb not null, -- the structured plan returned by Gemini
  applied_changes     jsonb,          -- list of inserts/updates the worker performed
  latency_ms          int,
  prompt_tokens       int,
  completion_tokens   int,
  created_at          timestamptz not null default now()
);

create table field_proposals (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  -- Either a new attribute key on an existing entity, or a brand-new entity.
  proposal_kind   text not null check (proposal_kind in ('attribute', 'entity')),
  entity          text not null, -- 'leads', 'bookings', 'deals', or new entity name
  field_key       text,          -- null for entity proposals
  example_value   jsonb,
  inferred_type   text,          -- 'text' | 'number' | 'boolean' | 'date' | 'enum' | 'json'
  occurrence_count int not null default 1,
  status          field_proposal_status not null default 'pending',
  decided_at      timestamptz,
  decided_by      uuid references auth.users(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

create table entity_aliases (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references companies(id) on delete cascade, -- null = global
  entity          text not null,
  canonical_key   text not null,
  alias           text not null,
  created_at      timestamptz not null default now(),
  unique (company_id, entity, alias)
);
