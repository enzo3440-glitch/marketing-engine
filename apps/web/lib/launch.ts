import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getRepo, type Approval, type ReelJob, type ReelVariant } from "@engine/db";
import { APP_MISSING, creativesOf, defaultObjective, getCampaign, maxDailyBudget, media, metaAds, metaLink, onAdDecision, submitCampaign } from "./ad-campaigns";
import { adPulse, igPosts } from "./meta-insights";
import { createTest, improveTest, runProposal, spendable } from "./improve";
import { deleteVideos } from "./reels";
import { hstToday } from "./utils";
import { streamFolders, streamOf, type Stream } from "./streams";
import { BANNED_SOUND } from "./viral-sounds";
import { BRAND } from "./brand";

/**
 * Launch: the one approval. A finished video is approved as a post (your grid), a trial reel (non-followers only),
 * part of a test (trial reels → cheap ads screen → scale), or an ad with a daily budget and a number of days. Clicking
 * Approve is the human decision; later steps that spend more (screen, scale, budget changes) come back as decisions.
 */

export type Destination = "post" | "trial" | "ad" | "test";
export interface ReadyVideo {
  job_id: string; variant_id: string; title: string; caption: string; script: string[]; poster: string | null; file: string;
  duration: number | null; made_by: string; made_at: string; picked: boolean; idea: string | null;
  launched: string | null; launch_status: string | null; launch_error: string | null; permalink: string | null;
  /** Which Launch column: Instagram (trial reels, posts) or Ads (Meta campaigns). */
  stream: Stream;
  /** What it did once out (the autopilot's last reading), and its verdict. */
  results: { reach: number | null; watch: number | null; act: number | null; verdict: string | null; why: string | null } | null;
}

const now = () => new Date().toISOString();
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

type Line = { text?: string };
type Slide = { text?: string; sub?: string };

/** What the video says, in order: from its brief (hook, on-screen lines, end card) or, for imported videos, its script. */
export function videoScript(job: ReelJob | undefined, v: ReelVariant): string[] {
  if (v.tags?.script) return v.tags.script.split("\n").map((s) => s.trim()).filter(Boolean);
  const b = (job?.request.variants ?? []).find((x) => x.id === v.id) as Record<string, unknown> | undefined;
  const out: string[] = [];
  const hook = (b?.hook as string) || v.hook;
  if (hook) out.push(`Hook: ${hook}`);
  for (const l of ((b?.lines as Line[]) ?? [])) if (l.text) out.push(l.text);
  for (const s of ((b?.slides as Slide[]) ?? [])) if (s.text) out.push(s.sub ? `${s.text} · ${s.sub}` : s.text);
  const [brand, tag] = String(b?.endcard ?? "").split("|");
  if (tag || brand) out.push(`End card: ${[brand, tag].filter(Boolean).join(" · ")}`);
  if (b?.cta) out.push(`CTA: ${b.cta}`);
  if (b?.song_to_add || b?.music) out.push(`Sound: ${String(b.song_to_add ?? b.music).split(/[\\/]/).pop()}`);
  return out;
}

