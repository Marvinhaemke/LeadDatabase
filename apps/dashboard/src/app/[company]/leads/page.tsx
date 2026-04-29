import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { formatDateTime } from '@/lib/format';

export default async function LeadsPage({
  params,
}: {
  params: Promise<{ company: string }>;
}) {
  const { company: slug } = await params;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .single();
  if (!company) return null;

  const fmt = { currency: 'EUR', locale: 'de-DE' };

  const { data: leads } = await client
    .from('leads')
    .select('id, email, phone, first_name, last_name, source, created_at')
    .eq('company_id', company.id as string)
    .order('created_at', { ascending: false })
    .limit(100);

  const list = (leads ?? []) as Array<{
    id: string;
    email: string | null;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    source: string | null;
    created_at: string;
  }>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Leads</h1>
        <p className="text-sm text-muted-foreground">
          Most recent 100. Drill-down to event timeline lands next.
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Phone</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No leads yet.
                </td>
              </tr>
            ) : (
              list.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    {[l.first_name, l.last_name].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{l.email ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{l.phone ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {l.source ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                    {formatDateTime(l.created_at, fmt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
