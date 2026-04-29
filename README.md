# Lead Funnel Dashboard

End-to-end funnel tracking for ad-driven sales pipelines: Ads → Landing →
Booking → Sales → Close, with conversion rates, show-up rate, ROAS, and
per-ad metrics. Built on Supabase + Next.js, with a Gemini Flash
ingestion layer that normalises arbitrary webhook data into the schema.

## Layout

```
apps/dashboard          Next.js 15 frontend (App Router, Tailwind)
packages/db             Supabase clients + generated types
packages/ai             Gemini Flash ingestion (plan, normalize, apply)
packages/meta           Meta Marketing API client + daily sync
supabase/migrations     SQL schema, RLS, views, auth hook, RPCs
supabase/seed.sql       Local dev seed
docs/funnel-semantics.md  How metrics are defined (read this first)
scripts/export-company.ts  Per-company SQL export for offboarding
vercel.json             Monorepo install/build + cron schedules
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

## Deploying to Vercel

This repo is a pnpm workspace with the Next.js app at `apps/dashboard`.
Vercel needs to install at the workspace root and build the dashboard
filter — `vercel.json` at the repo root sets that up:

```jsonc
{
  "framework": "nextjs",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm --filter dashboard build",
  "outputDirectory": "apps/dashboard/.next",
  "crons": [ /* webhook processor, no-show sweeper, Meta sync, backfill */ ]
}
```

### Vercel project settings

- **Root Directory:** leave at `.` (the repo root). The `outputDirectory`
  in `vercel.json` points Vercel at `apps/dashboard/.next`.
- **Framework Preset:** Next.js (auto-detected via `vercel.json`).
- **Node version:** 22 (driven by the root `package.json` `engines`).

### Required environment variables

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (RLS-respecting browser/server) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key (ingest worker, cron, RPC calls) |
| `GOOGLE_GEMINI_API_KEY` | Gemini Flash key for ingestion AI |
| `GEMINI_MODEL` | e.g. `gemini-2.5-flash` (optional; default in code) |
| `INGEST_SHARED_SECRET` | Required header on `/api/webhook/*` deliveries |
| `CRON_SECRET` | Vercel-injected; cron routes verify `Authorization: Bearer …` |
| `META_SYSTEM_USER_TOKEN` | Meta Marketing API system-user token (agency-level) |
| `META_API_VERSION` | e.g. `v21.0` (optional; default in code) |

### After first deploy

1. Apply migrations to your Supabase project (Studio SQL editor or
   `supabase db push`).
2. Insert at least one row into `companies` and one matching
   `app_users` row for yourself with `role = 'admin'`.
3. Visit `<your-vercel-url>/sign-in`.
4. Point Zapier / your landing page at
   `https://<your-vercel-url>/api/webhook/<company-slug>/zapier` with
   `x-ingest-secret: <INGEST_SHARED_SECRET>`.