/** Finished videos from the last 30 days, newest first (the latest version of each), with what happened to the ones already launched. */
export async function readyVideos(): Promise<ReadyVideo[]> {
  const repo = getRepo();
  const [jobs, variants, items, posts, campaigns] = await Promise.all([repo.list("reel_jobs", { eq: { status: "done" } }), repo.list("reel_variants"), repo.list("content_items"), repo.list("reel_posts"), repo.list("ad_campaigns")]);
  const folders = streamFolders();
  const since = Date.now() - 30 * 86400_000;
  const byJob = new Map(jobs.filter((j) => Date.parse(j.created_at) >= since).map((j) => [j.job_id, j]));
  const ideaOf = new Map<string, string>();
  for (const c of items) for (const j of ((c.meta as { made_job?: string[] }).made_job ?? [])) ideaOf.set(j, c.id);
  // parked: made by the autopilot without being asked for (kept on disk, off Launch, so they don't bury his picks)
  // and a video on a banned sound never shows: it can't go out
  const shown = variants.filter((v) => v.file && byJob.has(v.job_id) && !v.tags?.parked && !BANNED_SOUND.test(v.tags?.sound ?? "") && fileThere(v.job_id, v.file));
  // one card per ad: the newest of its group (older ones stay on the video's own page)
  const group = adGroups(shown);
  const newest = new Map<string, string>();
  for (const v of shown) {
    const at = byJob.get(v.job_id)!.created_at, k = group(v), cur = newest.get(k);
    if (!cur || at > cur) newest.set(k, at);
  }
  // once it's out (posted, a trial reel, an ad building or running, or in a campaign that's been sent) it leaves Launch:
  // live things are watched on Command → Live. A failed or removed launch, or a planned/rejected/failed campaign, keeps it here.
  const sent = new Set<string>();
  for (const c of campaigns) {
    if (!["building", "ready", "live", "pending_approval"].includes(c.status)) continue;
    for (const x of [...creativesOf(c), ...(c.trials ?? [])]) if (x.job_id) sent.add(`${x.job_id}|${x.variant_id}`);
  }
  const out = (v: ReelVariant) => {
    const t = v.tags ?? {};
    // a post still "posting" after 30 min was cut off (the desk restarted mid-post): it comes back to Launch, never lost
    const stuck = t.launch_status === "posting" && Date.now() - Date.parse(t.posting_at ?? "1970-01-01") > 30 * 60_000;
    // a reel only leaves Launch once Instagram has it: "live" needs the media id Meta returned; an ad leaves while it builds or runs
    const confirmed = t.launched === "ad" || !!t.ig_media_id;
    if (["trial", "post", "ad"].includes(t.launched ?? "") && ((t.launch_status === "live" && confirmed) || (t.launch_status === "posting" && !stuck))) return true;
    return t.launch_status !== "failed" && t.launch_status !== "removed" && sent.has(`${v.job_id}|${v.id}`);
  };
  // a send that didn't go (Instagram's limit, an error) always comes back, even when a newer run of the same ad exists;
  // only a re-cut made from it (e.g. its banned sound swapped) takes its place
  const recut = new Set(shown.map((v) => v.tags?.revision_of).filter(Boolean) as string[]);
  const failed = (v: ReelVariant) => v.tags?.launch_status === "failed" && !recut.has(`${v.job_id}/${v.id}`);
  return shown.filter((v) => (failed(v) || byJob.get(v.job_id)!.created_at === newest.get(group(v))) && !out(v)).map((v) => toReady(byJob.get(v.job_id)!, v, ideaOf, folders, posts.find((p) => p.job_id === v.job_id && p.variant_id === v.id)))
    .sort((a, b) => Number(b.picked) - Number(a.picked) || b.made_at.localeCompare(a.made_at)).slice(0, 80);
}

