import "server-only";
import { AGENTS, apiBudgets, computeKpis, getRepo } from "@engine/db";
import { daysAgo, hstToday } from "@/lib/utils";

export async function loadKpis() {
  const repo = getRepo();
  const since = daysAgo(95);
  const [metrics, spend, ads, fin] = await Promise.all([
    repo.list("metrics_daily", { since }), repo.list("api_spend", { since }), repo.list("campaign_daily", { since }), repo.list("fin_actuals"),
  ]);
  const b = apiBudgets();
  return computeKpis({ metrics, spend, ads, fin, today: hstToday(), apiBudget: b.anthropic + b.google });
}

/** Latest run per agent, in a fixed order. */
export async function agentStatus() {
  const runs = await getRepo().list("agent_runs", { order: { col: "started_at", asc: false }, limit: 400 });
  return AGENTS.map((agent) => ({ agent, run: runs.find((r) => r.agent === agent) ?? null }));
}
