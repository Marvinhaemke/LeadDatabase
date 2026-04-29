import Link from 'next/link';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { formatDateTime } from '@/lib/format';

export default async function ProposalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{ applied?: string; tab?: string }>;
}) {
  const { company: slug } = await params;
  const { applied, tab } = await searchParams;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .single();
  if (!company) return null;

  const fmt = { currency: 'EUR', locale: 'de-DE' };
  const activeTab = (tab as 'pending' | 'applied' | 'rejected') ?? 'pending';

  const { data: proposals } = await client
    .from('field_proposals')
    .select(
      'id, proposal_kind, entity, field_key, example_value, inferred_type, occurrence_count, status, target_column_name, target_column_type, applied_at, created_at',
    )
    .eq('company_id', company.id as string)
    .eq('status', activeTab)
    .order('occurrence_count', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);

  const list = (proposals ?? []) as Array<{
    id: string;
    proposal_kind: string;
    entity: string;
    field_key: string | null;
    example_value: unknown;
    inferred_type: string | null;
    occurrence_count: number;
    status: 'pending' | 'approved' | 'rejected' | 'applied';
    target_column_name: string | null;
    target_column_type: string | null;
    applied_at: string | null;
    created_at: string;
  }>;

  const tabs: Array<{ key: 'pending' | 'applied' | 'rejected'; label: string }> = [
    { key: 'pending', label: 'Pending' },
    { key: 'applied', label: 'Applied' },
    { key: 'rejected', label: 'Rejected' },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Field proposals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Unknown keys the ingest AI saw. Data lives in
          <code className="mx-1 rounded bg-muted px-1">attributes</code> from
          arrival — review at your own pace, nothing is at risk while a
          proposal is pending. Approving promotes the key to a typed column;
          rejecting clears the queue entry without deleting any data.
        </p>
      </header>

      {applied && (
        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
          Applied: <code className="rounded bg-emerald-100 px-1">{decodeURIComponent(applied)}</code>
        </div>
      )}

      <nav className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/${slug}/proposals?tab=${t.key}`}
            className={
              t.key === activeTab
                ? 'border-b-2 border-foreground px-3 py-2 text-sm font-medium'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Entity</th>
              <th className="px-3 py-2 text-left">Field</th>
              <th className="px-3 py-2 text-left">Inferred type</th>
              <th className="px-3 py-2 text-left">Example</th>
              <th className="px-3 py-2 text-right">Seen</th>
              <th className="px-3 py-2 text-right">First / applied</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  {activeTab === 'pending'
                    ? 'No pending field proposals — the schema is keeping up with incoming webhooks.'
                    : `No ${activeTab} proposals yet.`}
                </td>
              </tr>
            ) : (
              list.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-border align-top hover:bg-muted/30"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/${slug}/proposals/${p.id}`}
                      className="hover:underline"
                    >
                      {p.entity}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/${slug}/proposals/${p.id}`}
                      className="hover:underline"
                    >
                      {p.field_key ?? '—'}
                      {p.status === 'applied' && p.target_column_name && (
                        <span className="ml-2 text-muted-foreground">
                          → {p.target_column_name}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {p.inferred_type ?? '—'}
                    {p.status === 'applied' && p.target_column_type && (
                      <span className="ml-1">({p.target_column_type})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 max-w-xs truncate font-mono text-xs">
                    {formatExample(p.example_value)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {p.occurrence_count}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                    {p.status === 'applied'
                      ? formatDateTime(p.applied_at, fmt)
                      : formatDateTime(p.created_at, fmt)}
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

function formatExample(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return JSON.stringify(value).slice(0, 80);
}
