import Link from 'next/link';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { createSupabaseAdminClient } from 'db/admin';
import type { FilterCondition } from 'ai/funnel-rules';
import { getFunnelSuggestions } from '@/lib/funnel-suggestions';
import { formatDateTime, formatNumber } from '@/lib/format';
import { archiveFunnel, rematchFunnels, restoreFunnel } from './actions';

interface FunnelRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  priority: number;
  filters: FilterCondition[];
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export default async function FunnelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{
    created?: string;
    updated?: string;
    archived?: string;
    restored?: string;
    rematched?: string;
    error?: string;
    show?: string;
  }>;
}) {
  const { company: slug } = await params;
  const sp = await searchParams;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data: company } = await client
    .from('companies')
    .select('id')
    .eq('slug', slug)
    .single();
  if (!company) return null;

  const fmt = { currency: 'EUR', locale: 'de-DE' };
  const showArchived = sp.show === 'archived';

  const { data: funnels } = await client
    .from('funnel_definitions')
    .select(
      'id, key, label, description, priority, filters, archived_at, created_at, updated_at',
    )
    .eq('company_id', company.id as string)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true });

  const list = (funnels ?? []) as unknown as FunnelRow[];
  const active = list.filter((f) => !f.archived_at);
  const archived = list.filter((f) => f.archived_at);
  const visible = showArchived ? archived : active;

  // Suggestions use the admin client (cross-table read by-pass-RLS;
  // member users would still see their own company's attribution rows).
  const admin = createSupabaseAdminClient();
  const suggestions = await getFunnelSuggestions(admin, company.id as string, 60, 6);

  return (
    <div className="space-y-8">
      {sp.created && (
        <Banner tone="success">Created <code>{decodeURIComponent(sp.created)}</code>.</Banner>
      )}
      {sp.updated && (
        <Banner tone="success">Updated <code>{decodeURIComponent(sp.updated)}</code>.</Banner>
      )}
      {sp.archived && <Banner tone="muted">Funnel archived.</Banner>}
      {sp.restored && <Banner tone="success">Funnel restored.</Banner>}
      {sp.rematched != null && (
        <Banner tone="success">
          Rematched {formatNumber(Number(sp.rematched), fmt)} events against current rules.
        </Banner>
      )}
      {sp.error && <Banner tone="error">{decodeURIComponent(sp.error)}</Banner>}

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Funnel definitions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Define which leads belong to which funnel via filter rules.
            Lowest <code className="rounded bg-muted px-1">priority</code>{' '}
            wins when multiple match. Source-based fallback
            (fbclid → <code>meta</code>, utm_source) still applies when
            no defined funnel matches.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/${slug}/funnels/new`}
            className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90"
          >
            New funnel
          </Link>
          <form action={rematchFunnels}>
            <input type="hidden" name="company_slug" value={slug} />
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
              title="Re-stamp every lead_event with the funnel key its current rule set picks"
            >
              Rematch all events
            </button>
          </form>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-border">
        <Link
          href={`/${slug}/funnels`}
          className={
            !showArchived
              ? 'border-b-2 border-foreground px-3 py-2 text-sm font-medium'
              : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
          }
        >
          Active ({active.length})
        </Link>
        <Link
          href={`/${slug}/funnels?show=archived`}
          className={
            showArchived
              ? 'border-b-2 border-foreground px-3 py-2 text-sm font-medium'
              : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
          }
        >
          Archived ({archived.length})
        </Link>
      </nav>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Priority</th>
              <th className="px-3 py-2 text-left">Label / key</th>
              <th className="px-3 py-2 text-left">Filters</th>
              <th className="px-3 py-2 text-right">Updated</th>
              <th className="px-3 py-2 text-right" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  {showArchived
                    ? 'No archived funnels.'
                    : 'No funnels defined yet. Source-based fallback (meta / email / …) is still active. Create one above, or pre-fill from a suggested cluster below.'}
                </td>
              </tr>
            ) : (
              visible.map((f) => (
                <tr key={f.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 tabular-nums text-xs">{f.priority}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/${slug}/funnels/${f.id}`}
                      className="font-medium hover:underline"
                    >
                      {f.label}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      <code className="rounded bg-muted px-1">{f.key}</code>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    <FilterSummary filters={f.filters} />
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                    {formatDateTime(f.updated_at, fmt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {f.archived_at ? (
                      <form action={restoreFunnel} className="inline">
                        <input type="hidden" name="company_slug" value={slug} />
                        <input type="hidden" name="funnel_id" value={f.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Restore
                        </button>
                      </form>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/${slug}/funnels/${f.id}/edit`}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Edit
                        </Link>
                        <form action={archiveFunnel} className="inline">
                          <input type="hidden" name="company_slug" value={slug} />
                          <input type="hidden" name="funnel_id" value={f.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-border px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                          >
                            Archive
                          </button>
                        </form>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!showArchived && suggestions.length > 0 && (
        <section>
          <h2 className="text-base font-semibold">Suggested funnels (from data)</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Clusters of recent attribution rows grouped by{' '}
            <code className="rounded bg-muted px-1">utm_campaign</code> + URL
            path + source. Click "Use this" to pre-fill a new funnel from the
            cluster's signature.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {suggestions.map((s) => {
              const href = `/${slug}/funnels/new?suggested=${encodeURIComponent(
                JSON.stringify({ label: s.label, filters: s.filters }),
              )}`;
              return (
                <div key={s.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-medium">{s.label}</div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatNumber(s.rowCount, fmt)} rows
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    <FilterSummary filters={s.filters} />
                  </div>
                  <Link
                    href={href}
                    className="mt-3 inline-block rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Use this →
                  </Link>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: 'success' | 'error' | 'muted';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'success'
      ? 'bg-emerald-50 text-emerald-800'
      : tone === 'error'
        ? 'bg-red-50 text-red-700'
        : 'bg-amber-50 text-amber-800';
  return <div className={`rounded-md ${cls} p-3 text-sm`}>{children}</div>;
}

function FilterSummary({ filters }: { filters: FilterCondition[] }) {
  if (!filters || filters.length === 0) return <span>—</span>;
  return (
    <ul className="space-y-0.5">
      {filters.map((f, i) => {
        const value = (() => {
          if (f.op === 'is_set' || f.op === 'is_not_set') return null;
          const v = (f as { value?: string | string[] }).value;
          if (Array.isArray(v)) return v.join(', ');
          return v ?? '';
        })();
        return (
          <li key={i} className="font-mono">
            <span>{f.field}</span> <span className="text-muted-foreground">{f.op}</span>
            {value != null && <span> {value}</span>}
          </li>
        );
      })}
    </ul>
  );
}
