/**
 * Middleware: refreshes the Supabase session on every request so server
 * components see fresh JWT claims (the custom access-token hook puts
 * company_id + app_role there). Route gating itself happens in layouts —
 * middleware just keeps the cookie healthy.
 */
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: req });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return res;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(items) {
        for (const { name, value, options } of items) {
          req.cookies.set(name, value);
          res.cookies.set(name, value, options);
        }
      },
    },
  });

  await supabase.auth.getUser();
  return res;
}

export const config = {
  matcher: [
    // Run on every page route, but skip static assets, the webhook entry
    // (which has its own shared-secret auth) and cron routes.
    '/((?!_next/static|_next/image|favicon.ico|api/webhook|api/cron).*)',
  ],
};
