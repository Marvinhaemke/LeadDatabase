import { cn } from '@/lib/utils';
import { Sparkline } from './sparkline';

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  delta?: { value: string; positive?: boolean } | null;
  /** Daily values, ordered chronologically. Renders a sparkline if present. */
  spark?: number[];
  className?: string;
}

export function KpiCard({ label, value, hint, delta, spark, className }: KpiCardProps) {
  const sparkColor = delta?.positive === false ? 'hsl(0 70% 45%)' : 'hsl(160 60% 35%)';
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-background p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        {spark && spark.length > 1 && (
          <Sparkline values={spark} width={80} height={20} color={sparkColor} />
        )}
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
