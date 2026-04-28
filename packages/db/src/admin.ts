import { createClient } from '@supabase/supabase-js';
import type { Database } from './generated';

/**
 * Service-role client. Bypasses RLS — only use on the server, never expose to clients.
 * Used by webhook ingest, Meta sync, and the export-company script.
 */
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
