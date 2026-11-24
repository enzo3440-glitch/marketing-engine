import "server-only";
import { getRepo, type Approval, type ReelVariant } from "@engine/db";
import { metaAds } from "./ad-campaigns";
import { bragTweak, startBragTweak } from "./brag-tweak";
import { improveCampaign, improveTest, improvePost, TRIAL_HOURS } from "./improve";
import { dailyTick } from "./daily-reels";
import { proposeRotation } from "./ad-rotation";
import { optimizeOn, tickOptimize } from "./optimize";
import { ACT_REACH } from "./lab";
import { tickTravelTrends } from "./travel-trends";
import { streamFolders, streamOf } from "./streams";

/**
 * Autopilot: the desk learns from what's out and makes the next version itself.
 *
 * Every 30 minutes (instrumentation-node.ts → POST /api/autopilot) it:
 *  1. moves tests and live ad campaigns along (the same Improve as the buttons: measure, then propose);
 *  2. measures every video launched as a post or trial reel, and once one has had TRIAL_HOURS of reach, judges it
 *     against the desk's other launched videos:
 *       - viewers leave early (low average watch)      → re-edit the opening (hook shot and line);
 *       - they watch but don't save or share            → re-edit the payoff (app moment, last shot, end card);
 *       - clearly better than the rest                  → propose promoting it as an ad, and make the same ad in
 *                                                         another place to see if it travels;
 *       - in between                                    → hold;
 *  3. when its new version is rendered, proposes posting it as a trial reel.
 *     and, once a campaign's ads have had a fair look, proposes swapping its weak ads for new ones (lib/ad-rotation.ts);
 *  4. fills the Instagram stream's daily quota of trial reels (lib/daily-reels.ts): remixes of winners and new reels.
 * Making a version uses the Max login only. Posting and spending always wait for your approval in Decide.
 * DESK_AUTOPILOT=off stops it; DESK_AUTOPILOT_REMAKES caps new versions per day (default 3).
 */

const now = () => new Date().toISOString();
const hoursSince = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);
const MIN_REACH = 150;
const MEASURE_EVERY_H = 6;
const BY = "autopilot";

export const autopilotOn = () => (process.env.DESK_AUTOPILOT ?? "on").toLowerCase() !== "off";
const remakesPerDay = () => { const n = Number(process.env.DESK_AUTOPILOT_REMAKES); return Number.isFinite(n) && n >= 0 && process.env.DESK_AUTOPILOT_REMAKES ? n : 3; };

type Log = { at: string; text: string };
const S = ((globalThis as { __autopilot?: { running: boolean; last: string | null; log: Log[]; touched: Map<string, number> } }).__autopilot ??=
  { running: false, last: null, log: [] as Log[], touched: new Map<string, number>() });
const note = (text: string) => { S.log.unshift({ at: now(), text }); S.log.length = Math.min(S.log.length, 60); };
/** At most once per `hours` for one thing (in memory: a restart just measures once more). */
const due = (key: string, hours: number) => {
  const t = S.touched.get(key);
  if (t && Date.now() - t < hours * 3_600_000) return false;
  S.touched.set(key, Date.now());
  return true;
};

export const autopilotStatus = () => ({ on: autopilotOn(), running: S.running, last: S.last, log: S.log.slice(0, 30), remakes_per_day: remakesPerDay() });

export type Verdict = "hook" | "payoff" | "winner" | "hold";
export interface Reading { reach: number; saves: number; shares: number; views: number; avg_watch_s: number | null; duration: number | null }

const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const act = (r: Reading) => (r.reach ? (r.saves + r.shares) / r.reach : 0);
const watch = (r: Reading) => (r.avg_watch_s != null && r.duration ? r.avg_watch_s / r.duration : null);

/**
 * What to do with one video, from its results and the desk's other launched videos. With fewer than 3 others to
 * compare against, fixed bars stand in: watching under 35% of the video is a weak hook, under 1% saves+shares is a
 * weak payoff, and both at 2x those is a winner.
 */
