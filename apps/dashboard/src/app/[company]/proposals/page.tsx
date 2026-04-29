import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { formatDateTime } from '@/lib/format';

export default async function ProposalsPage({
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

  const { data: proposals } = await client
    .from('field_proposals')
    .select(
      'id, proposal_kind, entity, field_key, example_value, inferred_type, occurrence_count, status, notes, created_at',
    )
    .eq('company_id', company.id as string)
    .in('status', ['pending', 'approved'])
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
    notes: string | null;
    created_at: string;
  }>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Field proposals</h1>
        <p className="text-sm text-muted-foreground">
          Unknown keys the ingest AI saw and stored in
          <code className="mx-1 rounded bg-muted px-1">attributes</code>.
          Approving a proposal queues a normal SQL migration that promotes
          the key to a typed column. Approval/rejection UI lands next.
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Entity</th>
              <th className="px-3 py-2 text-left">Field</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Example</th>
              <th className="px-3 py-2 text-right">Seen</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">First seen</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No pending field proposals — the schema is keeping up with
                  incoming webhooks.
                </td>
              </tr>
            ) : (
              list.map((p) => (
                <tr key={p.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-mono text-xs">{p.entity}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.field_key ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {p.inferred_type ?? '—'}
                  </td>
                  <td className="px-3 py-2 max-w-xs truncate font-mono text-xs">
                    {formatExample(p.example_value)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {p.occurrence_count}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <StatusPill status={p.status} />
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                    {formatDateTime(p.created_at, fmt)}
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

function StatusPill({ status }: { status: 'pending' | 'approved' | 'rejected' | 'applied' }) {
  const tone =
    status === 'pending'
      ? 'bg-amber-50 text-amber-700'
      : status === 'approved'
        ? 'bg-blue-50 text-blue-700'
        : status === 'applied'
          ? 'bg-emerald-50 text-emerald-700'
          : 'bg-muted text-muted-foreground';
  return <span className={`rounded px-2 py-1 ${tone}`}>{status}</span>;
}

function formatExample(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return JSON.stringify(value).slice(0, 80);
}
