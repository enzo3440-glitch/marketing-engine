import { tzOffsetMs } from "./tz";
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getRepo, type AdCampaign, type ReelVariant } from "@engine/db";
import { creativesOf, metaAds } from "./ad-campaigns";
import { bragTweak, startBragTweak } from "./brag-tweak";
import { featureOf } from "./features";
import * as lab from "./lab";
import { spawnSync } from "node:child_process";
import { wavesPass, type AdRead } from "./waves";

/**
 * Live optimize: once videos are launched, a toggle lets the tool monitor in real time how videos are doing, ads or
 * trial reels. Zero traction: kill them. Some traction early that drops off: make slight adjustments and repost
 * immediately. As fast as possible, but with a good signal, and videos aren't killed just because they lack early
 * traction: maybe the hook isn't good enough but the rest is, so that is changed first.
 *
 * With the toggle on, every autopilot pass (30 min) reads each live ad (every hour; the opening judged from 500 impressions, clicks from 1,000 and 2 days) and trial reel (every 2 h, from 6 h
 * after posting) and acts on its own, no approval in Decide:
 *   zero      enough reach, nobody stayed or clicked         → kill (pause the ad; leave the trial reel to die off)
 *   hook      people scroll past, but those who stay do well → re-cut only the opening, then swap / repost it
 *   payoff    they watch, but don't click / save / share     → re-cut only the payoff and end card, then swap / repost
 *   fresh     it worked, then dropped off (fatigue, a stall) → a fresh opening on the same story, then swap / repost
 * A video gets MAX_FIXES re-cuts (hook first) before it is killed, so a good video with a weak hook isn't lost.
 * Signal comes from impressions and reach, not hours: an ad is judged at 250+ impressions (clicks at 300 and a day; no click at all in 150+ after a day is re-cut at once), a trial at 120+ reach or 80+ once 12 h old.
 * What it never does on its own: raise a budget, start a campaign, or promote a post (those still come to Decide).
 * Every action is logged here and written to the approvals table as already carried out, so Decide's history shows it.
 */

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const FILE = path.join(DATA, "ads", "_optimize.json");
const BY = "live optimize";
const MAX_FIXES = () => { const n = Number(process.env.DESK_OPTIMIZE_FIXES); return Number.isFinite(n) && n >= 0 && process.env.DESK_OPTIMIZE_FIXES ? n : 2; };
const FIXES_PER_DAY = () => { const n = Number(process.env.DESK_OPTIMIZE_REMAKES); return Number.isFinite(n) && n >= 0 && process.env.DESK_OPTIMIZE_REMAKES ? n : 8; };
// Conservative to start. Reading is hourly; acting waits for enough data, and every knob is an env var to tighten later.
//  - the opening (3-second views per impression) settles first: judged from AD_HOOK impressions
//  - clicks are rare (~1%), so the payoff is judged only from AD_PAYOFF impressions and AD_PAYOFF_H hours live
//  - nothing is ever killed on its first read: a weak video gets a re-cut of the weak part first (up to MAX_FIXES), and a
//    re-cut is only killed once it has had AD_KILL impressions of its own and is still weak on both the opening and clicks
const knob = (name: string, d: number) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n >= 0 ? n : d; };
// Waiting too long to pull back, edit and resubmit is costly, so these are the smallest reads that still mean
// something: the opening at 250 impressions (a 3-s hook rate is known to about ±3 points by then), clicks at 300
// impressions and a day live, and a day-old ad with 150+ impressions and not one click is broken (at our ~4% click-through
// that happens by chance under 0.3% of the time), so it's re-cut at once.
const AD_HOOK = knob("DESK_OPT_HOOK_IMPRESSIONS", 250), AD_PAYOFF = knob("DESK_OPT_PAYOFF_IMPRESSIONS", 300), AD_PAYOFF_H = knob("DESK_OPT_PAYOFF_HOURS", 12);
const AD_NOCLICK = knob("DESK_OPT_NOCLICK_IMPRESSIONS", 150), AD_NOCLICK_H = knob("DESK_OPT_NOCLICK_HOURS", 24);
const AD_KILL = knob("DESK_OPT_KILL_IMPRESSIONS", 2000), AD_STARVED = 300, AD_STARVED_H = knob("DESK_OPT_STARVED_HOURS", 24), AD_FATIGUE = 3000, AD_READ_H = 1;
const AD_FAIR = AD_HOOK;
// trial reels stall around 100-180 reach, so a day-old trial with
// 80+ reach gets judged too, against the other trials
// trials are judged at 120 reach, or at 80 once 12 h old (skip rate is known to about ±9 points at 100 reach,
// enough to catch a reel that loses most viewers in the first seconds).
const TRIAL_FAIR = knob("DESK_OPT_TRIAL_REACH", 120), TRIAL_DAY_REACH = knob("DESK_OPT_TRIAL_DAY_REACH", 80), TRIAL_DAY_H = knob("DESK_OPT_TRIAL_HOURS", 12), TRIAL_FIRST_H = 6;
// the reach a trial must reach before it's left alone
const TRIAL_TARGET = knob("DESK_OPT_TRIAL_TARGET", 1000), TRIAL_FLAT_H = 6;

type Verdict = "zero" | "hook" | "payoff" | "fresh";
export interface Reading { at: string; impressions?: number; reach?: number; hook?: number; hold?: number; ctr?: number; clicks?: number; spend?: number;
  installs?: number; watch?: number | null; act?: number; recent_ctr?: number | null;
  skip?: number | null; likes?: number; curve?: number[] }
export interface Item {
  key: string; kind: "ad" | "trial"; label: string; feature: string; root: string; campaign?: string; first_seen: string;
  status: "watching" | "fixing" | "review" | "killed" | "replaced"; fixes: number; last?: Reading; readings: Reading[];
  // a change the optimizer wants to push out (swap in / repost a re-cut, pause an ad) waits here for the founder's one-click OK
  pending?: { kind: "swap" | "kill"; job_id?: string; variant_id?: string; approval_id: string; at: string; what: string; why: string; test?: string };
  // a newer version went out; ads are paused, trial reels wait for the founder to delete them in Instagram
  retire?: { at: string; by: string; done: boolean; permalink?: string | null; tried?: string; error?: string; deleted_by?: "desk" | "founder" };
  fix?: { verdict: Verdict; why: string; started_at: string; ask: string }; why?: string; next?: string; history: { at: string; text: string }[];
}
interface State { on: boolean; changed_at: string | null; changed_by: string | null; log: { at: string; text: string }[]; items: Record<string, Item>; touched: Record<string, string> }

const now = () => new Date().toISOString();
const hoursSince = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);
const read = (): State => {
  try { return { on: false, changed_at: null, changed_by: null, log: [], items: {}, touched: {}, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; }
  catch { return { on: false, changed_at: null, changed_by: null, log: [], items: {}, touched: {} }; }
};
const write = (s: State) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 1)); };

