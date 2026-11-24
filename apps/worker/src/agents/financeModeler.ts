// Daily: refresh this month's fin_actuals from metrics + spend tables, rerun projections, flag runway.
import { breakevenMonth, burnOf, hstDate, metricSeries, projectFinance } from "@engine/db";
import { raise, type Agent } from "../run";

export const financeModeler: Agent = async ({ repo, log }) => {
  const today = hstDate(new Date());
  const month = `${today.slice(0, 7)}-01`;
  const [metrics, spend, ads, fin, scenarios] = await Promise.all([
    repo.list("metrics_daily", { since: month }), repo.list("api_spend", { since: month }), repo.list("campaign_daily", { since: month }),
    repo.list("fin_actuals"), repo.list("fin_scenarios"),
  ]);
  const last = (k: string) => metricSeries(metrics, k).at(-1)?.value ?? 0;
  const cur = fin.find((f) => f.month === month);
  const prev = [...fin].filter((f) => f.month < month).sort((a, b) => (a.month < b.month ? 1 : -1))[0];
  const row = {
    month, paid_subs: last("paid_subs"), mau: last("mau"), revenue: +last("mrr").toFixed(2),
    api_spend: +spend.reduce((a, b) => a + Number(b.cost_usd), 0).toFixed(2), ad_spend: +ads.reduce((a, b) => a + Number(b.spend), 0).toFixed(2),
    infra_spend: cur?.infra_spend ?? prev?.infra_spend ?? 0, payroll: cur?.payroll ?? prev?.payroll ?? 0, other_opex: cur?.other_opex ?? prev?.other_opex ?? 0,
    cash_end: cur?.cash_end ?? prev?.cash_end ?? 0,
  };
  await repo.upsert("fin_actuals", [row], "month");
  const all = [...fin.filter((f) => f.month !== month), row];
  for (const s of scenarios) {
    const p = projectFinance(all, s.assumptions);
    log(`${s.name}: breakeven ${breakevenMonth(p) ?? "not within 24 months"}, cash in 12mo $${Math.round(p[11]?.cash ?? 0).toLocaleString()}`);
  }
  const burn = burnOf(row);
  const runway = burn > 0 ? row.cash_end / burn : Infinity;
  if (runway < 9) await raise(repo, { source: "finance", severity: runway < 6 ? "critical" : "warn", title: `Runway ${runway.toFixed(1)} months`, fingerprint: `finance:runway:${month}` });
};
