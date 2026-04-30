'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { PRESETS, type RangePreset } from '@/lib/range';
import { cn } from '@/lib/utils';

interface Props {
  preset: RangePreset;
  fromIso: string;
  toIsoInclusive: string;
}

export function DateRangePicker({ preset, fromIso, toIsoInclusive }: Props) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const [from, setFrom] = useState(fromIso);
  const [to, setTo] = useState(toIsoInclusive);

  function applyPreset(key: RangePreset) {
    const sp = new URLSearchParams(params);
    sp.delete('from');
    sp.delete('to');
    sp.set('range', key);
    router.push(`${pathname}?${sp.toString()}`);
  }

  function applyCustom() {
    if (!from || !to) return;
    const sp = new URLSearchParams(params);
    sp.delete('range');
    sp.set('from', from);
    sp.set('to', to);
    router.push(`${pathname}?${sp.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => applyPreset(p.key)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs',
              p.key === preset
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {p.short}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1 text-xs">
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1"
        />
        <span className="text-muted-foreground">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1"
        />
        <button
          type="button"
          onClick={applyCustom}
          disabled={from === fromIso && to === toIsoInclusive}
          className={cn(
            'rounded-md border border-border px-2 py-1 text-xs',
            from === fromIso && to === toIsoInclusive
              ? 'cursor-not-allowed text-muted-foreground'
              : 'hover:bg-muted hover:text-foreground',
          )}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