export function judge(r: Reading, others: Reading[]): { verdict: Verdict; why: string } {
  const w = watch(r), a = act(r);
  const peers = others.filter((o) => o.reach >= MIN_REACH);
  const mw = peers.length >= 3 ? median(peers.map(watch).filter((x): x is number => x != null)) : null;
  const ma = peers.length >= 3 ? median(peers.map(act)) : null;
  const wBar = mw ?? 0.35, aBar = ma ?? 0.01;
  const vs = mw != null ? "the desk's other videos" : "the starting bar";
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const watched = w != null ? `watched ${pct(w)} of it on average (${r.avg_watch_s!.toFixed(1)} of ${r.duration!.toFixed(1)} s)` : "watch time unknown";
  const acted = `${pct(a)} saved or shared`;
  if (w != null && w < wBar * 0.75) return { verdict: "hook", why: `Viewers leave early: ${watched}, against ${pct(wBar)} for ${vs}.` };
  if (a < aBar * 0.7) return { verdict: "payoff", why: `They watch (${watched}) but only ${acted}, against ${pct(aBar)} for ${vs}.` };
  // a winner needs real reach: saves+shares on a few hundred views are noise
  if ((w == null || w >= wBar * 1.25) && a >= aBar * 1.4 && r.reach >= Math.max(MIN_REACH, ACT_REACH)) return { verdict: "winner", why: `Ahead of ${vs}: ${watched}, ${acted}.` };
  return { verdict: "hold", why: `In line with ${vs}: ${watched}, ${acted}.` };
}

const ASK: Record<Exclude<Verdict, "hold">, (why: string) => string> = {
  hook: (why) => `Results say: ${why} Rework only the opening 2-3 seconds so people stay: open on the most beautiful, most
cinematic shot this ad has (or a better best-of-roll clip from the SAME place in the kit's footage.md), make the setup
line shorter so it reads in one glance, and make sure the first frame works with the sound off. Keep the story, every
other line, the place, the music and the drop timing exactly as they are.`,
  payoff: (why) => `Results say: ${why} Rework only the payoff so people save or share it: hold the payoff shot of the
place longer, make the app moment bigger and clearer (the feature fills the frame, held 2.5-3 s), and let the end card
hold 2.5 s. Keep the opening, the place, the music and the drop timing exactly as they are.`,
  winner: (why) => `Results say this one works: ${why} Make the same ad in a different place to see if it travels: keep
every line, the timing, the music and the drop exactly, and recast every shot from ONE other place in the kit's
footage.md best-of-roll section that this ad doesn't use (pick the place whose best clips fit the story best). The
problem and the payoff must match that place, and any place name in a line or on a screen changes to the new place.`,
};

/** Results of one launched video into reel_posts and its tags; null if it can't be read. */
async function measure(v: ReelVariant): Promise<Reading | null> {
  const m = metaAds();
  const id = v.tags?.ig_media_id;
  if (!m || !id) return null;
  const r = await m.reelResults(id).catch(async (e: Error) => {
    // gone from Instagram (deleted, or it never really published): back to Launch so it can go again
    if (/does not exist|cannot be loaded/i.test(e.message ?? "")) await tag(v, { launch_status: "failed", launch_error: "Not on Instagram any more (Meta can't find it). Send it again." });
    throw e;
  });
  const reading: Reading = { reach: r.reach, saves: r.saves, shares: r.shares, views: r.views, avg_watch_s: r.avgWatchMs != null ? r.avgWatchMs / 1000 : null, duration: v.duration };
  const repo = getRepo();
  const [row] = await repo.list("reel_posts", { eq: { job_id: v.job_id, variant_id: v.id } });
  const patch = { views: r.views || r.reach, saves: r.saves, shares: r.shares, avg_watch_s: reading.avg_watch_s, updated_at: now() };
  if (row) await repo.update("reel_posts", { id: row.id }, patch);
  await tag(v, { ap_reach: String(r.reach), ap_measured_at: now() });
  return reading;
}

async function tag(v: ReelVariant, patch: Record<string, string | null>) {
  const repo = getRepo();
  const [cur] = await repo.list("reel_variants", { eq: { job_id: v.job_id, id: v.id } });
  const tags = { ...(cur?.tags ?? v.tags ?? {}) };
  for (const [k, x] of Object.entries(patch)) if (x == null) delete tags[k]; else tags[k] = x;
  await repo.update("reel_variants", { job_id: v.job_id, id: v.id }, { tags });
  v.tags = tags;
}

const remakesToday = (vs: ReelVariant[]) => vs.filter((v) => hoursSince(v.tags?.ap_remake_at) < 24).length;

