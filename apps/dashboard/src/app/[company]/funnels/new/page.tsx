import Link from 'next/link';
import { type FilterCondition } from 'ai/funnel-rules';
import { FunnelForm } from '@/components/funnel-form';
import { createFunnel } from '../actions';

export default async function NewFunnelPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{ error?: string; suggested?: string }>;
}) {
  const { company: slug } = await params;
  const sp = await searchParams;

  // Suggestion pre-fill — clicked from the list page's suggestions panel.
  let prefill: { label?: string; filters?: FilterCondition[] } | undefined;
  if (sp.suggested) {
    try {
      const decoded = JSON.parse(decodeURIComponent(sp.suggested));
      prefill = {
        label: typeof decoded.label === 'string' ? decoded.label : undefined,
        filters: Array.isArray(decoded.filters) ? decoded.filters : undefined,
      };
    } catch {
      // Ignore malformed prefills.
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link href={`/${slug}/funnels`} className="hover:text-foreground">
          ← Funnels
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold">New funnel</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Define a named funnel and the filter rules that decide which
          leads belong to it. New events will start carrying this
          funnel's key on the next webhook; existing events get re-stamped
          when you click <strong>Rematch all events</strong> on the list.
        </p>
      </header>

      {sp.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      <FunnelForm
        companySlug={slug}
        prefill={prefill}
        action={createFunnel}
        submitLabel="Create funnel"
      />
    </div>
  );
}
