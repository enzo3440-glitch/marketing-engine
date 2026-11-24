// Every 15 min: sync Gmail + Calendar, flag brand-relevant items.
import { createConnectors } from "@engine/connectors";
import type { Agent } from "../run";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BRAND = process.env.BRAND_NAME ? `${esc(process.env.BRAND_NAME)}|` : "";
const OWN = new RegExp(`${BRAND}investor|vc|ventures|partner|app store|testflight|sentry|railway|supabase|creator|collab`, "i");

export const inboxScout: Agent = async ({ repo, log, env }) => {
  const gw = createConnectors({ repo, env, log }).find((c) => c.id === "google_workspace")!;
  if (!gw.requiredEnv.every((k) => env[k])) throw new Error("google_workspace not configured");
  await gw.sync(new Date(Date.now() - 2 * 86400_000));
  const inbox = await repo.list("inbox_items", { since: new Date(Date.now() - 2 * 86400_000).toISOString(), dateCol: "received_at" });
  let flagged = 0;
  for (const m of inbox) {
    const importance = OWN.test(`${m.sender} ${m.subject} ${m.snippet}`) ? Math.max(m.importance, 2) : m.importance;
    if (importance !== m.importance) {
      await repo.update("inbox_items", { id: m.id }, { importance });
      flagged++;
    }
  }
  const events = await repo.list("calendar_events", { since: new Date().toISOString(), dateCol: "starts_at" });
  for (const e of events) if (!e.is_own && OWN.test(`${e.title} ${e.attendees.join(" ")}`)) await repo.update("calendar_events", { id: e.id }, { is_own: true });
  log(`${inbox.length} messages, ${flagged} flagged`);
};
