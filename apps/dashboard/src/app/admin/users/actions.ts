'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseAdminClient } from 'db/admin';
import { getCurrentUser } from '@/lib/auth';

const ALLOWED_ROLES = new Set(['admin', 'member']);

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'admin') throw new Error('forbidden');
  return user;
}

/**
 * Invite a new user. Calls Supabase's auth.admin.inviteUserByEmail which
 * creates the auth user and sends the invite email (configure SMTP in
 * Supabase for production-grade delivery — the default sender is
 * heavily rate-limited). Then provisions the matching app_users row.
 *
 * NOTE: if the auth user is created but the app_users insert fails,
 * the auth user is left in place — it's harmless (they can't sign in
 * meaningfully without the app_users row) and the admin can re-run.
 */
export async function inviteUser(formData: FormData): Promise<void> {
  await requireAdmin();

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const role = String(formData.get('role') ?? 'member');
  const companyIdRaw = String(formData.get('company_id') ?? '');
  const companyId = companyIdRaw === '' ? null : companyIdRaw;

  if (!email || !email.includes('@')) {
    redirect(`/admin/users?error=${encodeURIComponent('valid email required')}`);
  }
  if (!ALLOWED_ROLES.has(role)) {
    redirect(`/admin/users?error=${encodeURIComponent(`unknown role: ${role}`)}`);
  }
  if (role !== 'admin' && !companyId) {
    redirect(
      `/admin/users?error=${encodeURIComponent('member users must be assigned to a company')}`,
    );
  }

  const admin = createSupabaseAdminClient();

  const redirectTo =
    process.env.NEXT_PUBLIC_APP_URL && `${process.env.NEXT_PUBLIC_APP_URL}/sign-in`;
  const { data, error } = await admin.auth.admin.inviteUserByEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  );

  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }
  const userId = data?.user?.id;
  if (!userId) {
    redirect(`/admin/users?error=${encodeURIComponent('invite did not return a user id')}`);
  }

  const { error: insertError } = await admin
    .from('app_users')
    .upsert(
      { user_id: userId, company_id: companyId, role },
      { onConflict: 'user_id' },
    );
  if (insertError) {
    redirect(`/admin/users?error=${encodeURIComponent(insertError.message)}`);
  }

  revalidatePath('/admin/users');
  redirect(
    `/admin/users?invited=${encodeURIComponent(email)}`,
  );
}

/**
 * Update an existing app_users row (role + company). The auth user row
 * is left alone.
 */
export async function updateUser(formData: FormData): Promise<void> {
  await requireAdmin();

  const userId = String(formData.get('user_id') ?? '');
  const role = String(formData.get('role') ?? '');
  const companyIdRaw = String(formData.get('company_id') ?? '');
  const companyId = companyIdRaw === '' ? null : companyIdRaw;

  if (!userId) throw new Error('user_id missing');
  if (!ALLOWED_ROLES.has(role)) {
    redirect(`/admin/users?error=${encodeURIComponent(`unknown role: ${role}`)}`);
  }
  if (role !== 'admin' && !companyId) {
    redirect(
      `/admin/users?error=${encodeURIComponent('member users must be assigned to a company')}`,
    );
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from('app_users')
    .update({ role, company_id: companyId })
    .eq('user_id', userId);
  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath('/admin/users');
  redirect('/admin/users?updated=1');
}

/**
 * Remove app_users access. The auth user row is left in auth.users so
 * the same person can be re-provisioned later without reissuing
 * credentials. To fully delete the auth user, do it manually in
 * Supabase Studio.
 */
export async function removeUser(formData: FormData): Promise<void> {
  await requireAdmin();

  const userId = String(formData.get('user_id') ?? '');
  if (!userId) throw new Error('user_id missing');

  // Never let an admin delete their own access.
  const me = await getCurrentUser();
  if (me?.userId === userId) {
    redirect(
      `/admin/users?error=${encodeURIComponent("can't remove yourself")}`,
    );
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('app_users').delete().eq('user_id', userId);
  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath('/admin/users');
  redirect('/admin/users?removed=1');
}

/**
 * Resend an invite email. Useful when a user's first invite expired or
 * never arrived.
 */
export async function resendInvite(formData: FormData): Promise<void> {
  await requireAdmin();

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!email) throw new Error('email missing');

  const admin = createSupabaseAdminClient();
  const redirectTo =
    process.env.NEXT_PUBLIC_APP_URL && `${process.env.NEXT_PUBLIC_APP_URL}/sign-in`;

  const { error } = await admin.auth.admin.inviteUserByEmail(
    email,
    redirectTo ? { redirectTo } : undefined,
  );
  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/admin/users?invited=${encodeURIComponent(email)}`);
}
