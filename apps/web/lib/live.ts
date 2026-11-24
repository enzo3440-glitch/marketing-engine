import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getRepo, type AdCampaign, type Approval, type ReelVariant } from "@engine/db";
import { creativesOf, maxDailyBudget, metaAds } from "./ad-campaigns";
import { featureBoard } from "./feature-board";
import { featureName, featureOf } from "./features";
import { ACT_REACH } from "./lab";
import { allItems, optimizeStatus, type Item, type Reading } from "./optimize";
import { hstToday } from "./utils";
import { launchStructure, withReads, type LaunchStructure } from "./waves";

/**
 * Command → Live.
 *
 * Read-only over what the desk already knows: live optimize's items (verdict, why, re-cut, history, readings), the
 * feature board (per-ad Meta insights, merged with Winners), the waves structure (per-ad-set reads), and reel_posts.
 * The only writes are proposals into the approvals queue (set_budget / promote_post, run by lib/improve.ts runProposal
 * once approved in Decide) and the founder's notes on a video. Nothing here touches Meta.
 *
 * Goals: ads optimize for installs; Instagram reels for virality: reach first, then saves + shares per reach once a reel has
 * real reach (ACT_REACH: if the reach is low it's irrelevant).
 */

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const NOTES = path.join(DATA, "ads", "_live_notes.json");
const DAILY = path.join(DATA, "ads", "_daily.json");
const TRIAL_FAIR = 120, AD_FAIR = 250; // the same fair reads live optimize uses
const now = () => new Date().toISOString();
const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const fileUrl = (job: string, n: string | null | undefined) => (n ? `/api/reels/files/${encodeURIComponent(job)}/${encodeURIComponent(n)}` : null);

export type LivePill = "good" | "fixing" | "review" | "waiting" | "killed" | "winner" | "replaced" | "paused" | "benched";
export interface LiveNote { at: string; by: string; text: string }
export interface LiveVideo {
  key: string; kind: "trial" | "post" | "ad"; title: string; feature: string; feature_name: string;
  poster: string | null; video: string | null; permalink: string | null; ig_media_id: string | null;
  since: string | null; pill: LivePill; why: string | null; next: string | null; recommendation: string;
  fix: Item["fix"] | null; fixes: number; history: { at: string; text: string }[]; readings: Reading[]; notes: LiveNote[];
  version: LiveVersion | null;
  // a change the optimizer made and is waiting on the founder's OK for
  pending: { kind: "swap" | "kill"; what: string; why: string; test: string | null; video: string | null; poster: string | null; at: string } | null;
  // reels
  reach?: number | null; saves?: number | null; shares?: number | null; act?: number | null; follows?: number | null; watch?: number | null;
  // ads
  ad_set?: string | null; spend?: number; impressions?: number; hook?: number | null; ctr?: number | null; installs?: number; cpi?: number | null; clicks?: number;
}
export interface LiveCampaign {
  id: string; title: string; status: AdCampaign["status"]; daily_budget: number; starts_on: string; ends_on: string; days_left: number; currency: string;
  spend: number; impressions: number; installs: number; clicks: number; hook: number | null; ctr: number | null; cpi: number | null;
  groups: { name: string; daily: number | null; verdict: string | null; why: string | null; ads: LiveVideo[] }[];
  insights: string[]; pending: { id: string; title: string; summary: string | null; created_at: string }[];
  recommendation: string; max_daily: number;
}
export interface LiveBoard {
  goal: { ads: string; reels: string }; optimize_on: boolean; currency: string; meta: boolean; error?: string;
  reels: LiveVideo[]; campaigns: LiveCampaign[];
  // older trial-reel versions a newer one replaced: Instagram doesn't let apps delete reels, so he does it in one tap
  to_delete: { key: string; title: string; permalink: string | null; poster: string | null; by: string; version: string | null; at: string; error: string | null }[];
}

// ---------------------------------------------------------------- founder notes

