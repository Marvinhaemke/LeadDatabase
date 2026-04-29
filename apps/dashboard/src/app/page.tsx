import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (user.role === 'admin') redirect('/admin');
  if (user.companySlug) redirect(`/${user.companySlug}`);
  redirect('/awaiting-access');
}