export const optimizeOn = () => read().on;
export function setOptimize(on: boolean, by: string) {
  const s = read();
  s.on = on; s.changed_at = now(); s.changed_by = by;
  s.log.unshift({ at: now(), text: `Live optimize turned ${on ? "on" : "off"} by ${by}.` });
  s.log.length = Math.min(s.log.length, 200);
  write(s);
  return optimizeStatus();
}
/** Every tracked video, for the version lineages on Command → Live (v1, v2, v3 of one original). */
export function allItems(): Item[] { return Object.values(read().items); }

export function optimizeStatus() {
  const s = read();
  const items = Object.values(s.items).sort((a, b) => (b.history[0]?.at ?? b.first_seen).localeCompare(a.history[0]?.at ?? a.first_seen));
  const count = (st: Item["status"]) => items.filter((x) => x.status === st).length;
  return { on: s.on, changed_at: s.changed_at, changed_by: s.changed_by, log: s.log.slice(0, 40), items: items.slice(0, 120),
    counts: { watching: count("watching"), fixing: count("fixing"), review: count("review"), killed: count("killed"), replaced: count("replaced") },
    rules: { max_fixes: MAX_FIXES(), fixes_per_day: FIXES_PER_DAY(), ad_fair: AD_FAIR, ad_payoff: AD_PAYOFF, ad_kill: AD_KILL, trial_fair: TRIAL_FAIR, trial_target: TRIAL_TARGET } };
}

const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);

// imports carry no length, so "watched %" never worked for trials: read it off the file once
const LENGTHS = new Map<string, number | null>();
function lengthOf(v: ReelVariant): number | null {
  if (v.duration) return v.duration;
  const k = `${v.job_id}/${v.id}`;
  if (LENGTHS.has(k)) return LENGTHS.get(k)!;
  const f = path.join(DATA, "output", v.job_id, "video.mp4");
  const ff = path.resolve(DATA, "..", "bin", "ffmpeg.exe");
  const r = fs.existsSync(f) ? spawnSync(fs.existsSync(ff) ? ff : "ffmpeg", ["-hide_banner", "-i", f], { encoding: "utf8", windowsHide: true }) : null;
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(`${r?.stderr ?? ""}`);
  const secs = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  LENGTHS.set(k, secs);
  return secs;
}

/** An item's latest reading in the lab's terms. */
const metricsOf = (it: Item): lab.Metrics | null => {
  const r = it.last;
  if (!r) return null;
  return it.kind === "ad"
    ? { n: r.impressions ?? 0, hook: r.hook ?? null, watch: r.hold ?? null, act: r.ctr ?? null, curve: r.curve }
    : { n: r.reach ?? 0, skip: r.skip ?? null, watch: r.watch ?? null, act: r.act ?? null, likes: r.likes ?? null };
};
const fairRead = (kind: "ad" | "trial", m: lab.Metrics) => (kind === "ad" ? m.n >= AD_HOOK : m.n >= TRIAL_DAY_REACH);

const ASK: Record<Exclude<Verdict, "zero">, (why: string) => string> = {
  hook: (why) => `Results say: ${why} Rework only the opening 2-3 seconds so people stop scrolling: open on the most beautiful,
most cinematic shot this video has (or a better best-of-roll clip from the SAME place in the kit's footage.md), make the first
line shorter so it reads in one glance, and make the first frame work with the sound off. Keep the story, every other line, the
place, the music and the drop timing exactly as they are.`,
  payoff: (why) => `Results say: ${why} Rework only the payoff so people act on it: hold the payoff shot of the place longer,
make the app moment bigger and clearer (the feature fills the frame, held 2.5-3 s), and let the end card with the call to action
hold 2.5 s. Keep the opening, the place, the music and the drop timing exactly as they are.`,
  fresh: (why) => `Results say: ${why} It worked, then dropped off, so give it a fresh start: a different first shot (the next
best-of-roll clip of the same place in the kit's footage.md) and a new first frame, so it reads as a new video. Keep the story,
every line, the music and the drop timing exactly as they are.`,
};

/** One action taken without asking: logged on the item, in the optimizer log, and in the approvals table as executed. */
async function record(s: State, it: Item, title: string, text: string, say: (t: string) => void) {
  it.history.unshift({ at: now(), text }); it.history.length = Math.min(it.history.length, 30);
  s.log.unshift({ at: now(), text: `${it.label.slice(0, 50)}: ${text}` }); s.log.length = Math.min(s.log.length, 200);
  say(`Live optimize · ${it.label.slice(0, 50)}: ${text}`);
  await getRepo().insert("approvals", [{
    id: crypto.randomUUID(), type: "optimize", ref_table: it.kind === "ad" ? "ad_campaigns" : "reel_variants", ref_id: it.kind === "ad" ? it.campaign ?? null : it.key,
    title, summary: text, preview: { bullets: [it.why ?? "", `Feature: ${it.feature}`, `Re-cuts so far: ${it.fixes} of ${MAX_FIXES()}`].filter(Boolean) },
    status: "executed", created_by_agent: BY, decided_by: `${BY} (on)`, decided_at: now(), result: { auto: true }, created_at: now(),
  }]).catch(() => null);
}

const due = (s: State, k: string, hours: number) => {
  if (hoursSince(s.touched[k]) < hours) return false;
  s.touched[k] = now();
  return true;
};
const fixesToday = (s: State) => Object.values(s.items).filter((x) => hoursSince(x.fix?.started_at) < 24).length;
/** Re-cuts the whole lineage has had (a re-cut's re-cut counts against the original). */
const lineageFixes = (s: State, root: string) => Object.values(s.items).filter((x) => x.root === root).reduce((n, x) => Math.max(n, x.fixes), 0);