type Notes = Record<string, LiveNote[]>;
const readNotes = (): Notes => { try { return JSON.parse(fs.readFileSync(NOTES, "utf8")); } catch { return {}; } };
const sameKey = (k: string) => k.replace("/", "|");

/**
 * The founder's suggestion on a video. Kept here (shown in Live), on the video itself (tags.founder_note, so any re-cut
 * that reads the video's tags sees it), and as the daily engine's fixFor ("one more change for a reel's next swap, in the
 * founder's words"), which lib/daily-reels.ts already adds to that reel's next re-cut.
 */
export async function saveNote(key: string, text: string, by: string): Promise<LiveNote[]> {
  const t = text.trim().slice(0, 600);
  if (!t) throw new Error("Write the change you want first.");
  const k = sameKey(key);
  const all = readNotes();
  all[k] = [{ at: now(), by, text: t }, ...(all[k] ?? [])].slice(0, 20);
  fs.mkdirSync(path.dirname(NOTES), { recursive: true });
  fs.writeFileSync(NOTES, JSON.stringify(all, null, 1));
  const [job, id] = k.split("|");
  if (job && id) {
    const repo = getRepo();
    const [v] = await repo.list("reel_variants", { eq: { job_id: job, id } });
    if (v) {
      await repo.update("reel_variants", { job_id: job, id }, { tags: { ...(v.tags ?? {}), founder_note: t, founder_note_at: now() } });
      try {
        const d = JSON.parse(fs.readFileSync(DAILY, "utf8")) as { fixFor?: Record<string, string> };
        d.fixFor = { ...(d.fixFor ?? {}), [k]: t };
        fs.writeFileSync(DAILY, JSON.stringify(d, null, 1));
      } catch { /* the daily engine hasn't run yet: the note on the video and here still stand */ }
    }
  }
  return all[k];
}

// ---------------------------------------------------------------- proposals (pending approvals, never Meta)

async function pendingFor(refId: string): Promise<Approval[]> {
  return (await getRepo().list("approvals", { eq: { ref_id: refId, status: "pending" } })).filter((a) => a.type === "optimize");
}
async function insertProposal(by: string, title: string, summary: string, bullets: string[], action: Record<string, unknown>, ref: { table: string | null; id: string }): Promise<Approval> {
  const [a] = await getRepo().insert("approvals", [{
    id: crypto.randomUUID(), type: "optimize", ref_table: ref.table, ref_id: ref.id, title, summary, preview: { bullets, action },
    status: "pending", created_by_agent: by, decided_by: null, decided_at: null, result: null, created_at: now(),
  }]);
  return a;
}
const daysLeft = (c: AdCampaign) => Math.max(0, Math.round((Date.parse(c.ends_on) - Date.parse(hstToday())) / 86_400_000) + 1);

