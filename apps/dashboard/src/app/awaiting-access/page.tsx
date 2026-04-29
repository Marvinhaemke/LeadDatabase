import { signOut } from '../sign-in/actions';
import { getCurrentUser } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function AwaitingAccessPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (user.role === 'admin') redirect('/admin');
  if (user.companySlug) redirect(`/${user.companySlug}`);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">Awaiting access</h1>
        <p className="text-sm text-muted-foreground">
          Your account ({user.email}) hasn&apos;t been linked to a company yet.
          Ask an admin to provision access.
        </p>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