function decideAd(r: Reading, bars: { hook: number; hold: number; ctr: number }, ageH: number, fixes: number, top = 0): { v: Verdict | null; why: string } {
  const imp = r.impressions ?? 0;
  const dip = lab.curveDip(r.curve);
  const line = `hook ${pct(r.hook, 0)} (bar ${pct(bars.hook, 0)}), hold ${pct(r.hold, 0)}, click-through ${pct(r.ctr, 2)} (bar ${pct(bars.ctr, 2)}), ${imp} impressions${dip ? `; the watch curve falls ${dip.drop} points going into second ${dip.second}` : ""}`;
  const hookWeak = (r.hook ?? 0) < bars.hook * 0.6, holdOk = (r.hold ?? 0) >= bars.hold * 0.9, ctrOk = (r.ctr ?? 0) >= bars.ctr * 0.9;
  const ctrWeak = (r.ctr ?? 0) < bars.ctr * 0.6;
  // a version that already had its re-cuts, with a full read of its own, still weak on both ends: that's the kill
  if (fixes >= MAX_FIXES() && imp >= AD_KILL && hookWeak && ctrWeak && !holdOk) return { v: "zero", why: `Re-cut ${fixes} times and still weak at both ends: ${line}.` };
  // Meta puts an ad set's budget on the
  // one or two ads it predicts will work, so the rest never reach a fair read. A day in with under a tenth of the top ad's
  // impressions is Meta's own verdict on the opening; alone in a campaign, low reach is just a small budget.
  if (imp < AD_HOOK && ageH >= AD_STARVED_H && top >= AD_HOOK && imp < top * 0.1)
    return { v: fixes ? "zero" : "hook", why: `Meta barely shows it: ${imp} impressions in ${Math.round(ageH)} h while the campaign's top ad has ${top}. It predicts the opening won't hold.` };
  if (imp >= AD_NOCLICK && ageH >= AD_NOCLICK_H && !(r.clicks ?? 0) && !(r.ctr ?? 0))
    return { v: fixes >= MAX_FIXES() ? "zero" : hookWeak ? "hook" : "payoff", why: `Not one click in ${imp} impressions after ${Math.round(ageH)} h: ${line}.` };
  if (imp < AD_HOOK) return { v: null, why: `Waiting for a fair read: ${imp} of ${AD_HOOK} impressions before the opening is judged.` };
  if (hookWeak) return { v: fixes >= MAX_FIXES() ? null : "hook", why: holdOk || ctrOk ? `The opening loses people, but those who stay do well: ${line}.` : `The opening loses people: ${line}.` };
  if (imp < AD_PAYOFF || (ageH < AD_PAYOFF_H && imp < AD_PAYOFF * 2)) return { v: null, why: `The opening holds; waiting for clicks to mean something (${imp} of ${AD_PAYOFF} impressions, ${Math.round(ageH)} of ${AD_PAYOFF_H} h): ${line}.` };
  if (ctrWeak) return { v: fixes >= MAX_FIXES() ? null : "payoff", why: `They stop and watch, but don't click: ${line}.` };
  if (imp >= AD_FATIGUE && r.recent_ctr != null && ctrOk && r.recent_ctr < (r.ctr ?? 0) * 0.6)
    return { v: fixes >= MAX_FIXES() ? null : "fresh", why: `It worked, then dropped off: click-through ${pct(r.ctr, 2)} overall but ${pct(r.recent_ctr, 2)} in the last 3 days.` };
  return { v: null, why: `Holding: ${line}.` };
}

// The goal is virality: if it doesn't have a chance kill it; if it could and there are strong initial signals, optimize it
// and repost the trial to hit that goal, or kill it, rather than be happy with a tiny reach. Instagram
// shows a trial reel to a test pool of ~100 non-followers and only pushes it further if it does well there, so a trial
// whose reach has gone flat below TRIAL_TARGET is never "good as is": it's re-cut (if something in it is strong) or killed.

function decideTrial(r: Reading, prev: Reading[], bars: { watch: number; act: number; skip: number }, ageH: number, fixes = 0): { v: Verdict | null; why: string } {
  const line = `${r.skip != null ? `${pct(r.skip, 0)} swiped away in the first seconds (bar ${pct(bars.skip, 0)}), ` : ""}watched ${pct(r.watch, 0)} on average (bar ${pct(bars.watch, 0)}), ${pct(r.act, 2)} saved or shared (bar ${pct(bars.act, 2)}), ${r.reach} reach`;
  if ((r.reach ?? 0) < TRIAL_FAIR && !(ageH >= TRIAL_DAY_H && (r.reach ?? 0) >= TRIAL_DAY_REACH)) return { v: null, why: `Waiting for a fair read: ${r.reach ?? 0} reach (judged at ${TRIAL_FAIR}, or at ${TRIAL_DAY_REACH} once ${TRIAL_DAY_H} h old).` };
  const reach = r.reach ?? 0;
  // the strong signals: something a re-cut can build on (clearly better than the other trials, and good in absolute terms)
  const strong = [
    r.skip != null && r.skip <= Math.min(0.6, bars.skip * 0.85) ? `the opening holds (${pct(r.skip, 0)} swipe away)` : "",
    r.watch != null && r.watch >= Math.max(0.4, bars.watch * 1.25) ? `people watch ${pct(r.watch, 0)} of it` : "",
    // saves+shares only mean something once it has reach
    reach >= lab.ACT_REACH && (r.act ?? 0) >= Math.max(0.01, bars.act * 1.4) ? `${pct(r.act, 1)} save or share it on ${reach} reach` : "",
  ].filter(Boolean);
  const hookWeak = (r.skip != null && r.skip > bars.skip * 0.85) || (r.watch != null && r.watch < bars.watch);
  // low reach is a distribution problem (the opening), not a payoff one: the payoff is only judged once it has reach
  const part: Exclude<Verdict, "zero"> = hookWeak || reach < lab.ACT_REACH ? "hook" : (r.act ?? 0) < bars.act * 1.4 ? "payoff" : "fresh";
  // reach flat for TRIAL_FLAT_H+ hours: Instagram has stopped pushing it, it won't grow on its own
  const older = prev.find((p) => hoursSince(p.at) >= TRIAL_FLAT_H);
  const flat = ageH >= TRIAL_DAY_H && !!older && reach < (older.reach ?? 0) * 1.05 + 3;
  const dead = !r.act && r.watch != null && r.watch < 0.2;
  if (!strong.length) {
    if (flat || dead) return { v: "zero", why: `No chance to go viral: nothing in it beats the other trials (${line}), and ${flat ? `its reach stopped at ${reach}` : "most leave at once"}.` };
    return { v: null, why: `Still climbing with no strong signal yet (${line}); killed if its reach stops growing.` };
  }
  if (reach >= TRIAL_TARGET) {
    if (flat && fixes < MAX_FIXES()) return { v: "fresh", why: `It got to ${reach} reach (${strong.join(", ")}) and stopped growing: a fresh cut reposted restarts the push.` };
    return { v: null, why: `Past ${TRIAL_TARGET} reach: ${line}.` };
  }
  if (!flat) return { v: null, why: `Still climbing, and ${strong.join(" and ")} (${line}). Re-cut if its reach stops short of ${TRIAL_TARGET}.` };
  if (fixes >= MAX_FIXES()) return { v: "zero", why: `Re-cut ${fixes} times and still stuck at ${reach} reach (goal ${TRIAL_TARGET}): ${line}.` };
  const weak = part === "hook" ? "the opening loses people" : part === "payoff" ? "too few save or share it" : "it stalled";
  return { v: part, why: `Stuck at ${reach} reach (goal ${TRIAL_TARGET}), but ${strong.join(" and ")}; ${weak}: ${line}.` };
}

function track(s: State, key: string, kind: Item["kind"], v: ReelVariant | undefined, label: string, campaign?: string): Item {
  const ex = s.items[key];
  if (ex) return ex;
  const root = v?.tags?.revision_of?.replace("/", "|") || key.replace("/", "|");
  const it: Item = { key, kind, label, feature: v ? featureOf(v) : featureOf({ hook: label }), root, campaign, first_seen: now(), status: "watching",
    fixes: lineageFixes(s, root), readings: [], history: [] };
  s.items[key] = it;
  return it;
}

