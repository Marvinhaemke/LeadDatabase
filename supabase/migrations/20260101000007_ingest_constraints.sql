-- =============================================================================
-- Constraints required by the ingest worker for idempotent upserts.
-- =============================================================================

-- Booking source-of-truth dedupe: the same calendar event id arriving twice
-- (Zapier replay, Calendly retries) must update the same row, not insert
-- a duplicate. Partial index because manual bookings have no external_id.
create unique index if not exists bookings_company_external_id_uq
  on bookings (company_id, external_id)
  where external_id is not null;

-- Field-proposals dedupe: one pending row per (entity, field_key) per company.
create unique index if not exists field_proposals_attribute_uq
  on field_proposals (company_id, entity, field_key)
  where field_key is not null;
