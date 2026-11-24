"use client";
import { breakevenMonth, burnOf, projectFinance } from "@engine/db/compute";
import type { FinActual, FinScenario, ScenarioAssumptions } from "@engine/db/types";
import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { MultiLine } from "@/components/charts";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Stat, Table, Td, Th } from "@/components/ui";
import { fmt } from "@/lib/utils";

const SLIDERS: { key: keyof ScenarioAssumptions; label: string; min: number; max: number; step: number; f: (v: number) => string }[] = [
  { key: "growth_rate", label: "MAU growth / mo", min: 0, max: 0.25, step: 0.005, f: (v) => fmt.pct(v) },
  { key: "conversion", label: "Paid conversion", min: 0.02, max: 0.25, step: 0.005, f: (v) => fmt.pct(v) },
  { key: "arpu", label: "ARPU / mo", min: 3, max: 20, step: 0.25, f: (v) => fmt.usd(v, 2) },
  { key: "cac", label: "CAC", min: 5, max: 80, step: 1, f: (v) => fmt.usd(v) },
  { key: "churn", label: "Paid churn / mo", min: 0.01, max: 0.15, step: 0.005, f: (v) => fmt.pct(v) },
];

export function FinanceModel({ actuals, scenarios, goalMrr }: { actuals: FinActual[]; scenarios: FinScenario[]; goalMrr: number }) {
  const router = useRouter();
  const base = scenarios.find((s) => s.id === "base") ?? scenarios[0];
  const [custom, setCustom] = useState<ScenarioAssumptions>(base.assumptions);
  const [msg, setMsg] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const projections = useMemo(() => [...scenarios.map((s) => ({ id: s.id, name: s.name, p: projectFinance(actuals, s.assumptions) })), { id: "custom", name: "Custom", p: projectFinance(actuals, custom) }], [actuals, scenarios, custom]);
  const chart = projections[0].p.map((pt, i) => {
    const row: Record<string, number | string> = { date: pt.month };
    for (const pr of projections) row[pr.id] = Math.round(pr.p[i].revenue);
    return row;
  });
  const cashChart = projections[0].p.map((pt, i) => {
    const row: Record<string, number | string> = { date: pt.month };
    for (const pr of projections) row[pr.id] = Math.round(pr.p[i].cash);
    return row;
  });
  const c = projections.find((x) => x.id === "custom")!.p;
  const last = actuals[actuals.length - 1];
  const burn = last ? burnOf(last) : 0;
  const goalMonth = c.find((x) => x.revenue >= goalMrr)?.month ?? null;
  const zeroCash = c.find((x) => x.cash <= 0)?.month ?? null;

  async function importCsv(f: File) {
    try {
      const r = await api<{ rows: number }>("/api/finance/import", { method: "POST", body: await f.text(), headers: { "Content-Type": "text/csv" } });
      setMsg(`Imported ${r.rows} months.`);
      router.refresh();
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="p-3"><Stat label="MRR (last actual)" value={fmt.usd(last?.revenue)} sub={fmt.date(last?.month)} /></Card>
        <Card className="p-3"><Stat label="Monthly burn" value={fmt.usd(burn)} sub="opex + ads + API − revenue" /></Card>
        <Card className="p-3"><Stat label="Runway" value={burn > 0 ? `${(last.cash_end / burn).toFixed(1)} mo` : "∞"} sub={`cash ${fmt.usd(last?.cash_end)}`} /></Card>
        <Card className="p-3"><Stat label="Breakeven (custom)" value={breakevenMonth(c) ? fmt.date(breakevenMonth(c)) : "> 24 mo"} sub={zeroCash ? `cash out ${fmt.date(zeroCash)}` : "cash stays positive"} /></Card>
        <Card className="p-3"><Stat label={`Goal ${fmt.usd(goalMrr)} MRR`} value={goalMonth ? fmt.date(goalMonth) : "> 24 mo"} sub="FIN_GOAL_MRR" /></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Revenue projection · 24 months" description="Base / upside / downside from fin_scenarios, plus your slider scenario. Dashed line = goal." action={<Badge tone="warning">Data-room model is canonical</Badge>} />
          <CardBody>
            <MultiLine data={chart} lines={[...scenarios.map((s) => ({ key: s.id, label: s.name })), { key: "custom", label: "Custom", dashed: true }]} refY={goalMrr} refLabel="goal" />
          </CardBody>
          <CardHeader title="Cash balance" className="border-t" />
          <CardBody><MultiLine data={cashChart} height={200} lines={[...scenarios.map((s) => ({ key: s.id, label: s.name })), { key: "custom", label: "Custom", dashed: true }]} refY={0} refLabel="zero cash" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Scenario sliders" description="Starts from Base" action={<Button size="sm" variant="ghost" onClick={() => setCustom(base.assumptions)}>Reset</Button>} />
          <CardBody className="space-y-4">
            {SLIDERS.map((s) => (
              <label key={s.key} className="block text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">{s.label}</span><span className="num font-medium">{s.f(custom[s.key])}</span></div>
                <input type="range" className="mt-1 w-full accent-[hsl(var(--primary))]" min={s.min} max={s.max} step={s.step} value={custom[s.key]} onChange={(e) => setCustom({ ...custom, [s.key]: Number(e.target.value) })} />
              </label>
            ))}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Actuals" description="Refreshed daily by the Finance Modeler from ops tables. CSV import overwrites matching months." action={
          <div className="flex items-center gap-2">
            {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
            <Button size="sm" variant="outline" onClick={() => file.current?.click()}><Upload className="h-3.5 w-3.5" />Import CSV</Button>
            <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importCsv(f); }} />
          </div>
        } />
        <Table>
          <thead><tr><Th>Month</Th><Th className="text-right">Revenue</Th><Th className="text-right">Paid subs</Th><Th className="text-right">MAU</Th><Th className="text-right">Ads</Th><Th className="text-right">API</Th><Th className="text-right">Infra</Th><Th className="text-right">Payroll</Th><Th className="text-right">Other</Th><Th className="text-right">Burn</Th><Th className="text-right">Cash end</Th></tr></thead>
          <tbody>{[...actuals].reverse().map((a) => (
            <tr key={a.month}>
              <Td className="whitespace-nowrap">{new Date(a.month + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric" })}</Td>
              {[a.revenue, a.paid_subs, a.mau, a.ad_spend, a.api_spend, a.infra_spend, a.payroll, a.other_opex].map((v, i) => <Td key={i} className="num text-right">{i === 1 || i === 2 ? fmt.num(v) : fmt.usd(v)}</Td>)}
              <Td className="num text-right">{fmt.usd(burnOf(a))}</Td><Td className="num text-right">{fmt.usd(a.cash_end)}</Td>
            </tr>
          ))}</tbody>
        </Table>
        <p className="px-4 py-2 text-[11px] text-muted-foreground">CSV columns: month,revenue,paid_subs,mau,ad_spend,api_spend,infra_spend,payroll,other_opex,cash_end (month as YYYY-MM or YYYY-MM-01).</p>
      </Card>
    </div>
  );
}
