// Every 5 min: Supabase health, Railway deploys (failed deploys become incidents), engine health.
import { createConnectors, testAndRecord } from "@engine/connectors";
import { raise, type Agent } from "../run";

const WATCH = ["supabase", "railway", "reel_engine", "sentry"];

export const infraWatcher: Agent = async ({ repo, log, env }) => {
  const ctx = { repo, env, log };
  for (const c of createConnectors(ctx).filter((c) => WATCH.includes(c.id))) {
    const s = await testAndRecord(c, ctx);
    log(`${c.id}: ${s.status}${s.detail ? ` (${s.detail})` : ""}`);
    if (s.status === "error") {
      await raise(repo, { source: c.id, severity: "error", title: `${c.label} health check failing`, body: s.detail, fingerprint: `health:${c.id}` });
    }
    if (s.status === "connected" && c.id === "railway") await c.sync(new Date(Date.now() - 86400_000));
  }
};
