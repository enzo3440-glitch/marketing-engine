// Server-rendered SVG sparkline: no chart library on the pages that only need a trend line.
import { cn } from "@/lib/utils";

export function Spark({ data, tone = "primary", height = 32, className, area = true }: {
  data: number[]; tone?: "primary" | "destructive" | "warning" | "info" | "muted"; height?: number; className?: string; area?: boolean;
}) {
  if (data.length < 2) return <div style={{ height }} className={className} />;
  const w = 100, h = height, pad = 2;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - pad - ((v - min) / span) * (h - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  const color = `hsl(var(--${tone === "muted" ? "muted-foreground" : tone}))`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("block w-full overflow-visible", className)} style={{ height }} aria-hidden>
      {area && <path d={`${line}L${w},${h}L0,${h}Z`} fill={color} opacity={0.12} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={1.8} fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Horizontal meter, e.g. spend vs budget. Over 100% turns amber, over 120% red. */
export function Meter({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? value / max : 0;
  const tone = pct > 1.2 ? "bg-destructive" : pct > 1 ? "bg-warning" : "bg-primary";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, pct * 100)}%` }} />
    </div>
  );
}
