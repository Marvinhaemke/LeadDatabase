# Lead Funnel Dashboard

End-to-end funnel tracking for ad-driven sales pipelines: Ads → Landing →
Booking → Sales → Close, with conversion rates, show-up rate, ROAS, and
per-ad metrics. Built on Supabase + Next.js, with a Gemini Flash
ingestion layer that normalises arbitrary webhook data into the schema.

## Layout

```
apps/dashboard          Next.js 15 frontend (App Router, Tailwind)
packages/db             Supabase clients + generated types
supabase/migrations     SQL schema, RLS, views, auth hook
supabase/seed.sql       Local dev seed
docs/funnel-semantics.md  How metrics are defined (read this first)
scripts/export-company.ts  Per-company SQL export for offboarding
```

## Getting started

```bash
pnpm install
cp .env.example .env.local

# spin up local Supabase (Docker required)
pnpm db:start
pnpm db:reset            # apply migrations + seed
pnpm db:types            # generate packages/db/src/generated.ts

pnpm dev                 # http://localhost:3000
```

## Architecture summary

- **Single Supabase project, multi-tenant via RLS.** Every tenant table has
  `company_id uuid not null`; policies derive from JWT claims set by the
  custom access-token hook (`app.is_admin()` / `app.current_company_id()`).
- **Append-only event log (`lead_events`)** is the source of truth for all
  funnel metrics. `bookings` and `deals` are projections; views are derived.
- **JSONB-hybrid schema.** Unknown webhook fields land in `attributes jsonb`;
  hot keys get promoted to typed columns via human-approved migrations.
  The AI never issues DDL.
- **Ingestion**: Next.js webhook routes write raw payloads to `webhook_inbox`
  (idempotent), then a worker calls Gemini Flash to produce a structured
  plan, validates it with Zod, and applies it inside a transaction.
- **Per-company export** is one SQL script away — no FK crosses company_id.

See `docs/funnel-semantics.md` for the exact metric definitions.