// the engine shares this machine's disk: a video whose file is gone (deleted, or an old remix) can't play, so it isn't listed
const OUTPUT = path.join(process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data"), "output");
const fileThere = (job: string, file: string) => !fs.existsSync(OUTPUT) || fs.existsSync(path.join(OUTPUT, job, path.basename(file)));

type PostRow = { views: number | null; saves: number | null; shares: number | null; avg_watch_s: number | null };
function toReady(j: ReelJob, v: ReelVariant, ideaOf: Map<string, string>, folders?: Record<string, Stream>, post?: PostRow): ReadyVideo {
  const t = v.tags ?? {};
  const reach = t.ap_reach ? Number(t.ap_reach) : null;
  const results = reach != null || t.ap_verdict ? {
    reach, watch: post?.avg_watch_s != null && v.duration ? post.avg_watch_s / v.duration : null,
    act: reach ? ((post?.saves ?? 0) + (post?.shares ?? 0)) / reach : null, verdict: t.ap_verdict ?? null, why: t.ap_why ?? null,
  } : null;
  return {
    job_id: v.job_id, variant_id: v.id, title: v.hook || v.id, caption: v.caption ?? "", script: videoScript(j, v), poster: v.poster, file: v.file!,
    duration: v.duration, made_by: t.made_by ?? (v.format === "carousel" ? "carousel" : "engine"), made_at: j.created_at, picked: v.picked,
    idea: t.idea ?? ideaOf.get(v.job_id) ?? null, launched: t.launched ?? null, launch_status: t.launch_status ?? null,
    launch_error: t.launch_error ?? null, permalink: t.permalink ?? null, stream: streamOf(v, folders), results,
  };
}

/** "<job>/<video>" of the original a video was tweaked from (itself if it's an original). /brag tweaks are new batches
 * and record "<job>/<video>"; engine revisions sit in the same batch and record just the video id. */
const originOf = (v: ReelVariant) => {
  const r = v.tags?.revision_of;
  return !r ? `${v.job_id}/${v.id}` : r.includes("/") ? r : `${v.job_id}/${r}`;
};

/**
 * Which videos are the same ad, for one card each on Launch: versions of one video (its tweaks), and separate runs that
 * open on the same line (the same ad made again). A/B partners open on different lines, so they stay apart.
 */
function adGroups(vs: ReelVariant[]): (v: ReelVariant) => string {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const join = (a: string, b: string) => { const [x, y] = [find(a), find(b)]; if (x !== y) parent.set(x, y); };
  const line = (v: ReelVariant) => (v.hook ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const v of vs) {
    join(`v:${v.job_id}/${v.id}`, `o:${originOf(v)}`);
    // only separate runs of an ad merge by their opening line; a version or an A/B partner (which may open the same
    // way) goes with what it was made from
    if (line(v).length > 8 && !v.tags?.revision_of && !v.tags?.partner_of) join(`v:${v.job_id}/${v.id}`, `h:${line(v)}`);
  }
  return (v) => find(`v:${v.job_id}/${v.id}`);
}

/** One video for its own page, with every version of it (its tweaks, and other runs of the same ad), oldest first. */
export async function videoWithVersions(jobId: string, variantId: string): Promise<{ video: ReadyVideo; versions: (ReadyVideo & { ask: string | null; summary: string | null })[] } | null> {
  const repo = getRepo();
  const [jobs, variants] = await Promise.all([repo.list("reel_jobs"), repo.list("reel_variants")]);
  const byJob = new Map(jobs.map((j) => [j.job_id, j]));
  const v = variants.find((x) => x.job_id === jobId && x.id === variantId);
  if (!v?.file || !byJob.has(jobId)) return null;
  const none = new Map<string, string>();
  const shown = variants.filter((x) => x.file && byJob.has(x.job_id) && fileThere(x.job_id, x.file));
  const group = adGroups(shown.includes(v) ? shown : [...shown, v]);
  const family = shown.filter((x) => group(x) === group(v));
  return {
    video: toReady(byJob.get(jobId)!, v, none),
    versions: family.map((x) => ({ ...toReady(byJob.get(x.job_id)!, x, none), ask: x.tags?.revision_ask ?? null, summary: x.tags?.revision_summary ?? null }))
      .sort((a, b) => a.made_at.localeCompare(b.made_at)),
  };
}

async function tag(job_id: string, variant_id: string, patch: Record<string, string | null>) {
  const repo = getRepo();
  const [v] = await repo.list("reel_variants", { eq: { job_id, id: variant_id } });
  if (!v) return;
  const tags = { ...(v.tags ?? {}) };
  for (const [k, x] of Object.entries(patch)) if (x == null) delete tags[k]; else tags[k] = x;
  await repo.update("reel_variants", { job_id, id: variant_id }, { tags });
}

export interface LaunchInput {
  job_id: string; variant_id: string; dest: Exclude<Destination, "test">; caption: string;
  daily_budget?: number; days?: number; headline?: string;
}

/** Approve one video as a post, trial reel or ad. Posting and building run in the background; the video's card shows progress. */
export async function launchVideo(o: LaunchInput, by: string): Promise<{ ok: true; detail: string }> {
  const repo = getRepo();
  const [v] = await repo.list("reel_variants", { eq: { job_id: o.job_id, id: o.variant_id } });
  if (!v?.file) throw new Error("That video isn't in the gallery any more");
  if (v.tags?.launched && v.tags.launch_status !== "failed") throw new Error(`Already launched as ${v.tags.launched}`);
  if (o.dest === "trial") { // every trial reel, from any path, stays under the account's daily cap (going over risks a block)
    const { dailyTrials, trialsLastDay } = await import("./daily-reels");
    if ((process.env.DESK_TRIAL_POSTING ?? "off").toLowerCase() !== "on")
      throw new Error("Trial posting is off: Instagram posted the last batch as normal reels, not trial reels. Nothing was sent.");
    const cap = dailyTrials();
    if (!cap) throw new Error("Instagram refused trial reels for a limit; the desk pauses them for a day (Results → Trial reels).");
    if ((await trialsLastDay()) >= cap) throw new Error(`Today's ${cap} trial reels are already out (the ramp's cap for today); try again once the oldest is 24 h old.`);
  }
  const m = metaAds();
  if (!m) throw new Error("Meta isn't connected (Settings → Integrations)");
  const caption = o.caption.trim() || v.caption || "";

  if (o.dest === "post" || o.dest === "trial") {
    await tag(o.job_id, o.variant_id, { launched: o.dest, launch_status: "posting", launch_error: null, approved_by: by, posting_at: now() });
    void (async () => {
      try {
        const send = async () => o.dest === "trial"
          ? (await import("./trial-share")).publishTrialReel(m, await media(o.job_id, v.file!), caption)
          : m.publishReel({ video: await media(o.job_id, v.file!), caption, trial: false });
        const r = o.dest === "trial" ? await (await import("./trial-cap")).postTrial(send) : await send();
        await repo.insert("reel_posts", [{ id: Date.now(), job_id: o.job_id, variant_id: o.variant_id, platform: "ig", url: r.permalink, sound: null,
          posted_at: now(), views: null, avg_watch_s: null, likes: null, comments: null, shares: null, saves: null, follows: null, updated_at: now() }]);
        await tag(o.job_id, o.variant_id, { launch_status: "live", permalink: r.permalink, ig_media_id: r.mediaId });
      } catch (e) {
        await tag(o.job_id, o.variant_id, { launch_status: "failed", launch_error: (e as Error).message.slice(0, 300) });
      }
    })();
    return { ok: true, detail: o.dest === "trial" ? "Posting as a trial reel (non-followers only)…" : "Posting to your grid…" };
  }

  // ad: a campaign starting today, built in Meta now and switched on by the 5-minute ticker
  const budget = Math.round(Number(o.daily_budget) || 0), days = Math.min(Math.max(Math.round(Number(o.days) || 0), 1), 30);
  if (budget < 1) throw new Error("Set a daily budget");
  if (budget > maxDailyBudget()) throw new Error(`Daily budget is over the desk's cap of ${maxDailyBudget()} (META_MAX_DAILY_BUDGET)`);
  const money = await spendable().catch(() => null);
  if (money?.free != null && budget * days > money.free) throw new Error(`That's up to ${budget * days} in total; only ${Math.floor(money.free)} is free after what's already committed`);
  // an app-install ad needs the app registered in Meta: say so on the card before anything is created or approved
  if (defaultObjective() === "app_installs" && !(await m.appFor(process.env.META_DEFAULT_LINK || ""))) throw new Error(APP_MISSING);
  const start = hstToday();
  const id = `ad-${Date.now().toString(36)}`;
  await repo.insert("ad_campaigns", [{
    id, title: (v.hook || v.id).slice(0, 60), concept_id: null, objective: defaultObjective(),
    starts_on: start, ends_on: addDays(start, days - 1), daily_budget: budget,
    countries: (process.env.META_COUNTRIES || "US").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean), age_min: 18, age_max: 65,
    primary_text: caption, headline: (o.headline || v.hook || BRAND.name).slice(0, 40), cta: "DOWNLOAD", link: process.env.META_DEFAULT_LINK || "",
    creative: null, creatives: [{ key: `${o.job_id}|${o.variant_id}`, job_id: o.job_id, variant_id: o.variant_id, file: v.file, poster: v.poster, label: (v.hook || v.id).slice(0, 140) }],
    status: "planned", approval_id: null, meta: {},
    created_at: now(), updated_at: now(),
  }]);
  const a = await submitCampaign(id, by); // validates everything Meta needs
  await repo.update("approvals", { id: a.id }, { status: "approved", decided_by: by, decided_at: now() });
  await onAdDecision({ ...a, status: "approved" }, "approve");
  await tag(o.job_id, o.variant_id, { launched: "ad", launch_status: "building", campaign: id, launch_error: null, approved_by: by });
  return { ok: true, detail: `Building the ad in Meta: ${budget}/day for ${days} day${days > 1 ? "s" : ""}, up to ${budget * days}.` };
}

