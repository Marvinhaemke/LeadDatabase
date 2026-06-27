import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { createSupabaseServerClient } from 'db/server';
import { type FilterCondition } from 'ai/funnel-rules';
import { FunnelForm } from '@/components/funnel-form';
import { updateFunnel } from '../../actions';

export default async function EditFunnelPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string; id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { company: slug, id } = await params;
  const sp = await searchParams;
  const cookieStore = await cookies();
  const client = createSupabaseServerClient(cookieStore);

  const { data } = await client
    .from('funnel_definitions')
    .select('id, key, label, description, priority, filters, archived_at')
    .eq('id', id)
    .maybeSingle();
  if (!data) notFound();

  const initial = {
    id: data.id as string,
    key: data.key as string,
    label: data.label as string,
    description: (data.description as string | null) ?? null,
    priority: data.priority as number,
    filters: (data.filters as FilterCondition[]) ?? [],
  };

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link href={`/${slug}/funnels/${id}`} className="hover:text-foreground">
          ← Back to funnel
        </Link>
      </div>

      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{initial.label}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Edit the filter rules below. Save then run{' '}
            <strong>Rematch all events</strong> on the list page to apply
            changes retroactively.
          </p>
        </div>
        {data.archived_at && (
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
            archived
          </span>
        )}
      </header>

      {sp.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      <FunnelForm
        companySlug={slug}
        initial={initial}
        action={updateFunnel}
        submitLabel="Save changes"
      />
    </div>
  );
}