/** Start a re-cut; false when it can't (folder gone, cap reached). */
async function startFix(s: State, it: Item, v: ReelVariant, verdict: Exclude<Verdict, "zero">, why: string, say: (t: string) => void, peers = ""): Promise<boolean> {
  if (fixesToday(s) >= FIXES_PER_DAY()) { it.next = `Needs a ${verdict} re-cut; today's ${FIXES_PER_DAY()} re-cuts are used, so it waits for tomorrow.`; return false; }
  // the founder's suggestion from Command → Live rides along with every re-cut
  const note = v.tags?.founder_note ? ` The founder also asked: "${String(v.tags.founder_note).slice(0, 300)}"` : "";
  // the lab writes the change as a test: one hypothesis from the watch curve / skip rate, the peers and the rules learned so far
  const before = metricsOf(it) ?? { n: 0 };
  const variable = verdict === "payoff" ? "payoff" : verdict === "fresh" ? "fresh opening" : "opening";
  const h = await lab.hypothesize({ kind: it.kind, label: it.label, variable, why, before, v, peers, house: ASK[verdict]("").replace(/^Results say:\s*/, "").replace(/\s+/g, " ") }).catch(() => null);
  // no re-cut without evidence: only what the lab has actually learned justifies changing a live video
  if (!h || "skip" in h) {
    it.next = h ? `No re-cut: ${h.skip}` : "No re-cut yet: the lab couldn't write an evidence-backed change; it tries again next check.";
    return false;
  }
  const keep = verdict === "payoff" ? "Keep the opening, the place, the music and the drop timing exactly as they are." : "Keep the story, every other line, the place, the music and the drop timing exactly as they are.";
  const ask = (`Results say: ${why} What we've learned: ${h.evidence} Test this: ${h.hypothesis} Make this change: ${h.change} ${keep}` + note).slice(0, 1600);
  try {
    await startBragTweak(v.job_id, v.id, ask, false, { feature: it.feature, opt_fix: verdict });
  } catch (e) {
    it.next = `Couldn't re-cut it: ${(e as Error).message}`;
    return false;
  }
  it.status = "fixing"; it.fixes++; it.why = why;
  it.fix = { verdict, why, started_at: now(), ask };
  lab.opened({ kind: it.kind, parent: it.key, label: it.label, variable, hypothesis: h.hypothesis, change: h.change, evidence: h.evidence, before });
  for (const x of Object.values(s.items)) if (x.root === it.root) x.fixes = Math.max(x.fixes, it.fixes);
  await record(s, it, `Re-cutting the ${verdict === "payoff" ? "payoff" : "opening"} of "${it.label.slice(0, 50)}"`,
    `${why} Re-cutting the ${verdict === "hook" ? "opening" : verdict === "payoff" ? "payoff" : "opening (fresh start)"} (${it.fixes} of ${MAX_FIXES()}); it goes back out as soon as it's rendered.`, say);
  return true;
}

/** The re-cut a fixing item is waiting for, once rendered. */
async function recut(it: Item, variants: ReelVariant[]): Promise<ReelVariant | "failed" | null> {
  const [job, id] = it.key.split(/[|/]/);
  const t = bragTweak(job, id);
  if (t?.status === "done" && t.job_id) return variants.find((x) => x.job_id === t.job_id && x.file) ?? null;
  if (t?.status === "error") return "failed";
  const made = variants.find((x) => x.file && x.tags?.opt_fix === it.fix?.verdict && x.tags?.revision_ask && it.fix?.ask && x.tags.revision_ask.startsWith(it.fix.ask.slice(0, 120)));
  if (made) return made;
  return !t && hoursSince(it.fix?.started_at) > 3 ? "failed" : null;
}

/** A re-cut ad is rendered: pause the old ad and build the new one into the same ad set (every pass, not on the 2-h read). */
async function swapAdRecuts(s: State, say: (t: string) => void) {
  const repo = getRepo();
  for (const it of Object.values(s.items).filter((x) => x.kind === "ad" && x.status === "fixing" && x.campaign)) {
    const nv = await recut(it, await repo.list("reel_variants"));
    if (nv === "failed") { it.status = "watching"; it.next = "The re-cut didn't come back; it keeps running as it is."; lab.failed(it.key); continue; }
    if (!nv) continue;
    if (!it.pending) await propose(s, it, "swap", nv, say);
  }
}

/** What a re-cut changed, in one line (its run's change note, else the ask). */
const changeOf = (nv: ReelVariant | null, it: Item) => (nv?.tags?.revision_summary || it.fix?.ask || "").replace(/\s+/g, " ").slice(0, 400);

/**
 * Any change the system wants to make, it makes, then asks the owner to approve it before pushing it out.
 * The re-cut is already rendered (or the pause already decided). This puts it in Decide and on Command → Live with what it
 * did and why; nothing reaches Meta or Instagram until he approves (applyPending) or turns it down (rejectPending).
 */
async function propose(s: State, it: Item, kind: "swap" | "kill", nv: ReelVariant | null, say: (t: string) => void, killWhy?: string) {
  const what = kind === "kill" ? `Pause the ad "${it.label.slice(0, 60)}": its share of the ad set goes to the others.`
    : `${it.kind === "ad" ? "Swap in" : "Post as a new trial reel"} the re-cut: ${changeOf(nv, it) || "a new cut"}`;
  const why = kind === "kill" ? killWhy ?? it.why ?? "" : it.fix?.why ?? it.why ?? "";
  const test = kind === "swap" ? /Test this: (.*?) Make this change:/.exec(it.fix?.ask ?? "")?.[1]?.slice(0, 300) : undefined;
  const id = crypto.randomUUID();
  const title = kind === "kill" ? `Pause the ad "${it.label.slice(0, 50)}"` : `${it.kind === "ad" ? "Swap in" : "Repost"} the re-cut of "${it.label.slice(0, 50)}"`;
  await getRepo().insert("approvals", [{
    id, type: "optimize", ref_table: it.kind === "ad" ? "ad_campaigns" : "reel_variants", ref_id: it.kind === "ad" ? it.campaign ?? null : it.key, title, summary: what,
    preview: { bullets: [`Why: ${why}`, test ? `Testing: ${test}` : "", nv ? `New cut: ${nv.job_id}/${nv.id}` : "", `Re-cuts so far: ${it.fixes} of ${MAX_FIXES()}`].filter(Boolean),
      action: { kind: "opt_apply", key: it.key } },
    status: "pending", created_by_agent: BY, decided_by: null, decided_at: null, result: null, created_at: now(),
  }]).catch(() => null);
  it.pending = { kind, job_id: nv?.job_id, variant_id: nv?.id, approval_id: id, at: now(), what, why, test };
  it.status = "review";
  it.next = "Waiting for your OK in Command → Live (or Decide).";
  it.history.unshift({ at: now(), text: `${kind === "kill" ? "Wants to pause it" : "Re-cut ready"}: ${what} Waiting for your OK.` });
  s.log.unshift({ at: now(), text: `${it.label.slice(0, 50)}: ${title}, waiting for your OK.` });
  say(`Live optimize · ${title}: waiting for your OK.`);
}