/** Approve 2–15 videos as one test: their trial reels post now; screening and scaling come back as decisions. */
export async function launchTest(name: string, picks: { job_id: string; variant_id: string; caption?: string; content_id?: string | null }[], by: string) {
  if (picks.length < 2) throw new Error("A test needs at least 2 videos");
  const t = await createTest({ name, picks });
  const { proposals } = await improveTest(t.id, by);
  const post = proposals.find((p) => (p.preview as { action?: { kind?: string } } | null)?.action?.kind === "post_trials") ?? proposals[0];
  if (post) {
    await getRepo().update("approvals", { id: post.id }, { status: "approved", decided_by: by, decided_at: now() });
    void runProposal({ ...post, status: "approved" } as Approval).catch(() => {});
  }
  for (const p of picks) await tag(p.job_id, p.variant_id, { launched: "test", launch_status: "live", test: t.id, launch_error: null, approved_by: by });
  return { ok: true as const, test_id: t.id, detail: `Test "${name}" started: ${picks.length} trial reels posting now.` };
}

/**
 * Launch's Delete: the video goes from everywhere the desk keeps it: its Launch card and files, the draft campaigns
 * (planned or rejected) that list it as an ad or a trial, and its idea's link to it. A video that's out (posted, a
 * trial reel, in a test, or an ad being built or running) is refused: it has to come down on Instagram or Meta first,
 * and its results keep feeding what the desk learns. So is one in a campaign already sent for approval or to Meta.
 * The /brag work folder it was made in stays, so its other versions can still be tweaked.
 */
