import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCurrentUser } from '@/lib/auth';
import { SignOutButton } from '@/components/sign-out-button';
import { createSupabaseServerClient } from 'db/server';

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (user.role !== 'admin') {
    if (user.companySlug) redirect(`/${user.companySlug}`);
    redirect('/awaiting-access');
  }

  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);
  const { data: companies } = await client
    .from('companies')
    .select('id, slug, name, timezone, currency, archived_at, created_at')
    .order('name');

  const list = (companies ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    timezone: string;
    currency: string;
    archived_at: string | null;
    created_at: string;
  }>;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Admin</h1>
          <p className="text-sm text-muted-foreground">
            Pick a company to view its dashboard.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {user.email} <span className="mx-1">·</span> <SignOutButton />
        </div>
      </header>

      {list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No companies yet. Insert one into <code>companies</code> to get started.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map((c) => (
            <li key={c.id}>
              <Link
                href={`/${c.slug}`}
                className="flex items-center justify-between p-4 hover:bg-muted"
              >
                <div>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    /{c.slug} · {c.timezone} · {c.currency}
                  </div>
                </div>
                {c.archived_at && (
                  <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                    archived
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