const findItem = (s: State, key: string) => s.items[key] ?? Object.values(s.items).find((x) => x.key.replace("/", "|") === key.replace("/", "|"));

/** The founder approved: push the change out (swap the ad, repost the trial, or pause the ad). */
export async function applyPending(key: string): Promise<string> {
  const s = read();
  const it = findItem(s, key);
  if (!it?.pending) throw new Error("Nothing is waiting on this video any more.");
  const repo = getRepo();
  const p = it.pending;
  let detail = "";
  if (p.kind === "kill") {
    const [c] = await repo.list("ad_campaigns", { eq: { id: it.campaign ?? "" } });
    const ad = c?.meta.ads?.[it.key];
    const m = metaAds();
    if (!c || !ad?.ad_id || !m) throw new Error("That ad isn't in its campaign any more.");
    await m.setCampaignStatus(ad.ad_id, "PAUSED");
    const ids = { ...(c.meta.ads ?? {}) };
    ids[it.key] = { ...ids[it.key], paused_at: now(), killed: p.why.slice(0, 200) };
    await repo.update("ad_campaigns", { id: c.id }, { meta: { ...c.meta, ads: ids }, updated_at: now() });
    it.status = "killed";
    detail = "Paused; its share of the ad set goes to the others.";
  } else {
    const [nv] = await repo.list("reel_variants", { eq: { job_id: p.job_id ?? "", id: p.variant_id ?? "" } });
    if (!nv?.file) throw new Error("The re-cut's file is gone.");
    if (it.kind === "ad") {
      const { runRotation } = await import("./ad-rotation");
      await runRotation({ ad_campaign_id: it.campaign!, pause: [it.key], add: [{ key: `${nv.job_id}|${nv.id}`, job_id: nv.job_id, variant_id: nv.id, file: nv.file, poster: nv.poster, label: (nv.hook || nv.id).slice(0, 140) }] });
      detail = "Paused the old ad and put the re-cut in the same ad set, same budget.";
    } else {
      const { dailyTrials, trialsLastDay } = await import("./daily-reels");
      if ((await trialsLastDay()) >= dailyTrials()) throw new Error(`Today's ${dailyTrials()} trial reels are used; approve it again once the day rolls over.`);
      const { launchVideo } = await import("./launch");
      const [job, id] = it.key.split(/[|/]/);
      const [old] = await repo.list("reel_variants", { eq: { job_id: job, id } });
      await launchVideo({ job_id: nv.job_id, variant_id: nv.id, dest: "trial", caption: nv.caption ?? old?.caption ?? "" }, BY);
      detail = "Posted the re-cut as a new trial reel; the old one is left to die off.";
    }
    it.status = "replaced";
    const ni = track(s, `${nv.job_id}${it.kind === "ad" ? "|" : "/"}${nv.id}`, it.kind, nv, (nv.hook || nv.id).slice(0, 140), it.campaign);
    ni.root = it.root; ni.fixes = it.fixes; ni.feature = it.feature;
    lab.linked(it.key, ni.key);
  }
  it.pending = undefined; it.next = undefined;
  await record(s, it, p.kind === "kill" ? `Paused the ad "${it.label.slice(0, 50)}"` : `Pushed out the re-cut of "${it.label.slice(0, 50)}"`, `You approved it. ${detail}`, () => {});
  write(s);
  return detail;
}

/** The founder turned it down: nothing goes out, and the video keeps running as it is. */
export async function rejectPending(key: string): Promise<void> {
  const s = read();
  const it = findItem(s, key);
  if (!it?.pending) return;
  const k = it.pending.kind;
  it.pending = undefined; it.status = "watching";
  it.next = k === "kill" ? "You kept it running." : "You turned the re-cut down; it keeps running as it is.";
  if (k === "swap") lab.failed(it.key);
  it.history.unshift({ at: now(), text: it.next });
  write(s);
}

// ---------------------------------------------------------------- retire old versions

/**
 * "Remove the old version when you add new ads or trial reels, so we can test if they are improving on their own; we don't
 * want them competing." Runs every tick, optimize on or off: launching the new version was his approval.
 * One lineage = re-cuts of one original (Item.root), or the same video made again (same opening line, same kind).
 * The newest version that's out stays; every older one is retired:
 *   ads    → paused in Meta (its ad set's budget goes to what's left running);
 *   trials → stop being judged, and go on Command → Live's "Delete in Instagram" list (Instagram doesn't let apps delete
 *            reels; one tap there and one in the app, then he marks it gone).
 * A/B partners are a test of each other, so they.re left alone. Ads are ordered by when they were made (rotations
 * re-stamp live times); trial reels by when they posted.
 * The newest one out always wins.
 */
// version order: when the video was made (imp-YYYYMMDDHHMMSS), else when the optimizer first saw it
const madeAt = (x: Item) => /(\d{14})/.exec(x.key)?.[1] ?? x.first_seen.replace(/\D/g, "").slice(0, 14);
const lineOf = (x: Item) => x.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function joinLineages(s: State) {
  // the same video made again opens on the same line: one lineage, the first one's root (also fixes the v1/v2/v3 marks)
  const first = new Map<string, Item>();
  for (const x of Object.values(s.items).sort((a, b) => a.first_seen.localeCompare(b.first_seen))) {
    const k = `${x.kind}|${lineOf(x)}`;
    if (lineOf(x).length <= 8) continue;
    const f = first.get(k);
    if (!f) { first.set(k, x); continue; }
    if (x.root !== f.root) { const old = x.root; for (const y of Object.values(s.items)) if (y.root === old) y.root = f.root; }
  }
}

async function dropPending(it: Item, why: string) {
  if (!it.pending) return;
  await getRepo().update("approvals", { id: it.pending.approval_id }, { status: "rejected", decided_by: BY, decided_at: now(), result: { detail: why } }).catch(() => null);
  it.pending = undefined;
}