/** "Put more money on it": a set_budget proposal for Decide (lib/improve.ts carries it out once approved). */
export async function proposeBudget(id: string, daily: number, extendDays: number, by: string, note?: string): Promise<Approval> {
  const [c] = await getRepo().list("ad_campaigns", { eq: { id } });
  if (!c) throw new Error("Campaign not found");
  if (!c.meta.campaign_id || !["ready", "live", "paused"].includes(c.status)) throw new Error("This campaign isn't built in Meta yet; its budget can change once it's live.");
  if (!Number.isFinite(daily) || daily <= 0) throw new Error("Give a daily budget above 0.");
  if (daily > maxDailyBudget()) throw new Error(`The desk caps a campaign at ${maxDailyBudget()}/day (META_MAX_DAILY_BUDGET).`);
  const extend = Math.max(0, Math.min(60, Math.round(Number.isFinite(extendDays) ? extendDays : 0)));
  if (Math.round(daily * 100) === Math.round(c.daily_budget * 100) && !extend) throw new Error("That's the budget it has now.");
  if ((await pendingFor(c.id)).length) throw new Error("A proposal for this campaign is already waiting in Decide: decide that one first.");
  const left = daysLeft(c);
  const extra = (daily - c.daily_budget) * left + daily * extend;
  const up = daily >= c.daily_budget;
  const step = c.daily_budget ? daily / c.daily_budget - 1 : 0;
  return insertProposal(by, `${up ? "Give" : "Lower"} "${c.title}" ${up ? "more" : "less"} budget`,
    `${c.daily_budget} → ${daily}/day${extend ? ` and ${extend} more day${extend > 1 ? "s" : ""}` : ""}.`,
    [
      `Extra spend ≈ ${extra.toFixed(2)} (${left} day${left === 1 ? "" : "s"} left${extend ? ` + ${extend}` : ""}).`,
      step > 0.5 ? `A ${Math.round(step * 100)}% jump: Meta may restart learning; +20-30% steps are the safe way.` : "",
      note ? `Founder: ${note.slice(0, 300)}` : "",
      "Proposed from Command → Live.",
    ].filter(Boolean),
    { kind: "set_budget", ad_campaign_id: c.id, daily_budget: daily, extend_days: extend }, { table: "ad_campaigns", id: c.id });
}

/** "Promote as an ad": a promote_post proposal for a live reel (the post itself, as-is, no new post). */
export async function proposePromote(key: string, daily: number, days: number, by: string): Promise<Approval> {
  const [job, id] = sameKey(key).split("|");
  const [v] = await getRepo().list("reel_variants", { eq: { job_id: job, id } });
  const ig = v?.tags?.ig_media_id;
  if (!v || !ig) throw new Error("This reel isn't on Instagram yet.");
  if (!Number.isFinite(daily) || daily <= 0 || daily > maxDailyBudget()) throw new Error(`Daily budget between 1 and ${maxDailyBudget()}.`);
  const d = Math.max(1, Math.min(30, Math.round(days || 0)));
  if ((await pendingFor(ig)).length) throw new Error("A proposal for this reel is already waiting in Decide.");
  const running = (await getRepo().list("ad_campaigns")).find((c) => creativesOf(c).some((x) => x.ig_media_id === ig) && ["building", "ready", "live", "paused"].includes(c.status));
  if (running) throw new Error(`Already promoted in "${running.title}": put more money on that campaign instead.`);
  const p = (await getRepo().list("reel_posts", { eq: { job_id: job, variant_id: id } }))[0];
  const caption = v.caption ?? "";
  return insertProposal(by, `Promote "${(v.hook || v.id).slice(0, 50)}" as a ${d}-day ad`, `${daily}/day × ${d} days = ${(daily * d).toFixed(2)}, promoting the post as-is (no new post).`,
    [p ? `Organic so far: ${p.views ?? "—"} views, ${p.saves ?? "—"} saves, ${p.shares ?? "—"} shares${p.follows != null ? `, ${p.follows} follows` : ""}.` : "", caption.slice(0, 140), "Proposed from Command → Live."].filter(Boolean),
    { kind: "promote_post", ig_media_id: ig, caption: caption.slice(0, 500), daily_budget: daily, days: d }, { table: null, id: ig });
}

/** Fresh Instagram numbers for one live reel (opening its panel). */
export async function freshReel(key: string) {
  const [job, id] = sameKey(key).split("|");
  const [v] = await getRepo().list("reel_variants", { eq: { job_id: job, id } });
  const m = metaAds();
  if (!v?.tags?.ig_media_id || !m) return null;
  const r = await m.reelResults(v.tags.ig_media_id);
  return { at: now(), reach: r.reach, saves: r.saves, shares: r.shares, views: r.views, act: r.reach ? (r.saves + r.shares) / r.reach : null,
    watch: r.avgWatchMs != null && v.duration ? r.avgWatchMs / 1000 / v.duration : null };
}

// ---------------------------------------------------------------- versions

