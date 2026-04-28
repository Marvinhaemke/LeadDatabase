-- =============================================================================
-- Indexes
--
-- Goals:
--   - All tenant lookups are by company_id first, so every tenant table has
--     a leading-company_id composite index for the common query.
--   - JSONB attributes are queried with `?` / `->>` — GIN indexes cover both.
--   - Time-bucketed queries (funnel by day/week/month) need (company_id, date).
-- =============================================================================

-- Tenancy lookups
create index app_users_company_idx on app_users (company_id);

-- Ads
create index ad_accounts_company_idx on ad_accounts (company_id);
create index campaigns_company_account_idx on campaigns (company_id, ad_account_id);
create index ad_sets_company_campaign_idx on ad_sets (company_id, campaign_id);
create index ads_company_adset_idx on ads (company_id, ad_set_id);
create index ad_metrics_daily_company_date_idx on ad_metrics_daily (company_id, date);
create index ad_metrics_daily_ad_date_idx on ad_metrics_daily (ad_id, date);

-- Leads
create index leads_company_created_idx on leads (company_id, created_at desc);
create index leads_attributes_gin on leads using gin (attributes);

-- Attribution
create index lead_attribution_company_lead_idx on lead_attribution (company_id, lead_id);
create index lead_attribution_company_ad_idx on lead_attribution (company_id, ad_id);
create index lead_attribution_fbclid_idx on lead_attribution (fbclid) where fbclid is not null;

-- Bookings
create index bookings_company_scheduled_idx on bookings (company_id, scheduled_at);
create index bookings_company_lead_idx on bookings (company_id, lead_id);
create index bookings_status_idx on bookings (company_id, status);
create index bookings_attributes_gin on bookings using gin (attributes);

-- Deals
create index deals_company_stage_idx on deals (company_id, stage_id);
create index deals_company_lead_idx on deals (company_id, lead_id);
create index deals_company_status_idx on deals (company_id, status);
create index deal_stage_history_deal_idx on deal_stage_history (deal_id, changed_at);

-- Lead events
create index lead_events_company_occurred_idx on lead_events (company_id, occurred_at);
create index lead_events_company_lead_idx on lead_events (company_id, lead_id, occurred_at);
create index lead_events_company_type_idx on lead_events (company_id, event_type, occurred_at);
create index lead_events_company_ad_idx on lead_events (company_id, ad_id, occurred_at) where ad_id is not null;
create index lead_events_attributes_gin on lead_events using gin (attributes);

-- Ingestion
create index webhook_inbox_pending_idx on webhook_inbox (received_at) where status in ('pending', 'failed');
create index webhook_inbox_company_received_idx on webhook_inbox (company_id, received_at desc);
create index webhook_processing_log_inbox_idx on webhook_processing_log (webhook_inbox_id);
create index field_proposals_pending_idx on field_proposals (company_id, created_at desc) where status = 'pending';
