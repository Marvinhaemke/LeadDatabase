#!/usr/bin/env -S node --experimental-strip-types
/**
 * Export one company's data into a self-contained SQL file that can be
 * restored into a fresh Supabase project. Used when offboarding a customer.
 *
 *   pnpm tsx scripts/export-company.ts <company-slug> > exports/<slug>.sql
 *
 * Implementation outline (filled in once we have real data shape):
 *   1. Resolve company_id from slug.
 *   2. Stream every tenant-scoped table via
 *        COPY (SELECT * FROM <t> WHERE company_id = $1) TO STDOUT
 *      in dependency order (companies → pipeline_stages → ad_accounts → ...).
 *   3. Optionally redact webhook_inbox.payload.headers (auth tokens etc).
 *   4. Wrap output in a `BEGIN; ... COMMIT;` block.
 *
 * Tenancy rule that makes this trivially safe: no FK ever crosses
 * company_id boundaries (see supabase/migrations/20260101000002_core_tables.sql),
 * so a per-company filter produces a referentially complete export.
 */

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: export-company <company-slug>');
  process.exit(1);
}

console.error(`TODO: implement export for company "${slug}"`);
process.exit(2);
