/**
 * Multi-series line chart, pure SVG, server-rendered.
 *
 * Designed for daily time-series with a small number of series
 * (3–4 lines). No tooltips yet — hovering highlights the line via
 * CSS only. Add a client-side companion if interactivity is needed.
 */
interface Series {
  /** Object key on each data row. */
  key: string;
  label: string;
  /** Tailwind / hex / hsl — anything CSS accepts. */
  color: string;
}

interface DataRow {
  /** ISO date string YYYY-MM-DD. */
  day: string;
  [k: string]: string | number;
}

interface LineChartProps {
  data: DataRow[];
  series: Series[];
  width?: number;
  height?: number;
  /** Number of horizontal grid lines + Y-axis ticks. */
  yTicks?: number;
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 40 };

export function LineChart({
  data,
  series,
  width = 720,
  height = 240,
  yTicks = 4,
}: LineChartProps) {
  if (data.length === 0 || series.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-8 text-sm text-muted-foreground">
        Not enough data to chart.
      </div>
    );
  }

  // Sort ascending so the X axis flows left → right, regardless of input order.
  const rows = [...data].sort((a, b) => a.day.localeCompare(b.day));

  const innerWidth = width - PADDING.left - PADDING.right;
  const innerHeight = height - PADDING.top - PADDING.bottom;

  // Y range: 0 to padded max across all series (so they share one axis).
  let yMax = 0;
  for (const r of rows) {
    for (const s of series) {
      const v = Number(r[s.key] ?? 0);
      if (v > yMax) yMax = v;
    }
  }
  yMax = Math.max(1, niceCeiling(yMax));
  const yMin = 0;
  const yRange = yMax - yMin;

  const stepX = rows.length === 1 ? 0 : innerWidth / (rows.length - 1);

  const xFor = (i: number) => PADDING.left + i * stepX;
  const yFor = (v: number) =>
    PADDING.top + innerHeight - ((Math.max(yMin, v) - yMin) / yRange) * innerHeight;

  const yTickValues: number[] = [];
  for (let i = 0; i <= yTicks; i++) {
    yTickValues.push(Math.round((yMax / yTicks) * i));
  }

  // X-axis labels: at most 6 evenly spaced.
  const xLabelEvery = Math.max(1, Math.ceil(rows.length / 6));

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img">
        {/* horizontal grid + Y-axis labels */}
        {yTickValues.map((v) => {
          const y = yFor(v);
          return (
            <g key={v}>
              <line
                x1={PADDING.left}
                x2={width - PADDING.right}
                y1={y}
                y2={y}
                stroke="hsl(var(--border))"
                strokeDasharray="2 4"
              />
              <text
                x={PADDING.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="hsl(var(--muted-foreground))"
              >
                {v.toLocaleString()}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {rows.map((r, i) => {
          if (i % xLabelEvery !== 0 && i !== rows.length - 1) return null;
          return (
            <text
              key={r.day}
              x={xFor(i)}
              y={height - PADDING.bottom + 14}
              textAnchor="middle"
              fontSize="10"
              fill="hsl(var(--muted-foreground))"
            >
              {formatDayShort(r.day)}
            </text>
          );
        })}

        {/* one path per series */}
        {series.map((s) => {
          const path = rows
            .map((r, i) => {
              const x = xFor(i);
              const y = yFor(Number(r[s.key] ?? 0));
              return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(' ');
          return (
            <path
              key={s.key}
              d={path}
              stroke={s.color}
              strokeWidth={1.5}
              fill="none"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{ background: s.color }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function niceCeiling(value: number): number {
  if (value <= 1) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const norm = value / base;
  let rounded: number;
  if (norm <= 1) rounded = 1;
  else if (norm <= 2) rounded = 2;
  else if (norm <= 5) rounded = 5;
  else rounded = 10;
  return rounded * base;
}

function formatDayShort(iso: string): string {
  // 'YYYY-MM-DD' → 'MMM D' in en-GB-ish (locale-stable).
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