export async function deleteFromLaunch(job_id: string, variant_id: string, why = "", by = ""): Promise<{ ok: true; detail: string }> {
  const repo = getRepo();
  const [v] = await repo.list("reel_variants", { eq: { job_id, id: variant_id } });
  if (!v) return { ok: true, detail: "Already gone." };
  noteDelete(v, why, by);
  if (v.tags?.launched && v.tags.launch_status !== "failed")
    throw new Error(`It's out as ${v.tags.launched === "ad" ? "an ad" : v.tags.launched === "test" ? "part of a test" : `a ${v.tags.launched}`}, so it stays: take it down on Instagram or Meta first.`);
  const posts = await repo.list("reel_posts", { eq: { job_id } });
  if (posts.some((p) => p.variant_id === variant_id)) throw new Error("It's been posted, so it stays: its results feed what the desk learns.");

  const mine = (x: { job_id?: string; variant_id?: string } | null | undefined) => x?.job_id === job_id && x?.variant_id === variant_id;
  const campaigns = await repo.list("ad_campaigns");
  const using = campaigns.filter((c) => creativesOf(c).some(mine) || (c.trials ?? []).some(mine));
  const live = using.filter((c) => !["planned", "rejected"].includes(c.status));
  if (live.length) throw new Error(`It's in "${live[0].title}", which is ${live[0].status.replace("_", " ")}: take it out of that campaign first.`);
  for (const c of using) {
    await repo.update("ad_campaigns", { id: c.id }, {
      creatives: (c.creatives ?? []).filter((x) => !mine(x)), trials: (c.trials ?? []).filter((x) => !mine(x)),
      creative: mine(c.creative) ? null : c.creative, updated_at: now(),
    });
  }

  const r = await deleteVideos(job_id, [variant_id]);
  if (r.job_deleted) {
    for (const c of await repo.list("content_items")) {
      const made = (c.meta as { made_job?: string[] }).made_job;
      if (made?.includes(job_id)) await repo.update("content_items", { id: c.id }, { meta: { ...c.meta, made_job: made.filter((j) => j !== job_id) } });
    }
  }
  return { ok: true, detail: `Deleted${using.length ? `, and taken out of ${using.length} draft campaign${using.length > 1 ? "s" : ""}` : ""}.` };
}

/**
 * Every video the founder deletes is a taste note. It goes to the engine's knowledge (read by every edit and brief) with its sound, opening, script and why.
 */
