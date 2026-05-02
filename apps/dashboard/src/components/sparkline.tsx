/**
 * Tiny inline area sparkline. Pure SVG, no client JS, no deps.
 * Renders a smooth line with a faint fill. Auto-scales Y to the data;
 * pads min and max equally so a single high outlier doesn't crush the
 * rest of the series.
 */
interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Tone is just an HSL string; pass any tailwind-friendly color. */
  color?: string;
  className?: string;
}

export function Sparkline({
  values,
  width = 120,
  height = 28,
  color = 'currentColor',
  className,
}: SparklineProps) {
  if (values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        role="img"
        aria-hidden="true"
      />
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  // Pad the y-range so flat-zero series still show as a line, not an
  // overlap with the bottom edge.
  const pad = (max - min) * 0.1 || 1;
  const yMax = max + pad;
  const yMin = Math.min(min - pad, 0);
  const yRange = yMax - yMin || 1;

  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - yMin) / yRange) * height;
    return [x, y] as const;
  });
  const linePath = `M ${points.map(([x, y]) => `${round(x)},${round(y)}`).join(' L ')}`;
  const areaPath =
    `${linePath} ` +
    `L ${round((values.length - 1) * stepX)},${height} ` +
    `L 0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <path d={areaPath} fill={color} fillOpacity={0.12} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function round(n: number): string {
  return n.toFixed(2);
}
