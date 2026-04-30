import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { formatDateTime } from '@/lib/format';

interface InboxRow {
  id: string;
  source: string;
  source_event: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  idempotency_key: string;
  payload: unknown;
  headers: Record<string, string> | null;
  received_at: string;
  processed_at: string | null;
}

interface ProcessingLogRow {
  id: string;
  model: string;
  prompt_version: string;
  decision: Record<string, unknown> | null;
  applied_changes: Record<string, unknown> | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}

export default async function InboxDetailPage({
  params,
}: {
  params: Promise<{ company: string; id: string }>;
}) {
  const { company: slug, id } = await params;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .single();
  if (!company) notFound();

  const fmt = { currency: 'EUR', locale: 'de-DE' };

  const [inboxRes, logRes] = await Promise.all([
    client
      .from('webhook_inbox')
      .select(
        'id, source, source_event, status, attempts, last_error, idempotency_key, payload, headers, received_at, processed_at',
      )
      .eq('company_id', company.id as string)
      .eq('id', id)
      .maybeSingle(),
    client
      .from('webhook_processing_log')
      .select(
        'id, model, prompt_version, decision, applied_changes, latency_ms, prompt_tokens, completion_tokens, created_at',
      )
      .eq('company_id', company.id as string)
      .eq('webhook_inbox_id', id)
      .order('created_at', { ascending: false }),
  ]);

  const row = inboxRes.data as unknown as InboxRow | null;
  if (!row) notFound();
  const logs = (logRes.data ?? []) as unknown as ProcessingLogRow[];
  const latestLog = logs[0] ?? null;

  const applied = latestLog?.applied_changes as
    | {
        leadId?: string;
        bookingId?: string;
        dealId?: string;
        eventIds?: string[];
        proposalIds?: string[];
        attributedAdId?: string;
        attributedVia?: string;
        ignored?: boolean;
        ignoreReason?: string;
        warnings?: string[];
      }
    | null
    | undefined;

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link href={`/${slug}/inbox`} className="hover:text-foreground">
          ← Inbox
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold">
          <span className="font-mono">{row.source}</span>
          {row.source_event && (
            <span className="ml-2 text-base text-muted-foreground">
              {row.source_event}
            </span>
          )}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <StatusPill status={row.status} />
          <span>received {formatDateTime(row.received_at, fmt)}</span>
          {row.processed_at && <span>processed {formatDateTime(row.processed_at, fmt)}</span>}
          <span>attempts: {row.attempts}</span>
        </div>
        {row.last_error && (
          <pre className="mt-3 max-h-48 overflow-auto rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {row.last_error}
          </pre>
        )}
      </header>

      {applied && (
        <section className="rounded-lg border border-border p-4">
          <h2 className="text-base font-semibold">Applied to database</h2>
          {applied.ignored ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Ignored: {applied.ignoreReason ?? '(no reason given)'}
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {applied.leadId && (
                <li>
                  Lead:{' '}
                  <Link
                    href={`/${slug}/leads/${applied.leadId}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {applied.leadId}
                  </Link>
                </li>
              )}
              {applied.bookingId && (
                <li>
                  Booking: <span className="font-mono text-xs">{applied.bookingId}</span>
                </li>
              )}
              {applied.dealId && (
                <li>
                  Deal: <span className="font-mono text-xs">{applied.dealId}</span>
                </li>
              )}
              {applied.eventIds && applied.eventIds.length > 0 && (
                <li>
                  Events written: <span className="tabular-nums">{applied.eventIds.length}</span>
                </li>
              )}
              {applied.attributedAdId && (
                <li>
                  Attributed ad: <span className="font-mono text-xs">{applied.attributedAdId}</span>
                  {applied.attributedVia && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      via {applied.attributedVia}
                    </span>
                  )}
                </li>
              )}
              {applied.proposalIds && applied.proposalIds.length > 0 && (
                <li>
                  Field proposals: <span className="tabular-nums">{applied.proposalIds.length}</span>
                  <Link
                    href={`/${slug}/proposals`}
                    className="ml-2 text-xs underline hover:text-foreground"
                  >
                    review
                  </Link>
                </li>
              )}
            </ul>
          )}
          {applied.warnings && applied.warnings.length > 0 && (
            <div className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
              {applied.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
        </section>
      )}

      {latestLog && (
        <section className="rounded-lg border border-border p-4">
          <h2 className="text-base font-semibold">AI decision</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {latestLog.model} · prompt {latestLog.prompt_version} · {latestLog.latency_ms ?? '—'}ms
            {latestLog.prompt_tokens != null && (
              <>
                {' '}
                · {latestLog.prompt_tokens} prompt + {latestLog.completion_tokens ?? 0} completion tokens
              </>
            )}
          </p>
          <details className="mt-3" open>
            <summary className="cursor-pointer text-sm font-medium">Plan returned by Gemini</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/30 p-3 text-xs">
{JSON.stringify(latestLog.decision ?? {}, null, 2)}
            </pre>
          </details>
          {logs.length > 1 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Older attempts ({logs.length - 1}) hidden — query
              <code className="mx-1 rounded bg-muted px-1">webhook_processing_log</code> directly to inspect.
            </p>
          )}
        </section>
      )}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-base font-semibold">Raw payload</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Stored verbatim in <code className="rounded bg-muted px-1">webhook_inbox.payload</code>.
          </p>
          <pre className="mt-2 max-h-[500px] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs">
{JSON.stringify(row.payload, null, 2)}
          </pre>
        </div>

        <div>
          <h2 className="text-base font-semibold">Headers</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Auth secrets (<code className="rounded bg-muted px-1">x-ingest-secret</code>,{' '}
            <code className="rounded bg-muted px-1">authorization</code>,{' '}
            <code className="rounded bg-muted px-1">cookie</code>) are stripped at ingest.
          </p>
          <pre className="mt-2 max-h-[500px] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs">
{JSON.stringify(row.headers ?? {}, null, 2)}
          </pre>
          <div className="mt-4 text-xs text-muted-foreground">
            <div>
              <span className="font-medium">Idempotency key:</span>{' '}
              <code className="rounded bg-muted px-1">{row.idempotency_key}</code>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
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
  return <span className={`rounded px-2 py-1 text-xs ${tone}`}>{status}</span>;
}
