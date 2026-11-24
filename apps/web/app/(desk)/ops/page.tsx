import { apiBudgets, getRepo, projectMonthEnd } from "@engine/db";
import Link from "next/link";
import { StackedBars } from "@/components/charts";
import { Badge, Card, CardBody, CardHeader, PageHeader, Stat, statusTone, Table, Td, Th } from "@/components/ui";
import { requireArea } from "@/lib/auth";
import { daysAgo, fmt, hstToday, parseRange } from "@/lib/utils";

const HEALTH = ["supabase", "railway", "sentry", "app_store_connect", "reel_engine"];

export default async function OpsPage({ searchParams }: { searchParams: { range?: string } }) {
  await requireArea("ops");
  const range = parseRange(searchParams.range);
  const repo = getRepo();
  const today = hstToday();
  const [spendAll, integrations, deploys, incidents] = await Promise.all([
    repo.list("api_spend", { since: daysAgo(Math.max(range, 40)) }), repo.list("integrations"),
    repo.list("deploys", { order: { col: "created_at", asc: false }, limit: 15 }), repo.list("incidents"),
  ]);
  const spend = spendAll.filter((s) => s.date >= daysAgo(range - 1));
  const budgets = apiBudgets();
  const byDay = new Map<string, Record<string, number | string>>();
  for (const s of spend) {
    const row = byDay.get(s.date) ?? { date: s.date };
    row[s.provider] = +((Number(row[s.provider] ?? 0)) + Number(s.cost_usd)).toFixed(2);
    byDay.set(s.date, row);
  }
  const chart = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const providers = Object.keys(budgets) as (keyof typeof budgets)[];
  const projections = providers.map((p) => ({ provider: p, ...projectMonthEnd(spendAll, today, budgets[p], p) }));
  const totalBudget = providers.reduce((a, p) => a + budgets[p], 0);
  const models = new Map<string, { provider: string; model: string; cost: number; tin: number; tout: number }>();
  for (const s of spend) {
    const k = `${s.provider}/${s.model}`;
    const m = models.get(k) ?? { provider: s.provider, model: s.model, cost: 0, tin: 0, tout: 0 };
    m.cost += Number(s.cost_usd); m.tin += Number(s.tokens_in); m.tout += Number(s.tokens_out);
    models.set(k, m);
  }
  const errors = incidents.filter((i) => i.source !== "sentry" && i.status !== "resolved");

  return (
    <>
      <PageHeader title="Ops" description="API spend vs projected month-end, infrastructure health, errors and deploys." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={`Daily API spend · last ${range} days`} description={`Daily budget line = monthly budgets ÷ 30 (${fmt.usd(totalBudget)}/mo)`} />
          <CardBody><StackedBars data={chart} keys={providers} refY={+(totalBudget / 30).toFixed(2)} refLabel="daily budget" /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Month-end projection" description="MTD + trailing 7-day avg × days left" />
          <CardBody className="space-y-4">
            {projections.map((p) => (
              <div key={p.provider}>
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium capitalize">{p.provider}</span>
                  <Badge tone={p.overPct > 0.2 ? "danger" : p.overPct > 0 ? "warning" : "success"}>{fmt.signedPct(p.overPct)} vs plan</Badge>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <Stat label="MTD" value={fmt.usd(p.monthToDate)} />
                  <Stat label="Projected" value={fmt.usd(p.projected)} />
                  <Stat label="Budget" value={fmt.usd(p.budget)} />
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
                  <div className={`h-full ${p.overPct > 0.2 ? "bg-destructive" : p.overPct > 0 ? "bg-warning" : "bg-success"}`} style={{ width: `${Math.min(100, (p.projected / p.budget) * 100)}%` }} />
                </div>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">Spend Watcher alerts when a projection exceeds plan by 20%. Budgets: BUDGET_ANTHROPIC_MONTHLY, BUDGET_GOOGLE_MONTHLY.</p>
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {HEALTH.map((p) => {
          const i = integrations.find((x) => x.provider === p);
          return (
            <Card key={p} className="p-3">
              <div className="flex items-center justify-between"><span className="text-sm font-medium">{p.replace(/_/g, " ")}</span><Badge tone={statusTone(i?.status ?? "not_configured")}>{i?.status ?? "not_configured"}</Badge></div>
              <div className="mt-1 text-[11px] text-muted-foreground">{i?.last_error ?? (i?.last_sync_at ? `checked ${fmt.ago(i.last_sync_at)}` : "never checked")}</div>
            </Card>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Per-model spend" description={`Last ${range} days`} />
          <Table>
            <thead><tr><Th>Provider</Th><Th>Model / SKU</Th><Th className="text-right">Input tok</Th><Th className="text-right">Output tok</Th><Th className="text-right">Cost</Th></tr></thead>
            <tbody>{[...models.values()].sort((a, b) => b.cost - a.cost).map((m) => (
              <tr key={m.provider + m.model}><Td className="capitalize">{m.provider}</Td><Td className="font-mono text-xs">{m.model}</Td><Td className="num text-right">{m.tin ? fmt.compact(m.tin) : "—"}</Td><Td className="num text-right">{m.tout ? fmt.compact(m.tout) : "—"}</Td><Td className="num text-right">{fmt.usd(m.cost, 2)}</Td></tr>
            ))}</tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Deploy log" description="Railway deployments" action={<Link href="/settings/integrations" className="text-xs text-primary">Integrations →</Link>} />
          <Table>
            <thead><tr><Th>When</Th><Th>Service</Th><Th>Commit</Th><Th>Status</Th></tr></thead>
            <tbody>{deploys.map((d) => (
              <tr key={d.id}><Td className="whitespace-nowrap text-xs text-muted-foreground">{fmt.dateTime(d.created_at)}</Td><Td className="font-mono text-xs">{d.service}</Td><Td className="max-w-[16rem] truncate text-xs">{d.commit_message}</Td><Td><Badge tone={statusTone(d.status)}>{d.status}</Badge></Td></tr>
            ))}</tbody>
          </Table>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Errors" description="Infra, spend and finance incidents (crashes live on Build)" />
        <Table>
          <thead><tr><Th>Source</Th><Th>Title</Th><Th>Detail</Th><Th>Last seen</Th></tr></thead>
          <tbody>{errors.map((e) => (
            <tr key={e.id}><Td><Badge tone={statusTone(e.severity === "warn" ? "pending" : "error")}>{e.source}</Badge></Td><Td>{e.title}</Td><Td className="text-xs text-muted-foreground">{e.body}</Td><Td className="text-xs text-muted-foreground">{fmt.ago(e.last_seen)}</Td></tr>
          ))}</tbody>
        </Table>
      </Card>
    </>
  );
}
