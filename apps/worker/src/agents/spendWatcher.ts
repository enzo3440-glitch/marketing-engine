// Hourly: pull provider cost, project month-end from the trailing 7-day average, alert at >20% over budget.
import { createConnectors } from "@engine/connectors";
import { hstDate, projectMonthEnd } from "@engine/db";
import { budgets } from "../env";
import { raise, type Agent } from "../run";

export const spendWatcher: Agent = async ({ repo, log, env }) => {
  const since = new Date(Date.now() - 35 * 86400_000);
  for (const c of createConnectors({ repo, env, log }).filter((c) => c.id === "anthropic" || c.id === "google_cloud")) {
    if (c.requiredEnv.every((k) => env[k])) await c.sync(since);
  }
  const today = hstDate(new Date());
  const all = await repo.list("api_spend", { since: hstDate(new Date(Date.now() - 40 * 86400_000)) });
  for (const [provider, budget] of Object.entries(budgets())) {
    const p = projectMonthEnd(all, today, budget, provider);
    log(`${provider}: MTD $${p.monthToDate.toFixed(0)}, projected $${p.projected.toFixed(0)} vs $${budget} (${(p.overPct * 100).toFixed(0)}%)`);
    if (p.overPct > 0.2) {
      await raise(repo, {
        source: "spend", severity: p.overPct > 0.5 ? "critical" : "warn",
        title: `${provider} projected month-end ${(p.overPct * 100).toFixed(0)}% over plan`,
        body: `MTD $${p.monthToDate.toFixed(2)}; trailing 7-day avg $${p.trailing7Avg.toFixed(2)}/day × ${p.daysLeft} days left → $${p.projected.toFixed(0)} vs $${budget} budget.`,
        fingerprint: `spend:${provider}:${today.slice(0, 7)}`,
      });
    }
  }
};