async function proposeTrial(v: ReelVariant, from: ReelVariant): Promise<Approval> {
  const [a] = await getRepo().insert("approvals", [{
    id: crypto.randomUUID(), type: "optimize", ref_table: "reel_variants", ref_id: `${v.job_id}/${v.id}`,
    title: `Post the new version of "${(from.hook || from.id).slice(0, 60)}" as a trial reel`,
    summary: "Free. Shown only to non-followers; nothing appears on your grid. The autopilot judges it like the first one.",
    preview: {
      bullets: [from.tags?.ap_why ?? "", `What changed: ${v.tags?.revision_summary || v.tags?.revision_ask || "a new version"}`].filter(Boolean),
      action: { kind: "post_trial_video", job_id: v.job_id, variant_id: v.id, caption: v.caption ?? from.caption ?? "" },
    },
    status: "pending", created_by_agent: BY, decided_by: null, decided_at: null, result: null, created_at: now(),
  }]);
  return a;
}

/** One pass. Safe to call any time: it skips what was done recently and never runs twice at once. */
export async function tickAutopilot(): Promise<{ notes: string[] }> {
  if (!autopilotOn() || S.running) return { notes: [] };
  if (!metaAds()) return { notes: ["Meta isn't connected."] };
  S.running = true;
  const notes: string[] = [];
  const say = (t: string) => { notes.push(t); note(t); };
  try {
    const repo = getRepo();
    // live optimize on: it kills, re-cuts and swaps ads and trial reels itself (lib/optimize.ts), so the slower
    // propose-and-wait versions of that (rotation, judging trial reels) stand down
    const opt = optimizeOn();

    // 1. tests and campaigns: the Improve buttons, on a clock (they skip when a proposal is already waiting)
    for (const t of await repo.list("growth_tests")) {
      if (t.stage === "done" || !due(`test:${t.id}`, MEASURE_EVERY_H)) continue;
      const r = await improveTest(t.id, BY).catch((e) => ({ proposals: [], notes: [(e as Error).message] }));
      if (r.proposals.length) say(`Test "${t.name}": ${r.proposals.map((p) => p.title).join("; ")}`);
    }
    for (const c of await repo.list("ad_campaigns")) {
      if (!["live", "ready"].includes(c.status) || !c.meta.campaign_id || !due(`ad:${c.id}`, MEASURE_EVERY_H)) continue;
      const r = await improveCampaign(c.id, BY).catch((e) => ({ proposals: [], notes: [(e as Error).message] }));
      if (r.proposals.length) say(`Ad "${c.title}": ${r.proposals.map((p) => p.title).join("; ")}`);
      // keep the ads that work, swap the rest for new ones from the Ads column
      if (!opt && !r.proposals.length && due(`rotate:${c.id}`, 24)) {
        const rot = await proposeRotation(c.id, BY).catch((e) => { say(`Ad "${c.title}": rotation check failed: ${(e as Error).message}`); return null; });
        if (rot) say(`Ad "${c.title}": ${rot.title}`);
      }
    }

    // always: retiring old versions runs even with live optimize off; the rest of the pass checks the toggle
    await tickOptimize(say).catch((e) => say(`Live optimize: ${(e as Error).message}`));
    // the daily top 10 reels in the niche: find, read, learn the patterns into knowledge/niche-trends.md
    await tickTravelTrends(say).catch((e) => say(`Niche trends: ${(e as Error).message}`));

    // 2. launched videos: measure, judge once, make the next version
    const variants = await repo.list("reel_variants");
    const out = variants.filter((v) => (opt ? ["post"] : ["post", "trial"]).includes(v.tags?.launched ?? "") && v.tags?.launch_status === "live" && v.tags?.ig_media_id);
    const posts = await repo.list("reel_posts");
    const postedAt = (v: ReelVariant) => posts.find((p) => p.job_id === v.job_id && p.variant_id === v.id)?.posted_at ?? null;
    const readings = new Map<string, Reading>();
    for (const v of out) {
      const k = `${v.job_id}/${v.id}`;
      if (!due(`video:${k}`, MEASURE_EVERY_H) && v.tags?.ap_reach) {
        readings.set(k, { reach: Number(v.tags.ap_reach), saves: 0, shares: 0, views: 0, avg_watch_s: null, duration: v.duration });
        continue;
      }
      const r = await measure(v).catch(() => null);
      if (r) readings.set(k, r);
    }
    // rebuild peer readings from reel_posts (saves/shares/watch are stored there), so judging sees every launched video
    const reading = (v: ReelVariant): Reading | null => {
      const live = readings.get(`${v.job_id}/${v.id}`);
      const p = posts.find((x) => x.job_id === v.job_id && x.variant_id === v.id);
      if (live && live.saves + live.shares + live.views > 0) return live;
      if (!p || !v.tags?.ap_reach) return live ?? null;
      return { reach: Number(v.tags.ap_reach), saves: p.saves ?? 0, shares: p.shares ?? 0, views: p.views ?? 0, avg_watch_s: p.avg_watch_s, duration: v.duration };
    };
    let budget = Math.max(0, remakesPerDay() - remakesToday(variants));
    for (const v of out) {
      if (v.tags?.ap_verdict) continue; // judged once; its new version gets judged on its own
      if (hoursSince(postedAt(v)) < TRIAL_HOURS()) continue;
      const r = reading(v);
      if (!r || r.reach < MIN_REACH) continue;
      // judged against its own stream: an Instagram reel and a product ad aren't the same kind of video
      const folders = streamFolders();
      const others = out.filter((o) => o !== v && streamOf(o, folders) === streamOf(v, folders)).map(reading).filter((x): x is Reading => !!x);
      const { verdict, why } = judge(r, others);
      const label = (v.hook || v.id).slice(0, 60);
      if (verdict === "hold") { await tag(v, { ap_verdict: "hold", ap_why: why, ap_judged_at: now() }); say(`"${label}": holding. ${why}`); continue; }
      if (verdict === "winner" && v.tags?.ig_media_id) {
        const p = await improvePost(v.tags.ig_media_id, v.caption ?? "", BY).catch(() => null);
        if (p?.proposals.length) say(`"${label}": ${p.proposals[0].title}`);
      }
      if (budget <= 0) { say(`"${label}": ${why} The next version waits: today's ${remakesPerDay()} new versions are used.`); continue; }
      const ask = ASK[verdict](why).replace(/\s*\n\s*/g, " ").slice(0, 1000);
      try {
        await startBragTweak(v.job_id, v.id, ask, verdict === "winner");
        budget--;
        await tag(v, { ap_verdict: verdict, ap_why: why, ap_judged_at: now(), ap_remake_at: now(), ap_ask: ask.slice(0, 300) });
        say(`"${label}": ${why} Making a new version (${verdict === "hook" ? "the opening" : verdict === "payoff" ? "the payoff" : "another place"}).`);
      } catch (e) {
        say(`"${label}": couldn't start the new version: ${(e as Error).message}`);
        await tag(v, { ap_verdict: verdict, ap_why: why, ap_judged_at: now(), ap_error: (e as Error).message.slice(0, 200) });
      }
    }

    // 3. a new version is ready: propose it as a trial reel (once)
    for (const v of variants.filter((x) => x.tags?.ap_remake_at && !x.tags?.ap_proposed)) {
      const t = bragTweak(v.job_id, v.id);
      const origin = v.tags?.revision_of || `${v.job_id}/${v.id}`;
      const fresh = await repo.list("reel_variants");
      // the tweak names its new video; after a restart, find it by the ask it was made from
      const made = (t?.status === "done" && t.job_id ? fresh.find((x) => x.job_id === t.job_id) : undefined) ?? fresh.find((x) =>
        x.tags?.revision_ask && v.tags?.ap_ask && x.tags.revision_ask.startsWith(v.tags.ap_ask.slice(0, 120)) &&
        (x.tags.revision_of === origin || x.tags.partner_of === origin));
      if (made) {
        const a = await proposeTrial(made, v);
        await tag(v, { ap_proposed: a.id });
        say(`"${(v.hook || v.id).slice(0, 60)}": new version ready; trial reel waiting for you in Decide.`);
      } else if (t?.status === "error" || (!t && hoursSince(v.tags?.ap_remake_at) > 2)) {
        await tag(v, { ap_proposed: "none", ap_error: (t?.error ?? "the new version didn't come back").slice(0, 200) });
        say(`"${(v.hook || v.id).slice(0, 60)}": the new version failed (${(t?.error ?? "no cut came back").slice(0, 120)}).`);
      }
    }
    // 4. the Instagram stream's daily quota: make the day's reels, then offer them as one batch
    await dailyTick(say).catch((e) => say(`Instagram daily reels: ${(e as Error).message}`));
  } finally {
    S.running = false;
    S.last = now();
  }
  return { notes };
}
