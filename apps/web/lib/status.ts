import { tzOffsetMs } from "./tz";
import "server-only";
import { getRepo } from "@engine/db";
import { metaLink } from "./ad-campaigns";
import { clipReadStatus } from "./clip-reader";
import { igAccount } from "./meta-insights";
import { engine } from "./reels";
import { hstToday } from "./utils";

export type Light = "success" | "warning" | "danger" | "muted" | "info";
export interface DeskStatus {
  at: string;
  engine: { light: Light; text: string };
  meta: { light: Light; text: string };
  instagram: { light: Light; text: string };
  approvals: number; alerts: number; rendering: number; reading: boolean; live: number; postsToday: number;
}

const g = globalThis as { __engineHealth?: { at: number; v: DeskStatus["engine"] }; __igLink?: { at: number; v: DeskStatus["instagram"] } };
const within = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** Reel engine health, cached 15 s and never waiting more than 2.5 s. */
async function engineLight(): Promise<DeskStatus["engine"]> {
  if (g.__engineHealth && Date.now() - g.__engineHealth.at < 15_000) return g.__engineHealth.v;
  const e = engine();
  const v: DeskStatus["engine"] = e.stub ? { light: "muted", text: "stub" }
    : await within(e.health().then((h) => (h.status === "connected" ? { light: "success" as Light, text: h.detail ?? "up" } : { light: "danger" as Light, text: "down" }))
      .catch(() => ({ light: "danger" as Light, text: "down" })), 2500, { light: "warning" as Light, text: "slow" });
  g.__engineHealth = { at: Date.now(), v };
  return v;
}

async function igLight(): Promise<DeskStatus["instagram"]> {
  if (g.__igLink && Date.now() - g.__igLink.at < 5 * 60_000) return g.__igLink.v;
  const v = await within(igAccount().then((a) => (a ? { light: "success" as Light, text: `@${a.username}` } : { light: "muted" as Light, text: "not connected" }))
    .catch(() => ({ light: "danger" as Light, text: "error" })), 3000, { light: "warning" as Light, text: "slow" });
  g.__igLink = { at: Date.now(), v };
  return v;
}

/** Everything the status strip shows, in one cheap call. */
export async function deskStatus(): Promise<DeskStatus> {
  const repo = getRepo();
  const today = hstToday();
  const [approvals, incidents, jobs, campaigns, items, eng, meta, ig] = await Promise.all([
    repo.list("approvals", { eq: { status: "pending" } }), repo.list("incidents"), repo.list("reel_jobs", { order: { col: "created_at", asc: false }, limit: 40 }),
    repo.list("ad_campaigns"), repo.list("content_items"), engineLight(), within(metaLink(), 3000, { status: "error" as const, detail: "slow" }), igLight(),
  ]);
  return {
    at: new Date().toISOString(),
    engine: eng,
    meta: meta.status === "connected" ? { light: "success", text: meta.account.name } : meta.status === "error" ? { light: "danger", text: "error" } : { light: "muted", text: "not connected" },
    instagram: ig,
    approvals: approvals.length,
    alerts: incidents.filter((i) => (i.severity === "error" || i.severity === "critical") && ["open", "triaged", "fix_proposed"].includes(i.status)).length,
    rendering: jobs.filter((j) => j.status === "queued" || j.status === "rendering").length,
    reading: clipReadStatus().running,
    live: campaigns.filter((c) => c.status === "live").length,
    postsToday: items.filter((c) => c.scheduled_at && new Date(Date.parse(c.scheduled_at) + tzOffsetMs()).toISOString().slice(0, 10) === today && c.status !== "posted").length,
  };
}