/**
 * "A mark on an ad and a trial if it's the 1st, 2nd, 3rd version live for testing, and if it's improved or gone down, and why."
 * Every video the optimizer has tracked belongs to the lineage of its original (Item.root). Versions are numbered in the
 * order they went live; each is compared with the version before it on the number that matters for its kind
 * (ads: click-through once both have a fair read, else the opening; trial reels: reach, then how much is watched).
 * Works back over everything already tracked, because the optimizer never forgets an item.
 */
export interface LiveVersion {
  n: number; of: number; verdict: "better" | "worse" | "same" | "early" | null; vs: string | null;
  change: string | null; reason: string | null;
  lineage: { n: number; key: string; title: string; status: string; metric: string; current: boolean }[];
}

const metricOf = (it: Item) => {
  const r = it.last;
  if (!r) return "no read yet";
  return it.kind === "ad" ? `${(r.impressions ?? 0).toLocaleString()} seen · opening ${pct0(r.hook)} · CTR ${pct2(r.ctr)}`
    : `${r.reach ?? 0} reach · watched ${pct0(r.watch)}${r.skip != null ? ` · ${pct0(r.skip)} swiped` : ""}`;
};
const pct0 = (x?: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const pct2 = (x?: number | null) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);

function compare(cur: Item, prev: Item): { verdict: LiveVersion["verdict"]; vs: string } {
  const a = cur.last, b = prev.last;
  if (!a || !b) return { verdict: "early", vs: "no read on one of them yet" };
  if (cur.kind === "ad") {
    if ((a.impressions ?? 0) < AD_FAIR) return { verdict: "early", vs: `${a.impressions ?? 0} of ${AD_FAIR} impressions so far` };
    const clicks = (a.impressions ?? 0) >= 300 && (b.impressions ?? 0) >= 300;
    const [x, y, name] = clicks ? [a.ctr ?? 0, b.ctr ?? 0, "click-through"] : [a.hook ?? 0, b.hook ?? 0, "opening"];
    const fmtv = clicks ? pct2 : pct0;
    const verdict = y === 0 ? (x > 0 ? "better" : "same") : x >= y * 1.15 ? "better" : x <= y * 0.85 ? "worse" : "same";
    return { verdict, vs: `${name} ${fmtv(x)} vs ${fmtv(y)} on v-before` };
  }
  if ((a.reach ?? 0) < 80) return { verdict: "early", vs: `${a.reach ?? 0} reach so far` };
  const [x, y] = [a.reach ?? 0, b.reach ?? 0];
  let verdict: LiveVersion["verdict"] = x >= y * 1.15 ? "better" : x <= y * 0.85 ? "worse" : "same";
  // same reach: whoever holds viewers longer is ahead
  if (verdict === "same" && a.watch != null && b.watch != null) verdict = a.watch >= b.watch + 0.05 ? "better" : a.watch <= b.watch - 0.05 ? "worse" : "same";
  return { verdict, vs: `reach ${x} vs ${y}, watched ${pct0(a.watch)} vs ${pct0(b.watch)} on v-before` };
}

function versionsFor(all: Item[], variants: ReelVariant[], key: string): LiveVersion | null {
  const k = sameKey(key);
  const it = all.find((x) => sameKey(x.key) === k);
  if (!it) return null;
  const line = all.filter((x) => x.root === it.root && x.kind === it.kind).sort((a, b) => a.first_seen.localeCompare(b.first_seen));
  const i = line.findIndex((x) => x === it);
  const prev = i > 0 ? line[i - 1] : null;
  const [job, id] = k.split("|");
  const v = variants.find((x) => x.job_id === job && x.id === id);
  const c = prev ? compare(it, prev) : null;
  return {
    n: i + 1, of: line.length, verdict: c?.verdict ?? null, vs: c?.vs?.replace("v-before", `v${i}`) ?? null,
    change: prev ? (v?.tags?.revision_summary || null) : null,
    reason: prev ? (prev.fix?.why ?? null) : null,
    lineage: line.map((x, j) => ({ n: j + 1, key: x.key, title: x.label.slice(0, 80), status: x.status, metric: metricOf(x), current: x === it })),
  };
}