const TASTE = path.resolve(process.cwd(), "../../services/reel-engine/knowledge/founder-deletes.md");
function noteDelete(v: ReelVariant, why: string, by: string) {
  try {
    const t = v.tags ?? {};
    if (!fs.existsSync(TASTE)) fs.writeFileSync(TASTE, "# What the founder deleted, and why\n\nEach line is a video he judged bad on Launch. Don't make more like these: same sound, same opening, same idea. A reason, when he gave one, wins over everything else here.\n\n");
    const script = String(t.script ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" / ");
    fs.appendFileSync(TASTE, `- ${new Date().toISOString().slice(0, 10)} · ${t.made_by ?? v.format ?? "video"} · sound: ${t.sound ?? "its own"} · "${(v.hook ?? v.id).replace(/\s+/g, " ").slice(0, 120)}"${script ? ` · script: ${script.slice(0, 240)}` : ""}${why.trim() ? ` · **why: ${why.trim()}**` : " · (no reason given)"}${by ? ` · ${by.split("@")[0]}` : ""}\n`);
  } catch { /* the delete still goes ahead */ }
}

/** What's out there and what's waiting on you. */
export async function inFlight() {
  const repo = getRepo();
  const [approvals, campaigns, tests] = await Promise.all([
    repo.list("approvals", { eq: { status: "pending" }, order: { col: "created_at", asc: false } }),
    repo.list("ad_campaigns", { order: { col: "created_at", asc: false } }), repo.list("growth_tests", { order: { col: "created_at", asc: false } }),
  ]);
  return {
    decisions: approvals,
    ads: campaigns.filter((c) => !["ended", "rejected"].includes(c.status)).slice(0, 12),
    tests: tests.filter((t) => t.stage !== "done").slice(0, 8),
  };
}

/**
 * Launch → Campaigns "Send for approval": the campaign's ads go to the approvals queue (nothing reaches Meta until that
 * approval is approved), and the videos marked "Send to trial" go out through the same trial-reel launch as a video
 * card's "Approve as trial reel" (this click is that approval). Problems with the campaign stop everything first.
 */
export async function sendCampaign(id: string, by: string): Promise<{ ok: true; detail: string }> {
  const c = await getCampaign(id);
  const ads = creativesOf(c), trials = c.trials ?? [];
  if (!ads.length && !trials.length) throw new Error("Pick at least one video: in the campaign or sent to trial");
  const out: string[] = [];
  if (ads.length) {
    if (["planned", "rejected"].includes(c.status)) {
      await submitCampaign(id, by); // validates everything Meta needs, throws before any trial posts
      out.push(`Campaign sent for approval with ${ads.length} ad${ads.length > 1 ? "s" : ""}.`);
    } else if (c.status !== "pending_approval") throw new Error(`The campaign is ${c.status}; only planned or rejected campaigns can be sent`);
  }
  const repo = getRepo();
  let posted = 0;
  for (const t of trials) {
    const [v] = await repo.list("reel_variants", { eq: { job_id: t.job_id, id: t.variant_id } });
    if (v?.tags?.launched && v.tags.launch_status !== "failed") continue; // already out
    try {
      await launchVideo({ job_id: t.job_id, variant_id: t.variant_id, dest: "trial", caption: "" }, by);
      posted++;
    } catch (e) {
      out.push(`Trial "${t.label ?? t.variant_id}": ${(e as Error).message}`);
    }
  }
  if (posted) out.push(`Posting ${posted} trial reel${posted > 1 ? "s" : ""} (non-followers only)…`);
  if (!out.length) out.push("Nothing new to send.");
  return { ok: true, detail: out.join(" ") };
}

/**
 * Launch → Campaigns: every desk campaign (newest first), the Instagram feed for the picker, and which feed posts are
 * already promoted: in one of the desk's campaigns, or named in a Meta campaign (the desk names promotions by the
 * post's id, "IG post <last 6>").
 */
