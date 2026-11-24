import type { Kpi } from "@engine/db/compute";
import { Spark } from "@/components/spark";
import { cn, fmt } from "@/lib/utils";

/** For these, a falling number is good. */
const LOWER_IS_BETTER = new Set(["cac", "burn", "api"]);

export const kpiValue = (k: Kpi) => (k.unit === "usd" ? fmt.usd(k.value) : k.unit === "months" ? `${fmt.num(k.value, 1)} mo` : fmt.num(k.value));
export const kpiGood = (k: Kpi) => (k.delta == null ? true : LOWER_IS_BETTER.has(k.key) ? k.delta <= 0 : k.delta >= 0);

/** One instrument on the KPI rail: label, value, delta, trend. */
export function KpiCard({ k, className }: { k: Kpi; className?: string }) {
  const good = kpiGood(k);
  return (
    <div className={cn("min-w-0 px-3 py-2.5", className)} title={k.hint}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label truncate">{k.label}</span>
        {k.delta != null && <span className={cn("num font-mono text-[10.5px]", good ? "text-success" : "text-destructive")}>{fmt.signedPct(k.delta)}</span>}
      </div>
      <div className="num mt-1 font-mono text-[19px] font-semibold leading-none">{kpiValue(k)}</div>
      <Spark data={k.series.map((p) => p.value)} tone={good ? "primary" : "destructive"} height={26} className="mt-1.5" />
    </div>
  );
}
