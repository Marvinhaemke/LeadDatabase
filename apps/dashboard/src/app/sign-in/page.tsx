import { redirect } from 'next/navigation';
import { signIn } from './actions';
import { getCurrentUser } from '@/lib/auth';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) {
    if (user.role === 'admin') redirect('/admin');
    if (user.companySlug) redirect(`/${user.companySlug}`);
    redirect('/awaiting-access');
  }

  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        action={signIn}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-background p-6 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Lead funnel dashboard
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
        </label>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {decodeURIComponent(error)}
          </p>
        )}

        <button
          type="submit"
          className="w-full rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