export async function retirePass(s: State, say: (t: string) => void) {
  joinLineages(s);
  const repo = getRepo();
  const variants = await repo.list("reel_variants");
  const vOf = (key: string) => { const [j, id] = key.split(/[|/]/); return variants.find((v) => v.job_id === j && v.id === id); };
  const partners = (a: Item, b: Item) => {
    const [va, vb] = [vOf(a.key), vOf(b.key)];
    const ka = `${va?.job_id}/${va?.id}`, kb = `${vb?.job_id}/${vb?.id}`;
    const pa = va?.tags?.partner_of, pb = vb?.tags?.partner_of;
    return !!((pa && (pa === kb || pa === vb?.id || pa === pb)) || (pb && (pb === ka || pb === va?.id)));
  };
  const camps = (await repo.list("ad_campaigns")).filter((c) => ["live", "ready"].includes(c.status));
  // version order = when it went out (trial: posted; ad: went live), else when it was made. Same order the founder sees on Instagram.
  const posts = await repo.list("reel_posts");
  const digits = (iso?: string | null) => (iso ? iso.replace(/\D/g, "").slice(0, 14) : null);
  const outAt = (x: Item) => {
    const v = vOf(x.key);
    // ads: when it was made (live_at is re-stamped for every ad in an ad set on each rotation, so it can't order versions)
    if (x.kind === "ad") return madeAt(x);
    return digits(posts.find((p) => p.job_id === v?.job_id && p.variant_id === v?.id)?.posted_at) ?? madeAt(x);
  };
  const running = (it: Item) => {
    const c = camps.find((x) => x.id === it.campaign);
    const a = c?.meta.ads?.[it.key];
    return !!(a?.ad_id && !a.paused_at && !a.bench);
  };
  const m = metaAds();
  // the same video running as an ad in two places competes with itself: keep the copy where it runs most on its own (fewest
  // other running ads, then the first one live) and pause the rest
  if (m) {
    const runningIn = (c: AdCampaign) => creativesOf(c).filter((x) => { const a = c.meta.ads?.[x.key]; return a?.ad_id && !a.paused_at && !a.bench; });
    const where = new Map<string, AdCampaign[]>();
    for (const c of camps) for (const x of runningIn(c)) where.set(x.key, [...(where.get(x.key) ?? []), c]);
    for (const [key, cs] of where) {
      if (cs.length < 2) continue;
      const ranked = [...cs].sort((a, b) => runningIn(a).length - runningIn(b).length || String(a.meta.ads?.[key]?.live_at ?? "").localeCompare(String(b.meta.ads?.[key]?.live_at ?? "")));
      const keep = ranked[0];
      for (const c of ranked.slice(1)) {
        const ad = c.meta.ads![key];
        try { await m.setCampaignStatus(ad.ad_id!, "PAUSED"); } catch (e) { say(`Couldn't pause the second copy of "${key}": ${(e as Error).message}`); continue; }
        const ids = { ...(c.meta.ads ?? {}) };
        ids[key] = { ...ids[key], paused_at: now(), killed: `Same video already runs in "${keep.title}"` };
        c.meta = { ...c.meta, ads: ids };
        await repo.update("ad_campaigns", { id: c.id }, { meta: c.meta, updated_at: now() });
        const it = s.items[key];
        if (it) { it.campaign = keep.id; it.history.unshift({ at: now(), text: `Paused its copy in "${c.title}": the same video runs in "${keep.title}", and two copies compete.` }); }
        s.log.unshift({ at: now(), text: `Paused a second copy of an ad in "${c.title}" (it runs in "${keep.title}").` });
        say(`Live · Paused the second copy of an ad in "${c.title}": the same video runs in "${keep.title}".`);
      }
    }
  }
  const groups = new Map<string, Item[]>();
  for (const x of Object.values(s.items)) groups.set(`${x.kind}|${x.root}`, [...(groups.get(`${x.kind}|${x.root}`) ?? []), x]);
  for (const line of groups.values()) {
    const out = line.filter((x) => (x.kind === "ad" ? running(x) : !x.retire?.done)).sort((a, b) => outAt(a).localeCompare(outAt(b)));
    // the newest one out is the version being tested, even once judged dead (picking by status flip-flops as verdicts change)
    const newest = out[out.length - 1];
    if (!newest) continue;
    // put on the delete list by mistake (it's the newest after all) and not deleted yet: back in play
    if (newest.retire && !newest.retire.done) { newest.retire = undefined; newest.status = "watching"; newest.next = undefined; newest.history.unshift({ at: now(), text: "Back in play: it's the newest version out." }); }
    if (out.length < 2) continue;
    const n = line.sort((a, b) => outAt(a).localeCompare(outAt(b))).indexOf(newest) + 1;
    for (const old of out.filter((x) => x !== newest && outAt(x) <= outAt(newest) && !x.retire)) {
      // an A/B partner is a test of the other, not an older version (same-day live stamps prove nothing: rotations re-stamp them all)
      if (partners(old, newest)) continue;
      const why = `v${n} is out, so this older version stops competing with it.`;
      if (old.kind === "ad") {
        const c = camps.find((x) => x.id === old.campaign)!;
        const ad = c.meta.ads![old.key];
        if (!m) continue;
        try { await m.setCampaignStatus(ad.ad_id!, "PAUSED"); } catch (e) { say(`Couldn't pause the old ad "${old.label.slice(0, 40)}": ${(e as Error).message}`); continue; }
        const ids = { ...(c.meta.ads ?? {}) };
        ids[old.key] = { ...ids[old.key], paused_at: now(), killed: `Replaced by v${n}` };
        c.meta = { ...c.meta, ads: ids };
        await repo.update("ad_campaigns", { id: c.id }, { meta: c.meta, updated_at: now() });
        old.retire = { at: now(), by: newest.key, done: true };
      } else {
        const v = vOf(old.key);
        old.retire = { at: now(), by: newest.key, done: false, permalink: v?.tags?.permalink ?? null };
      }
      await dropPending(old, `Superseded: v${n} went out.`);
      old.status = "replaced";
      old.next = old.kind === "ad" ? `Paused: ${why}` : `Delete it in Instagram: ${why}`;
      old.history.unshift({ at: now(), text: old.kind === "ad" ? `Paused automatically: ${why}` : `Retired: ${why} On the "Delete in Instagram" list.` });
      s.log.unshift({ at: now(), text: `${old.label.slice(0, 50)}: ${old.kind === "ad" ? "old ad paused" : "old trial reel retired"} (v${n} is out).` });
      say(`Live · ${old.kind === "ad" ? "Paused the old ad" : "Retired the old trial reel"} "${old.label.slice(0, 50)}": v${n} is out${old.kind === "trial" ? ". The desk deletes it from Instagram shortly." : "."}`);
    }
  }
  // retired trial reels are deleted from Instagram by the desk itself (Meta's IG Media delete endpoint), not
  // left for the founder to do by hand. A short grace period first: every tick re-checks the newest version and un-retires
  // a mistake before anything irreversible happens. The video file and its numbers stay on the desk.
  if (!m) return;
  const GRACE_MS = 30 * 60_000, RETRY_MS = 3600_000;
  for (const it of Object.values(s.items)) {
    const r = it.retire;
    if (it.kind !== "trial" || !r || r.done) continue;
    if (Date.now() - Date.parse(r.at) < GRACE_MS) continue;
    if (r.tried && Date.now() - Date.parse(r.tried) < RETRY_MS) continue;
    const v = vOf(it.key);
    const id = v?.tags?.ig_media_id ? String(v.tags.ig_media_id) : null;
    r.tried = now();
    if (!id) { r.error = "No Instagram id on the desk: delete it by hand."; continue; }
    try {
      await m.deleteMedia(id);
    } catch (e) {
      const msg = (e as Error).message;
      // already gone (deleted by hand): done
      if (/does not exist/i.test(msg) && !/permission/i.test(msg)) { r.done = true; r.deleted_by = "founder"; continue; }
      r.error = msg.slice(0, 200);
      say(`Live · Couldn't delete the old trial reel "${it.label.slice(0, 40)}" from Instagram: ${r.error}`);
      continue;
    }
    r.done = true; r.deleted_by = "desk"; r.error = undefined;
    if (v) await repo.update("reel_variants", { id: v.id, job_id: v.job_id }, { tags: { ...v.tags, launch_status: "deleted", deleted_at: now() } }).catch(() => {});
    it.history.unshift({ at: now(), text: "Deleted from Instagram: an older version, replaced by the newest one." });
    s.log.unshift({ at: now(), text: `${it.label.slice(0, 50)}: old trial reel deleted from Instagram.` });
    say(`Live · Deleted the old trial reel "${it.label.slice(0, 50)}" from Instagram.`);
  }
}

