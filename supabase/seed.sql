-- =============================================================================
-- Local development seed
-- Creates one demo company with default pipeline stages so the dashboard
-- has something to render against `supabase start`.
-- =============================================================================

insert into companies (id, slug, name, timezone, currency)
values
  ('00000000-0000-0000-0000-00000000c001', 'acme', 'Acme Co', 'Europe/Berlin', 'EUR')
on conflict (id) do nothing;

insert into pipeline_stages (company_id, key, label, position, is_terminal, is_won)
values
  ('00000000-0000-0000-0000-00000000c001', 'new',           'New Lead',         10, false, false),
  ('00000000-0000-0000-0000-00000000c001', 'setting_call',  'Setting Call',     20, false, false),
  ('00000000-0000-0000-0000-00000000c001', 'qualified',     'Qualified',        30, false, false),
  ('00000000-0000-0000-0000-00000000c001', 'closing_call',  'Closing Call',     40, false, false),
  ('00000000-0000-0000-0000-00000000c001', 'proposal_sent', 'Proposal Sent',    50, false, false),
  ('00000000-0000-0000-0000-00000000c001', 'won',           'Won',              90, true,  true),
  ('00000000-0000-0000-0000-00000000c001', 'lost',          'Lost',             91, true,  false)
on conflict (company_id, key) do nothing;

-- Common field aliases the AI ingest layer can fall back on without calling Gemini.
insert into entity_aliases (company_id, entity, canonical_key, alias)
values
  (null, 'leads', 'first_name', 'firstname'),
  (null, 'leads', 'first_name', 'fname'),
  (null, 'leads', 'first_name', 'vorname'),
  (null, 'leads', 'last_name',  'lastname'),
  (null, 'leads', 'last_name',  'lname'),
  (null, 'leads', 'last_name',  'nachname'),
  (null, 'leads', 'email',      'e-mail'),
  (null, 'leads', 'email',      'mail'),
  (null, 'leads', 'phone',      'phone_number'),
  (null, 'leads', 'phone',      'mobile'),
  (null, 'leads', 'phone',      'telefon')
on conflict (company_id, entity, alias) do nothing;
