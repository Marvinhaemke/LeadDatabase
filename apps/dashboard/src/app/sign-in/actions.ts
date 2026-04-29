'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    redirect(`/sign-in?error=${encodeURIComponent('Email and password are required')}`);
  }

  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
  }

  // Resolve role + company to land on the right page.
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect('/sign-in');

  const { data } = await client
    .from('app_users')
    .select('role, companies:company_id ( slug )')
    .eq('user_id', user.id)
    .maybeSingle();

  const role = data?.role as 'admin' | 'member' | undefined;
  const slug = (data as { companies?: { slug?: string } } | null)?.companies?.slug;

  if (role === 'admin') redirect('/admin');
  if (slug) redirect(`/${slug}`);
  redirect('/awaiting-access');
}

export async function signOut(): Promise<void> {
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);
  await client.auth.signOut();
  redirect('/sign-in');
}
