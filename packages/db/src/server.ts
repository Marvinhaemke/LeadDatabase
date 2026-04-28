import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { Database } from './generated';

interface CookieStore {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: CookieOptions): void;
}

/**
 * Create a Supabase client bound to the current request's cookies (RLS-respecting).
 * Pass the Next.js `cookies()` store from a Server Component or Route Handler.
 */
export function createSupabaseServerClient(cookieStore: CookieStore) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      get(name) {
        return cookieStore.get(name)?.value;
      },
      set(name, value, options) {
        try {
          cookieStore.set(name, value, options);
        } catch {
          // No-op in Server Components — cookies are read-only outside Route Handlers/Actions.
        }
      },
      remove(name, options) {
        try {
          cookieStore.set(name, '', { ...options, maxAge: 0 });
        } catch {
          // see above
        }
      },
    },
  });
}
