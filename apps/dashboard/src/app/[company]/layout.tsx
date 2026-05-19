import { redirect } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { RedirectError, requireCompanyAccess } from '@/lib/auth';
import { SidebarNav } from '@/components/sidebar-nav';
import { SignOutButton } from '@/components/sign-out-button';
import { createSupabaseServerClient } from 'db/server';

export default async function CompanyLayout({
  params,
  children,
}: {
  params: Promise<{ company: string }>;
  children: React.ReactNode;
}) {
  const { company: slug } = await params;

  let user;
  try {
    user = await requireCompanyAccess(slug);
  } catch (e) {
    if (e instanceof RedirectError) redirect(e.to);
    throw e;
  }

  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);
  const { data: company } = await client
    .from('companies')
    .select('id, slug, name, currency, timezone')
    .eq('slug', slug)
    .maybeSingle();

  if (!company) redirect('/sign-in');

  const navItems = [
    { href: `/${slug}`, label: 'Overview' },
    { href: `/${slug}/funnel`, label: 'Funnel' },
    { href: `/${slug}/cohorts`, label: 'Cohorts' },
    { href: `/${slug}/ads`, label: 'Ads' },
    { href: `/${slug}/leads`, label: 'Leads' },
    { href: `/${slug}/proposals`, label: 'Field proposals' },
    { href: `/${slug}/inbox`, label: 'Webhook inbox' },
  ];

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col border-r border-border bg-muted/30 p-4">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Company
          </div>
          <div className="mt-1 font-semibold">{company.name}</div>
          {user.role === 'admin' && (
            <Link
              href="/admin"
              className="mt-1 inline-block text-xs text-muted-foreground underline hover:text-foreground"
            >
              Switch company
            </Link>
          )}
        </div>

        <SidebarNav items={navItems} />

        <div className="mt-auto pt-4 text-xs text-muted-foreground">
          <div>{user.email}</div>
          <div className="mt-1">{user.role}</div>
          <div className="mt-2">
            <SignOutButton />
          </div>
        </div>
      </aside>

      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