/** One click on Command → Live: push out (or turn down) the change the optimizer made and is waiting on. */
export async function decidePending(key: string, approve: boolean, by: string): Promise<string> {
  const { applyPending, rejectPending, allItems: items } = await import("./optimize");
  const it = items().find((x) => sameKey(x.key) === sameKey(key));
  if (!it?.pending) throw new Error("Nothing is waiting on this video any more.");
  const repo = getRepo();
  const mark = (status: Approval["status"], result: Record<string, unknown>) => repo.update("approvals", { id: it.pending!.approval_id }, { status, decided_by: by, decided_at: now(), result }).catch(() => null);
  if (!approve) {
    await rejectPending(it.key);
    await mark("rejected", { detail: "Turned down in Command → Live." });
    return "Turned down: it keeps running as it is.";
  }
  const id = it.pending.approval_id;
  try {
    const detail = await applyPending(it.key);
    await repo.update("approvals", { id }, { status: "executed", decided_by: by, decided_at: now(), result: { detail } }).catch(() => null);
    return detail;
  } catch (e) {
    throw new Error(`Not pushed out: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- the board

function pillOf(it: Item | undefined, waitingWhy: boolean): LivePill {
  if (!it) return "waiting";
  if (it.status === "killed") return "killed";
  if (it.status === "fixing") return "fixing";
  if (it.status === "review") return "review";
  if (it.status === "replaced") return "replaced";
  if (waitingWhy || /^Waiting for a fair read/i.test(it.why ?? "")) return "waiting";
  return "good";
}

function advise(kind: LiveVideo["kind"], pill: LivePill, it: Item | undefined, optOn: boolean): string {
  const auto = optOn ? "" : " Live optimize is off, so nothing changes on its own.";
  switch (pill) {
    case "killed": return "Stopped: it didn't get traction after its re-cuts. Nothing to do; its budget went to the others.";
    case "fixing": return `Being re-cut (the ${it?.fix?.verdict === "payoff" ? "payoff" : "opening"}); once it's rendered, it waits here for your OK.`;
    case "review": return it?.pending?.kind === "kill" ? "Wants to pause this ad. Nothing changes until you approve it." : "A re-cut is ready. Watch it below; nothing goes out until you approve it.";
    // when a new version is released the old ones should be removed from trial reels. Instagram's API
    // can't delete a reel, so the desk says so and the drawer's "Open on Instagram" link is one tap from ... → Delete.
    case "replaced": return kind === "ad" ? "Its re-cut is out now; this version is paused."
      : "Its new version is out. Delete this one in the Instagram app (Open on Instagram → ··· → Delete): Instagram doesn't let apps delete reels.";
    case "waiting": return `Too early to judge: leave it until it has a fair read.${auto}`;
    case "benched": return "Built and reviewed by Meta, waiting for a slot in its feature's ad set.";
    case "paused": return "Paused.";
    case "winner": return kind === "ad" ? "Working: this is where more budget pays off. Put more money on the campaign if the cost per install holds."
      : "Doing well on saves and shares: worth promoting as an ad, and remixing for tomorrow's reels.";
    default: return kind === "ad" ? (it?.next ? `Good as is for now. ${it.next}` : `Good as is: leave it running.${auto}`)
      // a trial is never "good as is" below viral reach: it climbs, or it's re-cut or killed
      : `Still climbing. Once its reach stops growing short of viral, it's re-cut if something in it is strong, or killed.${it?.next ? ` ${it.next}` : ""}${auto}`;
  }
}

const itemFor = (items: Item[], key: string) => items.find((x) => x.key === key || x.key === key.replace("|", "/") || x.key === key.replace("/", "|"));

export async function liveBoard(): Promise<LiveBoard> {
  const repo = getRepo();
  const [variants, posts, camps, pending] = await Promise.all([repo.list("reel_variants"), repo.list("reel_posts"), repo.list("ad_campaigns"),
    repo.list("approvals", { eq: { status: "pending" } })]);
  const opt = optimizeStatus();
  const every = allItems();
  // retired and deleted in Instagram: off the board
  const gone = new Set(every.filter((x) => x.retire?.done && x.kind === "trial").map((x) => sameKey(x.key)));
  const pendingOf = (it: Item | undefined): LiveVideo["pending"] => {
    const p = it?.pending;
    if (!p) return null;
    const nv = p.job_id ? variants.find((x) => x.job_id === p.job_id && x.id === p.variant_id) : undefined;
    return { kind: p.kind, what: p.what, why: p.why, test: p.test ?? null, video: nv ? fileUrl(nv.job_id, nv.file) : null, poster: nv ? fileUrl(nv.job_id, nv.poster) : null, at: p.at };
  };
  const notes = readNotes();
  const notesOf = (k: string) => notes[sameKey(k)] ?? [];
  let error: string | undefined;

  // Instagram: trial reels and posts that are live
  const liveReels = variants.filter((v) => ["trial", "post"].includes(v.tags?.launched ?? "") && v.tags?.launch_status === "live");
  const reels: LiveVideo[] = liveReels.map((v) => {
    const key = `${v.job_id}/${v.id}`;
    const it = itemFor(opt.items, key);
    const p = posts.find((y) => y.job_id === v.job_id && y.variant_id === v.id);
    const last = it?.last;
    const reach = last?.reach ?? (v.tags.ap_reach ? Number(v.tags.ap_reach) : p?.views ?? null);
    const ss = p?.saves != null || p?.shares != null ? (p?.saves ?? 0) + (p?.shares ?? 0) : null;
    const act = last?.act ?? (reach && ss != null ? ss / reach : null);
    const watch = last?.watch ?? (p?.avg_watch_s != null && v.duration ? p.avg_watch_s / v.duration : null);
    let pill = v.tags.opt_killed || v.tags.ap_verdict === "killed" ? "killed" as LivePill : pillOf(it, !it && (reach ?? 0) < TRIAL_FAIR);
    if (!it && pill === "waiting" && (reach ?? 0) >= TRIAL_FAIR) pill = "good";
    if (v.tags.ap_verdict === "winner" && pill === "good" && (reach ?? 0) >= ACT_REACH) pill = "winner";
    return {
      key, kind: v.tags.launched as "trial" | "post", title: (v.hook || v.id).slice(0, 140), feature: featureOf(v), feature_name: featureName(featureOf(v)),
      poster: fileUrl(v.job_id, v.poster), video: fileUrl(v.job_id, v.file), permalink: v.tags.permalink ?? p?.url ?? null, ig_media_id: v.tags.ig_media_id ?? null,
      since: p?.posted_at ?? null, pill, why: it?.why ?? v.tags.opt_killed ?? v.tags.ap_why ?? null, next: it?.next ?? null, recommendation: "",
      fix: it?.fix ?? null, fixes: it?.fixes ?? 0, history: it?.history ?? [], readings: it?.readings ?? [], notes: notesOf(key),
      version: versionsFor(every, variants, key), pending: pendingOf(it),
      reach, saves: p?.saves ?? null, shares: p?.shares ?? null, act, follows: p?.follows ?? null, watch,
    };
  });
  // a reel well ahead of the live ones on saves + shares is a winner (same bar as the autopilot's judge: 1.4× the median)
  const bar = median(reels.filter((r) => (r.reach ?? 0) >= ACT_REACH && r.act != null).map((r) => r.act!));
  for (const r of reels) {
    if (r.pill === "good" && (r.reach ?? 0) >= ACT_REACH && (r.act ?? 0) >= Math.max(0.01, (bar ?? 0) * 1.4)) r.pill = "winner";
    r.recommendation = advise(r.kind, r.pill, itemFor(opt.items, r.key), opt.on);
  }
  reels.sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));

  // Ads: each live launch with its feature ad sets / Winners and the ads inside
  const campaigns: LiveCampaign[] = [];
  let currency = "USD", meta = !!metaAds();
  for (const c of camps.filter((x) => ["live", "ready", "building"].includes(x.status))) {
    let st: LaunchStructure | null = null;
    let board: Awaited<ReturnType<typeof featureBoard>> | null = null;
    try {
      st = await launchStructure(c);
      if (st && c.meta.campaign_id) st = await withReads(c, st);
      if (!st?.reads) board = await featureBoard(c.id);
      if (board?.error) error = board.error;
      currency = st?.currency ?? board?.currency ?? currency;
      if (board && !board.live) meta = false;
    } catch (e) { error = (e as Error).message; }
    const picks = creativesOf(c);
    const vOf = (k: string): ReelVariant | undefined => { const x = picks.find((y) => y.key === k); return x?.job_id ? variants.find((y) => y.job_id === x.job_id && y.id === x.variant_id) : undefined; };
    const adRow = (k: string, setName: string | null): LiveVideo => {
      const x = picks.find((y) => y.key === k)!;
      const ids = c.meta.ads?.[k] ?? {};
      const it = itemFor(opt.items, k);
      const r = st?.reads?.[k];
      const fb = board?.videos.find((y) => y.key === k);
      const n = { impressions: r?.impressions ?? fb?.impressions ?? 0, clicks: r?.clicks ?? fb?.clicks ?? 0, spend: r?.spend ?? fb?.spend ?? 0, installs: r?.installs ?? fb?.installs ?? 0, hook: r?.hook ?? fb?.hook ?? null };
      const won = c.meta.waves?.winners?.[k];
      const v = vOf(k);
      let pill: LivePill = won && !won.dropped_at ? "winner" : ids.killed ? "killed" : ids.bench && !ids.paused_at ? "benched" : ids.paused_at && !won ? "paused" : pillOf(it, n.impressions < AD_FAIR);
      if (won?.dropped_at) pill = "paused";
      if (!ids.ad_id) pill = "waiting";
      const f = ids.feature ?? (v ? featureOf(v) : featureOf({ hook: x.label ?? "" }));
      return {
        key: k, kind: "ad", title: (x.label ?? k).split("\n")[0].slice(0, 140), feature: f, feature_name: featureName(f),
        poster: x.ig_media_id ? x.thumb ?? null : fileUrl(x.job_id!, x.poster), video: x.ig_media_id ? null : fileUrl(x.job_id!, x.file),
        permalink: x.permalink ?? null, ig_media_id: x.ig_media_id ?? null, since: ids.live_at ?? c.meta.activated_at ?? c.meta.built_at ?? null,
        pill, why: won?.dropped_at ? `Dropped from Winners: ${won.why ?? "worn out"}.` : ids.killed ?? it?.why ?? null, next: it?.next ?? null,
        recommendation: advise("ad", pill, it, opt.on), fix: it?.fix ?? null, fixes: it?.fixes ?? 0, history: it?.history ?? [], readings: it?.readings ?? [], notes: notesOf(k),
        version: versionsFor(every, variants, k), pending: pendingOf(it),
        ad_set: setName, ...n, ctr: n.impressions ? n.clicks / n.impressions : null, cpi: n.installs ? n.spend / n.installs : null,
      };
    };
    const groups: LiveCampaign["groups"] = [];
    if (st?.sets.length) {
      const winners = st.winners.filter((w) => !w.dropped);
      if (winners.length) groups.push({ name: "Winners", daily: st.winners_daily || null, verdict: st.winners_read ? "winners" : null,
        why: st.winners_read ? `${st.winners_read.impressions.toLocaleString()} impressions, ${st.winners_read.installs} installs` : null, ads: winners.map((w) => adRow(w.key, "Winners")) });
      for (const g of st.sets) {
        const keys = [...g.won.filter((k) => !winners.some((w) => w.key === k)), ...g.live, ...g.bench, ...g.out].filter((k) => picks.some((y) => y.key === k));
        if (!keys.length) continue;
        const sr = st.set_reads?.[g.feature];
        groups.push({ name: `${g.name}${g.retired ? " (retired)" : ""}`, daily: g.daily || null, verdict: sr?.verdict ?? null, why: sr?.why ?? null, ads: keys.map((k) => adRow(k, g.name)) });
      }
    } else {
      groups.push({ name: "Ads", daily: c.daily_budget, verdict: null, why: null, ads: picks.map((x) => adRow(x.key, null)) });
    }
    const all = groups.flatMap((g) => g.ads);
    const uniq = [...new Map(all.map((a) => [a.key, a])).values()];
    const t = uniq.reduce((s, a) => ({ spend: s.spend + (a.spend ?? 0), impressions: s.impressions + (a.impressions ?? 0), installs: s.installs + (a.installs ?? 0), clicks: s.clicks + (a.clicks ?? 0),
      v3: s.v3 + (a.hook ?? 0) * (a.impressions ?? 0) }), { spend: 0, impressions: 0, installs: 0, clicks: 0, v3: 0 });
    const mine = pending.filter((a) => a.ref_id === c.id).map((a) => ({ id: a.id, title: a.title, summary: a.summary ?? null, created_at: a.created_at }));
    const winners = uniq.filter((a) => a.pill === "winner").length;
    const cpi = t.installs ? t.spend / t.installs : null;
    const rec = c.status === "building" ? "Being built in Meta; numbers start once it's live."
      : t.impressions < AD_FAIR * 2 ? "Too early to change the budget: let the test get a fair read first."
      : winners ? `${winners} proven ad${winners > 1 ? "s" : ""} in Winners${cpi != null ? ` at ${cpi.toFixed(2)} ${currency} per install` : ""}: a +20-30% budget step is the safe way to scale.`
      : t.installs === 0 && t.spend > c.daily_budget * 3 ? "Spending without installs yet: hold the budget while the optimizer re-cuts the weak openings."
      : "Holding: no ad has proven itself yet; keep the budget as it is.";
    campaigns.push({
      id: c.id, title: c.title, status: c.status, daily_budget: c.daily_budget, starts_on: c.starts_on, ends_on: c.ends_on, days_left: daysLeft(c), currency,
      ...t, hook: t.impressions ? t.v3 / t.impressions : null, ctr: t.impressions ? t.clicks / t.impressions : null, cpi,
      groups, insights: st?.insights ?? [], pending: mine, recommendation: rec, max_daily: maxDailyBudget(),
    });
  }

  return {
    goal: { ads: "Ads optimize for installs (cost per install), judged first on the opening and click-through to the App Store.",
      reels: `Reels optimize for virality: reach first. Saves + shares per reach count once a reel passes ${ACT_REACH} reach; below that they're noise.` },
    optimize_on: opt.on, currency, meta, error, campaigns,
    reels: reels.filter((r) => !gone.has(sameKey(r.key))),
    to_delete: every.filter((x) => x.kind === "trial" && x.retire && !x.retire.done).map((x) => {
      const r = reels.find((y) => sameKey(y.key) === sameKey(x.key));
      const nb = every.find((y) => sameKey(y.key) === sameKey(x.retire!.by));
      return { key: x.key, title: x.label.slice(0, 80), permalink: x.retire!.permalink ?? r?.permalink ?? null, poster: r?.poster ?? null,
        by: nb?.label.slice(0, 60) ?? "", version: r?.version ? `v${r.version.n} of ${r.version.of}` : null, at: x.retire!.at, error: x.retire!.error ?? null };
    }),
  };
}
