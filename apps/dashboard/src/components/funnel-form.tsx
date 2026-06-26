'use client';

import { useMemo, useState } from 'react';
import { FILTER_FIELDS, FILTER_OPS, type FilterCondition } from 'ai/funnel-rules';
import { cn } from '@/lib/utils';

interface FunnelFormProps {
  companySlug: string;
  /** Provided on edit; undefined on create. */
  initial?: {
    id: string;
    key: string;
    label: string;
    description: string | null;
    priority: number;
    filters: FilterCondition[];
  };
  /** Pre-fill from a suggestion (only used on the create form). */
  prefill?: {
    label?: string;
    filters?: FilterCondition[];
  };
  /** Server action this form posts to. */
  action: (formData: FormData) => Promise<void>;
  /** Submit-button label. */
  submitLabel: string;
}

const OP_NEEDS_NO_VALUE = new Set(['is_set', 'is_not_set']);
const OP_NEEDS_ARRAY = new Set(['in', 'not_in']);

export function FunnelForm({
  companySlug,
  initial,
  prefill,
  action,
  submitLabel,
}: FunnelFormProps) {
  const [label, setLabel] = useState(initial?.label ?? prefill?.label ?? '');
  const [key, setKey] = useState(initial?.key ?? '');
  const [keyEdited, setKeyEdited] = useState(!!initial);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [priority, setPriority] = useState(String(initial?.priority ?? 100));
  const [filters, setFilters] = useState<FilterCondition[]>(
    initial?.filters ?? prefill?.filters ?? [
      { field: 'utm_source', op: 'eq', value: '' },
    ],
  );

  // Auto-derive key from label until the operator edits it manually.
  function onLabelChange(v: string) {
    setLabel(v);
    if (!keyEdited) setKey(slugify(v));
  }

  function addFilter() {
    setFilters((prev) => [...prev, { field: 'utm_source', op: 'eq', value: '' }]);
  }
  function removeFilter(i: number) {
    setFilters((prev) => prev.filter((_, j) => j !== i));
  }
  function updateFilter(i: number, patch: Partial<FilterCondition>) {
    setFilters((prev) =>
      prev.map((f, j) => {
        if (j !== i) return f;
        const merged = { ...f, ...patch } as FilterCondition;
        // Coerce value shape when the op changes between scalar / array / none.
        const op = merged.op;
        if (OP_NEEDS_NO_VALUE.has(op)) {
          return { field: merged.field, op } as FilterCondition;
        }
        if (OP_NEEDS_ARRAY.has(op)) {
          const arr = Array.isArray((merged as { value?: unknown }).value)
            ? ((merged as { value: string[] }).value)
            : typeof (merged as { value?: unknown }).value === 'string'
              ? ((merged as { value: string }).value.split(',').map((s) => s.trim()).filter(Boolean))
              : [];
          return { field: merged.field, op, value: arr.length ? arr : [''] } as FilterCondition;
        }
        const val = (merged as { value?: unknown }).value;
        const str = Array.isArray(val) ? val.join(', ') : (val as string | undefined) ?? '';
        return { field: merged.field, op, value: str } as FilterCondition;
      }),
    );
  }

  // Serialised filters posted to the server action.
  const filtersJson = useMemo(() => JSON.stringify(normaliseFilters(filters)), [filters]);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="company_slug" value={companySlug} />
      {initial && <input type="hidden" name="funnel_id" value={initial.id} />}
      <input type="hidden" name="filters" value={filtersJson} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Label</span>
          <input
            type="text"
            name="label"
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            required
            placeholder="e.g. VSL — Consulting Lead Gen"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Key</span>
          <input
            type="text"
            name="key"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setKeyEdited(true);
            }}
            required
            pattern="[a-z0-9_-]+"
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
          <span className="text-xs text-muted-foreground">
            Machine identifier — appears as <code className="rounded bg-muted px-1">funnel_key</code> on stamped events.
          </span>
        </label>

        <label className="block space-y-1 md:col-span-2">
          <span className="text-sm font-medium">Description (optional)</span>
          <textarea
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What kind of traffic does this funnel represent?"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Priority</span>
          <input
            type="number"
            name="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            min={0}
            max={10000}
            className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
          />
          <span className="text-xs text-muted-foreground">
            Lower wins when multiple funnels match the same event. Default 100 — use 10 for "specific" funnels and 200+ for catch-alls.
          </span>
        </label>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Filters (all must match)</span>
          <button
            type="button"
            onClick={addFilter}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            + Add filter
          </button>
        </div>

        {filters.length === 0 && (
          <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            A funnel needs at least one filter. Add one to define which leads belong.
          </div>
        )}

        <div className="space-y-2">
          {filters.map((f, i) => (
            <FilterRow
              key={i}
              filter={f}
              onChange={(patch) => updateFilter(i, patch)}
              onRemove={() => removeFilter(i)}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90"
        >
          {submitLabel}
        </button>
        <a
          href={`/${companySlug}/funnels`}
          className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

function FilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: FilterCondition;
  onChange: (patch: Partial<FilterCondition>) => void;
  onRemove: () => void;
}) {
  const op = filter.op;
  const needsValue = !OP_NEEDS_NO_VALUE.has(op);
  const isArray = OP_NEEDS_ARRAY.has(op);
  const value = isArray
    ? Array.isArray((filter as { value?: unknown }).value)
      ? ((filter as { value: string[] }).value).join(', ')
      : ((filter as { value?: string }).value ?? '')
    : ((filter as { value?: string }).value ?? '');

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
      <select
        value={filter.field}
        onChange={(e) => onChange({ field: e.target.value as FilterCondition['field'] })}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
      >
        {FILTER_FIELDS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>

      <select
        value={op}
        onChange={(e) => onChange({ op: e.target.value as FilterCondition['op'] })}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
      >
        {FILTER_OPS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>

      {needsValue && (
        <input
          type="text"
          value={value}
          onChange={(e) =>
            onChange(
              isArray
                ? ({ value: e.target.value.split(',').map((s) => s.trim()) } as Partial<FilterCondition>)
                : ({ value: e.target.value } as Partial<FilterCondition>),
            )
          }
          placeholder={isArray ? 'a, b, c' : 'value'}
          className="flex-1 min-w-[180px] rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className={cn(
          'rounded-md border border-border px-2 py-1 text-xs text-red-700 hover:bg-red-50',
        )}
        aria-label="Remove filter"
      >
        ✕
      </button>
    </div>
  );
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

/**
 * Drop empty filter rows and trim array values before serialising —
 * server-side Zod is strict about non-empty arrays for in/not_in.
 */
function normaliseFilters(filters: FilterCondition[]): FilterCondition[] {
  return filters
    .map((f) => {
      if (OP_NEEDS_NO_VALUE.has(f.op)) return f;
      if (OP_NEEDS_ARRAY.has(f.op)) {
        const arr = Array.isArray((f as { value?: unknown }).value)
          ? ((f as { value: string[] }).value).map((s) => s.trim()).filter(Boolean)
          : typeof (f as { value?: unknown }).value === 'string'
            ? ((f as { value: string }).value).split(',').map((s) => s.trim()).filter(Boolean)
            : [];
        return { field: f.field, op: f.op, value: arr } as FilterCondition;
      }
      const v = ((f as { value?: string }).value ?? '').trim();
      return { field: f.field, op: f.op, value: v } as FilterCondition;
    })
    .filter((f) => {
      if (OP_NEEDS_NO_VALUE.has(f.op)) return true;
      if (OP_NEEDS_ARRAY.has(f.op)) return ((f as { value: string[] }).value).length > 0;
      return ((f as { value: string }).value).length > 0;
    });
}