/** The founder deleted a retired trial reel in Instagram: it leaves Live. */
export function markDeleted(key: string): string {
  const s = read();
  const it = findItem(s, key);
  if (!it?.retire) throw new Error("That reel isn't on the delete list.");
  it.retire.done = true;
  it.history.unshift({ at: now(), text: "You deleted it in Instagram." });
  write(s);
  return "Marked deleted.";
}

// ---------------------------------------------------------------- ads

async function adsPass(s: State, say: (t: string) => void) {
  const m = metaAds();
  if (!m) return;
  const repo = getRepo();
  await swapAdRecuts(s, say);
  const variants = await repo.list("reel_variants");
  for (const c of (await repo.list("ad_campaigns")).filter((x) => ["live", "ready"].includes(x.status) && x.meta.campaign_id)) {
    if (!due(s, `ad:${c.id}`, AD_READ_H)) continue;
    // running ads only: not paused, not waiting on the bench for their wave (lib/waves.ts)
    const ads = creativesOf(c).filter((x) => x.job_id && c.meta.ads?.[x.key]?.ad_id && !c.meta.ads?.[x.key]?.paused_at && !c.meta.ads?.[x.key]?.bench);
    const rows: { it: Item; v?: ReelVariant; r: Reading; ad_id: string }[] = [];
    for (const x of ads) {
      const ad_id = c.meta.ads![x.key].ad_id!;
      const life = await m.adResults(ad_id).catch(() => null);
      if (!life) continue;
      const recent = life.impressions >= AD_FATIGUE ? await m.adResults(ad_id, "last_3d").catch(() => null) : null;
      const v = variants.find((y) => y.job_id === x.job_id && y.id === x.variant_id);
      const it = track(s, x.key, "ad", v, x.label ?? x.key, c.id);
      const r: Reading = { at: now(), impressions: life.impressions, clicks: life.clicks, spend: life.spend, installs: life.installs,
        hook: life.videoViews / Math.max(1, life.impressions), hold: life.videoViews ? life.p50 / life.videoViews : 0, ctr: life.clicks / Math.max(1, life.impressions),
        recent_ctr: recent && recent.impressions >= 800 ? recent.clicks / recent.impressions : null, curve: life.curve?.length ? life.curve : undefined };
      it.last = r; it.readings = [r, ...it.readings].slice(0, 24);
      rows.push({ it, v, r, ad_id });
    }
    const fair = rows.filter((x) => (x.r.impressions ?? 0) >= AD_HOOK);
    const peers = fair.length >= 3;
    const bars = { hook: (peers && median(fair.map((x) => x.r.hook!))) || 0.25, hold: (peers && median(fair.map((x) => x.r.hold!))) || 0.25, ctr: (peers && median(fair.map((x) => x.r.ctr!))) || 0.008 };
    for (const row of rows) {
      const { it, v, r } = row;
      if (it.status !== "watching") continue;
      // live_at is re-stamped when an ad set is rotated; the first time the optimizer saw the ad is its real age
      const ageH = Math.max(hoursSince(c.meta.ads?.[it.key]?.live_at ?? c.meta.built_at), hoursSince(it.first_seen));
      const top = Math.max(0, ...rows.map((x) => x.r.impressions ?? 0));
      const d = decideAd(r, bars, ageH, lineageFixes(s, it.root), top);
      it.why = d.why; it.next = undefined;
      if (!d.v) continue;
      const kill = d.v === "zero";
      if (!kill && !v) { it.next = "Can't be re-cut (not a desk video): left running."; continue; }
      if (kill) {
        // keep at least one ad running in the campaign
        const active = creativesOf(c).filter((x) => c.meta.ads?.[x.key]?.ad_id && !c.meta.ads?.[x.key]?.paused_at && !c.meta.ads?.[x.key]?.bench);
        const benched = creativesOf(c).some((x) => c.meta.ads?.[x.key]?.bench && !c.meta.ads?.[x.key]?.paused_at);
        if (active.length <= 1 && !benched) { it.next = "Would be killed, but it's the campaign's last running ad."; continue; }
        await propose(s, it, "kill", null, say, d.why);
        continue;
      }
      await startFix(s, it, v!, d.v as Exclude<Verdict, "zero">, d.why, say, peerLine(rows.map((x) => x.it)));
    }
    // waves: move proven ads to Winners, switch on the next ads where a kill freed a slot, re-split the budget
    if (c.meta.waves) {
      const reads = new Map<string, AdRead>(rows.filter((x) => x.it.status === "watching").map((x) => [x.it.key,
        { impressions: x.r.impressions ?? 0, clicks: x.r.clicks ?? 0, hook: x.r.hook ?? 0, ctr: x.r.ctr ?? 0, spend: x.r.spend ?? 0 }]));
      await wavesPass(c.id, reads, (title, text) => note(s, c, title, text, say)).catch((e) => say(`Waves for "${c.title}": ${(e as Error).message}`));
    }
    write(s);
  }
}

/** A launch-level action (waves), logged like the per-video ones. */
async function note(s: State, c: AdCampaign, title: string, text: string, say: (t: string) => void) {
  s.log.unshift({ at: now(), text }); s.log.length = Math.min(s.log.length, 200);
  say(`Live optimize · ${text}`);
  await getRepo().insert("approvals", [{
    id: crypto.randomUUID(), type: "optimize", ref_table: "ad_campaigns", ref_id: c.id, title, summary: text, preview: { bullets: [] },
    status: "executed", created_by_agent: BY, decided_by: `${BY} (on)`, decided_at: now(), result: { auto: true, waves: true }, created_at: now(),
  }]).catch(() => null);
}

// ---------------------------------------------------------------- trial reels

