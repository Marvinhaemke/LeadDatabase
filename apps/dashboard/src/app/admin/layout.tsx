import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { SignOutButton } from '@/components/sign-out-button';
import { AdminTabs } from '@/components/admin-tabs';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (user.role !== 'admin') {
    if (user.companySlug) redirect(`/${user.companySlug}`);
    redirect('/awaiting-access');
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Admin</h1>
          <Link
            href="/"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← back to root
          </Link>
        </div>
        <div className="text-xs text-muted-foreground">
          {user.email} <span className="mx-1">·</span> <SignOutButton />
        </div>
      </header>

      <AdminTabs />

      <div className="mt-6">{children}</div>
    </div>
  );
}
