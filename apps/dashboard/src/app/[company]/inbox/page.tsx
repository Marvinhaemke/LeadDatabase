import Link from 'next/link';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { formatDateTime } from '@/lib/format';

const STATUSES = ['pending', 'processing', 'processed', 'failed', 'ignored'] as const;
type Status = (typeof STATUSES)[number];

interface InboxRow {
  id: string;
  source: string;
  source_event: string | null;
  status: Status;
  attempts: number;
  last_error: string | null;
  idempotency_key: string;
  received_at: string;
  processed_at: string | null;
}

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{ status?: string; source?: string }>;
}) {
  const { company: slug } = await params;
  const { status: statusParam, source: sourceParam } = await searchParams;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .single();
  if (!company) return null;

  const fmt = { currency: 'EUR', locale: 'de-DE' };
  const activeStatus =
    statusParam && (STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as Status)
      : null;

  let q = client
    .from('webhook_inbox')
    .select(
      'id, source, source_event, status, attempts, last_error, idempotency_key, received_at, processed_at',
    )
    .eq('company_id', company.id as string)
    .order('received_at', { ascending: false })
    .limit(200);

  if (activeStatus) q = q.eq('status', activeStatus);
  if (sourceParam) q = q.eq('source', sourceParam);

  const { data } = await q;
  const rows = (data ?? []) as unknown as InboxRow[];

  // Source filter chips: build from observed sources in this batch.
  const sources = Array.from(new Set(rows.map((r) => r.source))).sort();

  // Counts per status for the tab badges (cheap separate query).
  const { data: counts } = await client
    .from('webhook_inbox')
    .select('status')
    .eq('company_id', company.id as string);
  const countByStatus = new Map<string, number>();
  for (const r of (counts ?? []) as Array<{ status: string }>) {
    countByStatus.set(r.status, (countByStatus.get(r.status) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Webhook inbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Raw payloads received at <code className="rounded bg-muted px-1">/api/webhook/{slug}/&lt;source&gt;</code>.
          Click a row to see the AI's decision and what was applied to the
          database.
        </p>
      </header>

      <nav className="flex flex-wrap items-center gap-1 border-b border-border">
        <FilterChip
          slug={slug}
          status={null}
          source={sourceParam}
          active={activeStatus === null}
          label="All"
          count={null}
        />
        {STATUSES.map((s) => (
          <FilterChip
            key={s}
            slug={slug}
            status={s}
            source={sourceParam}
            active={activeStatus === s}
            label={s}
            count={countByStatus.get(s) ?? 0}
          />
        ))}
        {sources.length > 1 && (
          <div className="ml-auto flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <span>source:</span>
            <Link
              href={buildUrl(slug, activeStatus, null)}
              className={!sourceParam ? 'font-medium text-foreground' : 'hover:text-foreground'}
            >
              all
            </Link>
            {sources.map((s) => (
              <Link
                key={s}
                href={buildUrl(slug, activeStatus, s)}
                className={
                  sourceParam === s
                    ? 'font-medium text-foreground'
                    : 'hover:text-foreground'
                }
              >
                {s}
              </Link>
            ))}
          </div>
        )}
      </nav>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Received</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Attempts</th>
              <th className="px-3 py-2 text-left">Idempotency key</th>
              <th className="px-3 py-2 text-left">Last error</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No matching webhook deliveries.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border align-top hover:bg-muted/30"
                >
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    <Link href={`/${slug}/inbox/${r.id}`} className="hover:underline">
                      {formatDateTime(r.received_at, fmt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Link href={`/${slug}/inbox/${r.id}`} className="hover:underline">
                      <span className="font-medium">{r.source}</span>
                      {r.source_event && (
                        <span className="ml-1 text-muted-foreground">{r.source_event}</span>
                      )}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    {r.attempts}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground max-w-xs truncate">
                    {r.idempotency_key}
                  </td>
                  <td className="px-3 py-2 text-xs text-red-700 max-w-xs truncate">
                    {r.last_error ?? ''}
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

function FilterChip({
  slug,
  status,
  source,
  active,
  label,
  count,
}: {
  slug: string;
  status: Status | null;
  source: string | null | undefined;
  active: boolean;
  label: string;
  count: number | null;
}) {
  return (
    <Link
      href={buildUrl(slug, status, source ?? null)}
      className={
        active
          ? 'border-b-2 border-foreground px-3 py-2 text-sm font-medium'
          : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
      }
    >
      {label}
      {count != null && (
        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">{count}</span>
      )}
    </Link>
  );
}

function buildUrl(slug: string, status: Status | null, source: string | null): string {
  const sp = new URLSearchParams();
  if (status) sp.set('status', status);
  if (source) sp.set('source', source);
  const qs = sp.toString();
  return `/${slug}/inbox${qs ? `?${qs}` : ''}`;
}

function StatusPill({ status }: { status: Status }) {
  const tone =
    status === 'processed'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'failed'
        ? 'bg-red-50 text-red-700'
        : status === 'ignored'
          ? 'bg-muted text-muted-foreground'
          : status === 'processing'
            ? 'bg-blue-50 text-blue-700'
            : 'bg-amber-50 text-amber-700';
  return <span className={`rounded px-2 py-0.5 ${tone}`}>{status}</span>;
}