export async function campaignDesk() {
  const [campaigns, posts, pulse, meta] = await Promise.all([
    getRepo().list("ad_campaigns", { order: { col: "created_at", asc: false } }),
    igPosts(24).catch(() => null), adPulse(30).catch(() => null), metaLink(),
  ]);
  const promoted: Record<string, string> = {};
  for (const c of campaigns) {
    if (c.status === "rejected") continue;
    for (const x of creativesOf(c)) if (x.ig_media_id) promoted[x.ig_media_id] ??= `${c.title} · ${c.status.replace("_", " ")}`;
  }
  for (const p of posts ?? []) {
    if (promoted[p.id]) continue;
    const hit = pulse?.campaigns.find((r) => r.name.includes(p.id) || r.name.includes(`IG post ${p.id.slice(-6)}`));
    if (hit) promoted[p.id] = `Meta: ${hit.name}`;
  }
  const { launchStructure, withReads } = await import("./waves");
  const shown = campaigns.slice(0, 40);
  const structures: Record<string, import("./waves").LaunchStructure> = {};
  for (const c of shown.filter((x) => x.status !== "rejected" && creativesOf(x).length >= 4)) {
    const st = await launchStructure(c).catch(() => null);
    if (st) structures[c.id] = await withReads(c, st).catch(() => st);
  }
  return { campaigns: shown, posts, promoted, meta, structures };
}

/** Launch's per-video campaign picker: draft campaigns you can still add to, and which campaigns each video is in. */
export interface CampaignChoice { id: string; title: string; status: string }
export async function campaignChoices(): Promise<{ open: CampaignChoice[]; member: Record<string, { id: string; title: string; as: "ad" | "trial"; status: string }[]> }> {
  const all = await getRepo().list("ad_campaigns", { order: { col: "created_at", asc: false } });
  const member: Record<string, { id: string; title: string; as: "ad" | "trial"; status: string }[]> = {};
  const add = (k: string, x: { id: string; title: string; as: "ad" | "trial"; status: string }) => (member[k] ??= []).push(x);
  for (const c of all) {
    if (c.status === "ended") continue;
    for (const x of creativesOf(c)) if (x.job_id && x.variant_id) add(`${x.job_id}|${x.variant_id}`, { id: c.id, title: c.title, as: "ad", status: c.status });
    for (const x of c.trials ?? []) add(`${x.job_id}|${x.variant_id}`, { id: c.id, title: c.title, as: "trial", status: c.status });
  }
  return { open: all.filter((c) => ["planned", "rejected"].includes(c.status)).map((c) => ({ id: c.id, title: c.title, status: c.status })), member };
}

/** Put a video in a draft campaign as one of its ads or as a trial sent alongside it, or take it out ("none"). */
export async function assignToCampaign(job_id: string, variant_id: string, campaign_id: string, as: "ad" | "trial" | "none"): Promise<{ ok: true; detail: string }> {
  const c = await getCampaign(campaign_id);
  if (!["planned", "rejected"].includes(c.status)) throw new Error(`"${c.title}" is ${c.status.replace("_", " ")}, so its videos can't change here`);
  const [v] = await getRepo().list("reel_variants", { eq: { job_id, id: variant_id } });
  if (!v?.file) throw new Error("That video isn't on Launch any more");
  const k = `${job_id}|${variant_id}`;
  const mine = (x: { job_id?: string; variant_id?: string }) => x.job_id === job_id && x.variant_id === variant_id;
  const label = (v.hook || v.id).slice(0, 140);
  let creatives = (c.creatives ?? []).filter((x) => !mine(x));
  let trials = (c.trials ?? []).filter((x) => !mine(x));
  if (as === "ad") creatives = [...creatives, { key: k, job_id, variant_id, file: v.file, poster: v.poster, label }];
  if (as === "trial") trials = [...trials, { key: k, job_id, variant_id, label, poster: v.poster }];
  await getRepo().update("ad_campaigns", { id: c.id }, { creatives, trials, creative: c.creative && mine(c.creative) ? null : c.creative, updated_at: now() });
  return { ok: true, detail: as === "none" ? `Taken out of "${c.title}".` : `In "${c.title}" as ${as === "ad" ? "an ad" : "a trial"}. Send it from Campaigns when it's ready.` };
}

/** Launch's "move to" switch: which column (and so which kind of launch and judging) a video belongs to. */
export async function setStream(job_id: string, variant_id: string, stream: Stream) {
  await tag(job_id, variant_id, { stream });
  return { ok: true as const, detail: stream === "ig" ? "Moved to Instagram." : "Moved to Ads." };
}

export { getCampaign };
