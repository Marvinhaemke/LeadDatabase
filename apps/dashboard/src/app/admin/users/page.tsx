import { createSupabaseAdminClient } from 'db/admin';
import { getCurrentUser } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  inviteUser,
  removeUser,
  resendInvite,
  updateUser,
} from './actions';

interface AppUserRow {
  user_id: string;
  role: 'admin' | 'member';
  company_id: string | null;
  created_at: string;
}

interface AuthUserRow {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  invited_at: string | null;
}

interface CompanyRow {
  id: string;
  slug: string;
  name: string;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; invited?: string; updated?: string; removed?: string }>;
}) {
  const sp = await searchParams;
  const me = await getCurrentUser();
  const admin = createSupabaseAdminClient();

  const [{ data: appUsersData }, authResp, { data: companiesData }] = await Promise.all([
    admin.from('app_users').select('user_id, role, company_id, created_at'),
    admin.auth.admin.listUsers({ perPage: 200 }),
    admin.from('companies').select('id, slug, name').order('name'),
  ]);

  const appUsers = (appUsersData ?? []) as unknown as AppUserRow[];
  const authUsers = (authResp.data?.users ?? []) as unknown as AuthUserRow[];
  const companies = (companiesData ?? []) as unknown as CompanyRow[];
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const authById = new Map(authUsers.map((u) => [u.id, u]));

  const fmt = { currency: 'EUR', locale: 'de-DE' };

  type Combined = AppUserRow & {
    email: string | null;
    confirmed: boolean;
    invitedAt: string | null;
    lastSignIn: string | null;
  };

  const rows: Combined[] = appUsers.map((u) => {
    const a = authById.get(u.user_id);
    return {
      ...u,
      email: a?.email ?? null,
      confirmed: !!a?.email_confirmed_at,
      invitedAt: a?.invited_at ?? null,
      lastSignIn: a?.last_sign_in_at ?? null,
    };
  });

  // Auth users with no app_users row — surface them so they can be provisioned.
  const orphanAuthUsers = authUsers.filter(
    (u) => !appUsers.find((au) => au.user_id === u.id),
  );

  return (
    <div className="space-y-8">
      {sp.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {decodeURIComponent(sp.error)}
        </div>
      )}
      {sp.invited && (
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
          Invite sent to <code>{decodeURIComponent(sp.invited)}</code>.
        </div>
      )}
      {sp.updated && (
        <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">
          User updated.
        </div>
      )}
      {sp.removed && (
        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          Access removed.
        </div>
      )}

      <section className="rounded-lg border border-border p-4">
        <h2 className="text-base font-semibold">Invite a user</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sends a Supabase invite email. The recipient sets a password on
          first sign-in. Members are pinned to one company; admins see all.
        </p>

        <form
          action={inviteUser}
          className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_140px_120px]"
        >
          <input
            name="email"
            type="email"
            required
            placeholder="email@example.com"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
          <select
            name="company_id"
            defaultValue=""
            className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="">— admin (no company) —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.slug})
              </option>
            ))}
          </select>
          <select
            name="role"
            defaultValue="member"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="submit"
            className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90"
          >
            Send invite
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-base font-semibold">Users</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {rows.length} provisioned · auth records: {authUsers.length}
        </p>

        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-left">Role</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Last sign-in</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    No users yet — invite one above.
                  </td>
                </tr>
              ) : (
                rows.map((u) => (
                  <tr key={u.user_id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{u.email ?? '(unknown)'}</div>
                      {!u.email && (
                        <div className="text-xs text-muted-foreground">
                          auth row missing — re-invite
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <CompanySelect
                        userId={u.user_id}
                        currentCompanyId={u.company_id}
                        currentRole={u.role}
                        companies={companies}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <RoleSelect
                        userId={u.user_id}
                        currentRole={u.role}
                        currentCompanyId={u.company_id}
                        companies={companies}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <StatusPill confirmed={u.confirmed} lastSignIn={u.lastSignIn} />
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                      {formatDateTime(u.lastSignIn, fmt) || '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        {u.email && (
                          <form action={resendInvite}>
                            <input type="hidden" name="email" value={u.email} />
                            <button
                              type="submit"
                              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                              title="Resend invite email"
                            >
                              Resend
                            </button>
                          </form>
                        )}
                        {me?.userId !== u.user_id && (
                          <form action={removeUser}>
                            <input type="hidden" name="user_id" value={u.user_id} />
                            <button
                              type="submit"
                              className="rounded-md border border-border px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                              title="Remove access"
                            >
                              Remove
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {orphanAuthUsers.length > 0 && (
        <section>
          <h2 className="text-base font-semibold">Auth users without access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These accounts exist in <code>auth.users</code> but have no
            <code className="mx-1">app_users</code> row. They land on{' '}
            <code>/awaiting-access</code> until provisioned.
          </p>

          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {orphanAuthUsers.map((u) => (
              <li
                key={u.id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs">{u.email}</span>
                <ProvisionForm
                  userId={u.id}
                  companies={companies}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CompanySelect({
  userId,
  currentCompanyId,
  currentRole,
  companies,
}: {
  userId: string;
  currentCompanyId: string | null;
  currentRole: 'admin' | 'member';
  companies: CompanyRow[];
}) {
  return (
    <form action={updateUser} className="flex gap-1">
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="role" value={currentRole} />
      <select
        name="company_id"
        defaultValue={currentCompanyId ?? ''}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none"
      >
        <option value="">— admin (no company) —</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
      >
        Save
      </button>
    </form>
  );
}

function RoleSelect({
  userId,
  currentRole,
  currentCompanyId,
  companies: _companies,
}: {
  userId: string;
  currentRole: 'admin' | 'member';
  currentCompanyId: string | null;
  companies: CompanyRow[];
}) {
  return (
    <form action={updateUser} className="flex gap-1">
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="company_id" value={currentCompanyId ?? ''} />
      <select
        name="role"
        defaultValue={currentRole}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none"
      >
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
      <button
        type="submit"
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
      >
        Save
      </button>
    </form>
  );
}

function ProvisionForm({
  userId,
  companies,
}: {
  userId: string;
  companies: CompanyRow[];
}) {
  return (
    <form action={updateUser} className="flex gap-1">
      <input type="hidden" name="user_id" value={userId} />
      <select
        name="company_id"
        defaultValue=""
        className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none"
      >
        <option value="">admin (no company)</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        name="role"
        defaultValue="member"
        className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none"
      >
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
      <button
        type="submit"
        className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:bg-foreground/90"
      >
        Provision
      </button>
    </form>
  );
}

function StatusPill({
  confirmed,
  lastSignIn,
}: {
  confirmed: boolean;
  lastSignIn: string | null;
}) {
  if (lastSignIn) {
    return (
      <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-700">active</span>
    );
  }
  if (confirmed) {
    return (
      <span className="rounded bg-blue-50 px-2 py-1 text-blue-700">confirmed</span>
    );
  }
  return (
    <span className="rounded bg-amber-50 px-2 py-1 text-amber-700">invited</span>
  );
}
