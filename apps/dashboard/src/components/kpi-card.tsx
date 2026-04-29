import { cn } from '@/lib/utils';

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  delta?: { value: string; positive?: boolean } | null;
  className?: string;
}

export function KpiCard({ label, value, hint, delta, className }: KpiCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-background p-4',
        className,
      )}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {(hint || delta) && (
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {delta && (
            <span
              className={cn(
                'font-medium',
                delta.positive ? 'text-emerald-600' : 'text-red-600',
              )}
            >
              {delta.value}
            </span>
          )}
          {hint && <span>{hint}</span>}
        </div>
      )}
    </div>
  );
}
