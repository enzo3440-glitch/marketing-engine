// Daily 6:00 desk time: ingest ads + App Store + signups, compute attribution signals, write the morning brief.
import { createConnectors } from "@engine/connectors";
import { dailyTotals, hstDate, lagCorrelation, metricSeries } from "@engine/db";
import { z } from "zod";
import { askJson, claudeEnabled } from "../claude";
import { propose, type Agent } from "../run";

const Brief = z.object({ headline: z.string(), bullets: z.array(z.string()).max(6), proposed_actions: z.array(z.string()).max(3) });

export const growthAnalyst: Agent = async ({ repo, log, env }) => {
  const since = new Date(Date.now() - 3 * 86400_000);
  for (const c of createConnectors({ repo, env, log }).filter((c) => ["meta", "tiktok", "app_store_connect", "supabase"].includes(c.id))) {
    if (c.requiredEnv.every((k) => env[k])) await c.sync(since);
  }
  const from = hstDate(new Date(Date.now() - 28 * 86400_000));
  const [metrics, ads, campaigns] = await Promise.all([repo.list("metrics_daily", { since: from }), repo.list("campaign_daily", { since: from }), repo.list("campaigns")]);
  const signups = metricSeries(metrics, "signups");
  const spend = dailyTotals(ads, (r) => Number(r.spend));
  const lags = lagCorrelation(spend, signups);
  const best = [...lags].sort((a, b) => b.r - a.r)[0];
  const wk = (s: { value: number }[], i: number) => s.slice(s.length - 7 * (i + 1), s.length - 7 * i).reduce((a, b) => a + b.value, 0);
  const wow = wk(signups, 1) ? (wk(signups, 0) - wk(signups, 1)) / wk(signups, 1) : 0;
  const byCampaign = campaigns.filter((c) => !c.id.startsWith("cmo-")).map((c) => {
    const rows = ads.filter((a) => a.campaign_id === c.id).slice(-7);
    const sp = rows.reduce((a, b) => a + Number(b.spend), 0), inst = rows.reduce((a, b) => a + b.installs, 0);
    return { name: c.name, platform: c.platform, spend7: +sp.toFixed(2), installs7: inst, cpi: inst ? +(sp / inst).toFixed(2) : null };
  });
  const facts = { signups_wow: +(wow * 100).toFixed(1), best_lag_days: best?.lag, best_lag_r: best?.r, campaigns: byCampaign };
  let summary = `Signups ${wow >= 0 ? "+" : ""}${(wow * 100).toFixed(0)}% WoW. Spend→signups correlation peaks at ${best?.lag}-day lag (r=${best?.r}).`;
  let preview: Record<string, unknown> = { facts };
  if (claudeEnabled()) {
    const b = await askJson({
      system: `You are ${process.env.BRAND_NAME || "our brand"}'s growth analyst. Write a terse CEO morning brief from the facts given. Never invent numbers; say 'unknown' where data is missing.`,
      prompt: JSON.stringify(facts), schema: Brief, effort: "low",
    });
    summary = b.headline;
    preview = { ...preview, bullets: b.bullets, proposed_actions: b.proposed_actions };
  }
  await propose(repo, { type: "other", agent: "growthAnalyst", title: `Morning growth brief · ${hstDate(new Date())}`, summary, preview });
  log(summary);
};