async function trialsPass(s: State, say: (t: string) => void) {
  const m = metaAds();
  if (!m) return;
  const repo = getRepo();
  const variants = await repo.list("reel_variants");
  const posts = await repo.list("reel_posts");
  const live = variants.filter((v) => v.tags?.launched === "trial" && v.tags?.launch_status === "live" && v.tags?.ig_media_id);
  const postedAt = (v: ReelVariant) => posts.find((p) => p.job_id === v.job_id && p.variant_id === v.id)?.posted_at ?? null;
  // fixing trials first: post the re-cut the moment it's rendered
  for (const it of Object.values(s.items).filter((x) => x.kind === "trial" && x.status === "fixing")) {
    const nv = await recut(it, variants);
    if (nv === "failed") { it.status = "watching"; it.next = "The re-cut didn't come back."; lab.failed(it.key); continue; }
    if (!nv) continue;
    if (!it.pending) await propose(s, it, "swap", nv, say); // made, shown to the owner, posted only on their OK
  }
  const readings: { it: Item; v: ReelVariant; r: Reading; ageH: number }[] = [];
  for (const v of live) {
    const key = `${v.job_id}/${v.id}`;
    const it = track(s, key, "trial", v, (v.hook || v.id).slice(0, 140));
    const ageH = hoursSince(postedAt(v));
    if (it.status === "watching" && ageH >= TRIAL_FIRST_H && due(s, `trial:${key}`, 2)) {
      const r = await m.reelResults(v.tags.ig_media_id).catch(() => null);
      if (r) {
        const secs = lengthOf(v);
        const reading: Reading = { at: now(), reach: r.reach, watch: r.avgWatchMs != null && secs ? r.avgWatchMs / 1000 / secs : null, act: r.reach ? (r.saves + r.shares) / r.reach : 0,
          skip: r.skipRate != null && r.reach ? r.skipRate / 100 : null, likes: r.likes };
        it.last = reading; it.readings = [reading, ...it.readings].slice(0, 24);
      }
    }
    if (it.last) readings.push({ it, v, r: it.last, ageH });
  }
  const fair = readings.filter((x) => (x.r.reach ?? 0) >= TRIAL_FAIR || (x.ageH >= TRIAL_DAY_H && (x.r.reach ?? 0) >= TRIAL_DAY_REACH));
  const peers = fair.length >= 3;
  const bars = { watch: (peers && median(fair.map((x) => x.r.watch).filter((x): x is number => x != null))) || 0.35, act: (fair.filter((x) => (x.r.reach ?? 0) >= lab.ACT_REACH).length >= 3 && median(fair.filter((x) => (x.r.reach ?? 0) >= lab.ACT_REACH).map((x) => x.r.act ?? 0))) || 0.01,
    skip: (peers && median(fair.map((x) => x.r.skip).filter((x): x is number => x != null))) || 0.7 };
  for (const { it, v, r, ageH } of readings) {
    if (it.status !== "watching" || hoursSince(r.at) > 0.5) continue; // act only on a fresh reading
    const d = decideTrial(r, it.readings.slice(1), bars, ageH, lineageFixes(s, it.root));
    it.why = d.why; it.next = undefined;
    if (!d.v) continue;
    if (d.v !== "zero" && lineageFixes(s, it.root) >= MAX_FIXES()) { it.next = `Would get another re-cut, but it has had ${MAX_FIXES()}; left running.`; continue; }
    if (d.v === "zero") {
      it.status = "killed";
      const [cur] = await repo.list("reel_variants", { eq: { job_id: v.job_id, id: v.id } });
      await repo.update("reel_variants", { job_id: v.job_id, id: v.id }, { tags: { ...(cur?.tags ?? v.tags), opt_killed: d.why.slice(0, 200), ap_verdict: "killed" } });
      await record(s, it, `Killed the trial reel "${it.label.slice(0, 50)}"`, `${d.why} No more re-cuts; Instagram's API can't delete a trial reel, so it's left off the grid to die off.`, say);
      continue;
    }
    await startFix(s, it, v, d.v as Exclude<Verdict, "zero">, d.why, say, peerLine(readings.map((x) => x.it)));
  }
  write(s);
}

/** The peers in one line, for the hypothesis. */
function peerLine(items: Item[]) {
  return items.filter((x) => x.last).slice(0, 10).map((x) => {
    const r = x.last!;
    return x.kind === "ad" ? `"${x.label.slice(0, 40)}" hook ${pct(r.hook, 0)} ctr ${pct(r.ctr, 2)}` : `"${x.label.slice(0, 40)}" skip ${pct(r.skip, 0)} watch ${pct(r.watch, 0)} saves+shares ${pct(r.act, 2)}`;
  }).join("; ");
}

/** Score the lab's tests and refresh what-works.md (after a verdict, or daily). */
/** Rewrite the playbook now (the Lab card's button). */
export async function refreshLab() { const s = read(); const { forceLab } = await import("./lab"); forceLab(); await labPass(s); }

async function labPass(s: State) {
  lab.score((k) => (s.items[k] ? metricsOf(s.items[k]) : null), fairRead);
  const repo = getRepo();
  const variants = await repo.list("reel_variants");
  const posts = await repo.list("reel_posts");
  const rows: lab.Row[] = [];
  for (const it of Object.values(s.items)) {
    const m = metricsOf(it);
    if (!m || it.status === "replaced") continue;
    const [job, id] = it.key.split(/[|/]/);
    const v = variants.find((x) => x.job_id === job && x.id === id);
    const at = posts.find((p) => p.job_id === job && p.variant_id === id)?.posted_at;
    rows.push({ key: it.key, kind: it.kind, label: it.label, feature: it.feature, sound: v?.tags?.sound ?? "unknown", secs: v ? lengthOf(v) : null,
      by: v?.tags?.brag ? "desk" : "founder's own", hour: at ? new Date(Date.parse(at) + tzOffsetMs()).getUTCHours() : null, m });
  }
  const { igAccount, igPosts } = await import("./meta-insights");
  const [acct, ig] = await Promise.all([igAccount().catch(() => null), igPosts(30).catch(() => null)]);
  const recent = variants.filter((v) => v.file).sort((a, b) => b.job_id.localeCompare(a.job_id)).slice(0, 12);
  await lab.distill(rows, (ig ?? []).map((p) => ({ kind: p.kind, reach: p.reach, likes: p.likes, saves: p.saves, shares: p.shares })), acct?.followers_count ?? null, recent);
}

/** One pass, from the autopilot. Does nothing while the toggle is off. */
export async function tickOptimize(say: (t: string) => void = () => {}): Promise<void> {
  const s = read();
  try {
    await retirePass(s, say).catch((e) => say(`Retiring old versions: ${(e as Error).message}`));
    if (!s.on) return;
    await adsPass(s, say);
    await trialsPass(s, say);
    await labPass(s).catch((e) => say(`Lab: ${(e as Error).message}`));
  } finally {
    const cur = read();
    s.on = cur.on; // a toggle flipped during the pass wins
    write(s);
  }
}
