import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseAdminClient } from 'db/admin';
import { formatDateTime } from '@/lib/format';
import {
  ALLOWED_PG_TYPES,
  inferredToPgType,
  loadProposalSample,
} from '@/lib/proposals';
import {
  approveProposal,
  rejectProposal,
  reopenProposal,
} from '../actions';

export default async function ProposalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string; id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { company: slug, id } = await params;
  const { error } = await searchParams;

  const admin = createSupabaseAdminClient();

  const { data: proposal } = await admin
    .from('field_proposals')
    .select(
      'id, company_id, proposal_kind, entity, field_key, example_value, inferred_type, occurrence_count, status, target_column_name, target_column_type, drop_attribute_after, applied_at, decided_at, notes, created_at, last_seen_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (!proposal) notFound();

  const fmt = { currency: 'EUR', locale: 'de-DE' };
  const entity = proposal.entity as 'leads' | 'bookings' | 'deals';
  const fieldKey = proposal.field_key as string | null;

  const sample = fieldKey
    ? await loadProposalSample(admin, proposal.company_id as string, entity, fieldKey, 20)
    : { total: 0, recentValues: [] };

  const defaultColumnName =
    (proposal.target_column_name as string | null) ?? fieldKey ?? '';
  const defaultColumnType =
    (proposal.target_column_type as string | null) ??
    inferredToPgType(proposal.inferred_type as string | null);

  const isPending = proposal.status === 'pending';
  const isApplied = proposal.status === 'applied';
  const isRejected = proposal.status === 'rejected';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Link href={`/${slug}/proposals`} className="hover:text-foreground">
          ← Proposals
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold">
          <code className="rounded bg-muted px-2 py-1">
            {entity}.{fieldKey}
          </code>
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Seen {proposal.occurrence_count} time
          {proposal.occurrence_count === 1 ? '' : 's'}, first observed{' '}
          {formatDateTime(proposal.created_at as string, fmt)}.{' '}
          <span className="font-medium text-foreground">
            Data is not at risk while you decide
          </span>{' '}
          — every value is already stored in{' '}
          <code className="rounded bg-muted px-1">attributes</code>. Promotion
          only changes how it&apos;s queried.
        </p>
      </header>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {decodeURIComponent(error)}
        </div>
      )}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border">
          <div className="border-b border-border bg-muted/30 px-4 py-2 text-sm font-medium">
            Recent values · {sample.recentValues.length} distinct out of{' '}
            {sample.total} carrying rows in the last 500 records
          </div>
          <div className="max-h-96 overflow-auto">
            {sample.recentValues.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No values found in the most recent 200 rows.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Value</th>
                    <th className="px-3 py-2 text-right">First seen</th>
                  </tr>
                </thead>
                <tbody>
                  {sample.recentValues.map((v, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">
                        {formatValue(v.value)}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                        {formatDateTime(v.createdAt, fmt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border">
          <div className="border-b border-border bg-muted/30 px-4 py-2 text-sm font-medium">
            Status
          </div>
          <dl className="divide-y divide-border text-sm">
            <Row label="State">
              <StatusPill status={proposal.status as string} />
            </Row>
            <Row label="Inferred type">
              <code className="rounded bg-muted px-1 text-xs">
                {(proposal.inferred_type as string | null) ?? '—'}
              </code>
            </Row>
            <Row label="Example value">
              <code className="rounded bg-muted px-1 text-xs">
                {formatValue(proposal.example_value)}
              </code>
            </Row>
            {isApplied && (
              <>
                <Row label="Promoted to">
                  <code className="rounded bg-muted px-1 text-xs">
                    {entity}.{proposal.target_column_name as string} (
                    {proposal.target_column_type as string})
                  </code>
                </Row>
                <Row label="Applied at">
                  {formatDateTime(proposal.applied_at as string | null, fmt)}
                </Row>
              </>
            )}
            {isRejected && (
              <Row label="Rejected at">
                {formatDateTime(proposal.decided_at as string | null, fmt)}
              </Row>
            )}
            {(proposal.notes as string | null) && (
              <Row label="Notes">{proposal.notes as string}</Row>
            )}
          </dl>
        </div>
      </section>

      {isPending && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <form
            action={approveProposal}
            className="space-y-4 rounded-lg border border-border p-4"
          >
            <h2 className="text-base font-semibold">Approve & promote</h2>
            <input type="hidden" name="proposal_id" value={proposal.id as string} />
            <input type="hidden" name="company_slug" value={slug} />

            <label className="block space-y-1">
              <span className="text-sm font-medium">Column name</span>
              <input
                name="target_column_name"
                defaultValue={defaultColumnName}
                pattern="[a-z_][a-z0-9_]*"
                required
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-foreground/20"
              />
              <span className="text-xs text-muted-foreground">
                lowercase, digits, underscores
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Type</span>
              <select
                name="target_column_type"
                defaultValue={defaultColumnType}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
              >
                {ALLOWED_PG_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                name="drop_attribute_after"
                className="mt-1"
              />
              <span className="text-sm">
                Drop key from{' '}
                <code className="rounded bg-muted px-1 text-xs">attributes</code>{' '}
                after backfill
                <br />
                <span className="text-xs text-muted-foreground">
                  Recommended after the AI starts writing to the typed column —
                  leave unchecked for now (a daily cron keeps the column in sync).
                </span>
              </span>
            </label>

            <details className="rounded-md bg-muted/40 p-3 text-xs">
              <summary className="cursor-pointer font-medium">SQL preview</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
{`alter table ${entity}
  add column if not exists ${defaultColumnName} ${defaultColumnType};

update ${entity}
   set ${defaultColumnName} = (attributes ->> '${fieldKey}')::${defaultColumnType}
 where company_id = '${proposal.company_id as string}'
   and (attributes ? '${fieldKey}');

-- only if "drop key" is checked:
-- update ${entity} set attributes = attributes - '${fieldKey}'
--  where company_id = '${proposal.company_id as string}' and attributes ? '${fieldKey}';`}
              </pre>
            </details>

            <button
              type="submit"
              className="w-full rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90"
            >
              Approve & apply
            </button>
          </form>

          <form
            action={rejectProposal}
            className="space-y-4 rounded-lg border border-border p-4"
          >
            <h2 className="text-base font-semibold">Reject</h2>
            <input type="hidden" name="proposal_id" value={proposal.id as string} />
            <input type="hidden" name="company_slug" value={slug} />

            <p className="text-sm text-muted-foreground">
              Marks this proposal as rejected. The existing values in{' '}
              <code className="rounded bg-muted px-1">attributes</code> are{' '}
              <strong>not</strong> deleted — only this proposal queue entry is
              cleared. Future webhooks may re-propose the same key.
            </p>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Notes (optional)</span>
              <textarea
                name="notes"
                rows={3}
                placeholder="e.g. duplicate of `industry`; not useful for reporting"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
              />
            </label>

            <button
              type="submit"
              className="w-full rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              Reject
            </button>
          </form>
        </section>
      )}

      {isRejected && (
        <form
          action={reopenProposal}
          className="rounded-lg border border-border p-4"
        >
          <input type="hidden" name="proposal_id" value={proposal.id as string} />
          <input type="hidden" name="company_slug" value={slug} />
          <h2 className="text-base font-semibold">Re-open</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Move this proposal back into the pending queue.
          </p>
          <button
            type="submit"
            className="mt-3 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            Re-open
          </button>
        </form>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'pending'
      ? 'bg-amber-50 text-amber-700'
      : status === 'approved'
        ? 'bg-blue-50 text-blue-700'
        : status === 'applied'
          ? 'bg-emerald-50 text-emerald-700'
          : 'bg-muted text-muted-foreground';
  return <span className={`rounded px-2 py-1 text-xs ${tone}`}>{status}</span>;
}

function formatValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  return JSON.stringify(value).slice(0, 120);
}
