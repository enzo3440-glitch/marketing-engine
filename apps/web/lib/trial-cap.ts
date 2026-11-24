import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getRepo } from "@engine/db";
import { hstToday } from "./utils";

/**
 * How many trial reels a day.
 *
 * Instagram doesn't publish its trial-reel limit (5-25 a day by account, reported), so the desk finds it:
 *  - it starts at START a day. Each Honolulu day after one where the cap was used up with no refusal, it goes up STEP.
 *  - every trial reel goes out one at a time through postTrial, so the moment Instagram refuses one for a limit, nothing
 *    else is sent: the ceiling is what got through in the last 24 h, and the cap stays there.
 *  - RETEST_DAYS after a refusal it tries one more a day, in case the account's limit went up.
 *  - refused with almost nothing out (an account-level block, not a daily cap): trial reels stop for a day, then one is tried.
 * DESK_DAILY_TRIALS fixes the cap and turns the ramp off. Instagram's API allows 100 posts a day in all, so that's the top.
 */

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const FILE = path.join(DATA, "ads", "_trialcap.json");
const knob = (name: string, d: number) => { const n = Number(process.env[name]); return process.env[name] && Number.isFinite(n) && n >= 0 ? n : d; };
const START = 10, MAX = 100;
const STEP = () => Math.max(1, Math.round(knob("DESK_TRIAL_RAMP", 3)));
const RETEST_DAYS = () => knob("DESK_TRIAL_RETEST_DAYS", 14);
const fixed = () => { const n = Number(process.env.DESK_DAILY_TRIALS); return process.env.DESK_DAILY_TRIALS && Number.isFinite(n) && n > 0 ? Math.min(MAX, Math.round(n)) : null; };
const now = () => new Date().toISOString();
const DAY = 86400_000;

export interface CapDay { date: string; cap: number; posted: number; refused?: boolean }
interface CapState {
  date: string; cap: number; ceiling: number | null;
  hit: { at: string; posted: number; error: string } | null; // the last limit refusal
  blocked_until: string | null; filled: string | null; // the day the cap was last used up
  posts: string[]; // successful trial posts through postTrial (any path), for the rolling 24 h count
  days: Record<string, CapDay>; log: { at: string; text: string }[];
}

const blank = (): CapState => ({ date: hstToday(), cap: START, ceiling: null, hit: null, blocked_until: null, filled: null, posts: [], days: {}, log: [] });
function load(): CapState { try { return { ...blank(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return blank(); } }
function save(s: CapState) {
  s.posts = s.posts.filter((t) => Date.now() - Date.parse(t) < 2 * DAY);
  s.log = s.log.slice(0, 60);
  const keep = Object.keys(s.days).sort().slice(-30);
  s.days = Object.fromEntries(keep.map((k) => [k, s.days[k]]));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}
const days = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

/** A new Honolulu day: ramp up if yesterday's cap was used up and nothing was refused, or re-test an old ceiling. */
function roll(s: CapState): boolean {
  const today = hstToday();
  if (s.date === today) return false;
  const was = s.date;
  s.date = today;
  if (fixed()) return true;
  const sinceHit = s.hit ? days(s.hit.at.slice(0, 10), today) : Infinity;
  if (s.blocked_until) return true;
  if (s.hit && sinceHit < RETEST_DAYS()) return true; // holding at the ceiling Instagram showed us
  if (s.hit && sinceHit >= RETEST_DAYS() && s.filled === was) {
    s.cap = Math.min(MAX, s.cap + 1);
    s.log.unshift({ at: now(), text: `Re-testing: ${s.cap} a day (one over the ceiling found ${sinceHit} days ago).` });
  } else if (!s.hit && s.filled === was) {
    const from = s.cap;
    s.cap = Math.min(MAX, s.cap + STEP());
    if (s.cap > from) s.log.unshift({ at: now(), text: `All ${from} went out yesterday with no refusal: ${s.cap} a day today.` });
  }
  return true;
}

function state(): CapState {
  const s = load();
  let dirty = roll(s);
  if (s.blocked_until && Date.parse(s.blocked_until) <= Date.now()) { s.blocked_until = null; dirty = true; }
  if (dirty) save(s);
  return s;
}

/** Today's trial-reel cap (0 while Instagram has trial reels blocked). */
export function trialCap(): number {
  const f = fixed();
  if (f) return f;
  const s = state();
  return s.blocked_until ? 0 : s.cap;
}

/** Trial reels posted in the last 24 h, from any path (the daily batch, live optimize, Launch, Test Lab). */
export async function trialsLastDay(): Promise<number> {
  const repo = getRepo();
  const [posts, vs] = await Promise.all([repo.list("reel_posts"), repo.list("reel_variants")]);
  const trial = new Set(vs.filter((v) => v.tags?.launched === "trial").map((v) => `${v.job_id}|${v.id}`));
  const tagged = posts.filter((p) => p.posted_at && Date.now() - Date.parse(p.posted_at) < DAY && trial.has(`${p.job_id}|${p.variant_id}`)).length;
  const sent = load().posts.filter((t) => Date.now() - Date.parse(t) < DAY).length;
  return Math.max(tagged, sent);
}

/** Instagram refusing a post for a limit, a block or spam (not a bad file or an expired token). */
export function isLimitError(msg: string): boolean {
  if (/still processing|code 190\b|code 10\b|upload failed/i.test(msg)) return false;
  return /code (4|9|17|32|368|613)\b|2207042|2207051|limit|maximum number|too many|temporarily blocked|action blocked|restricted|try again later/i.test(msg);
}

const q = globalThis as { __trialQueue?: Promise<unknown> };

/**
 * Post one trial reel, in line behind any other (so a refusal stops the rest), within today's cap. Learns the ceiling
 * from a limit refusal. Every trial-reel post goes through here.
 */
export function postTrial<T>(send: () => Promise<T>): Promise<T> {
  const run = async () => {
    // trial_params on a resumable upload was ignored and 5 reels went out as normal reels (Meta documents
    // trial_params only for the video_url upload). Off until a trial post is confirmed to land as a trial reel.
    if ((process.env.DESK_TRIAL_POSTING ?? "off").toLowerCase() !== "on")
      throw new Error("Trial posting is off: Instagram posted the last batch as normal reels, not trial reels. Nothing was sent.");
    const cap = trialCap();
    if (!cap) throw new Error(`Instagram refused trial reels for a limit; the desk tries again after ${load().blocked_until?.slice(0, 16).replace("T", " ")} UTC.`);
    const out = await trialsLastDay();
    if (out >= cap) throw new Error(`Today's ${cap} trial reels are already out; this goes once the oldest is 24 h old.`);
    try {
      const r = await send();
      const s = state();
      s.posts.push(now());
      const d = (s.days[s.date] ??= { date: s.date, cap: s.cap, posted: 0 });
      d.posted++; d.cap = s.cap;
      if (out + 1 >= s.cap) s.filled = s.date;
      save(s);
      return r;
    } catch (e) {
      const msg = (e as Error).message;
      if (!isLimitError(msg)) throw e;
      const s = state();
      const d = (s.days[s.date] ??= { date: s.date, cap: s.cap, posted: 0 });
      d.refused = true;
      if (out >= 3) {
        s.ceiling = out; s.cap = Math.max(1, out);
        s.hit = { at: now(), posted: out, error: msg.slice(0, 240) };
        s.log.unshift({ at: now(), text: `Instagram refused trial reel ${out + 1} in 24 h: the account's limit is ${out} a day. Holding there; re-testing in ${RETEST_DAYS()} days.` });
      } else {
        s.blocked_until = new Date(Date.now() + DAY).toISOString();
        s.hit = { at: now(), posted: out, error: msg.slice(0, 240) };
        s.log.unshift({ at: now(), text: `Instagram refused a trial reel with only ${out} out: trial reels look blocked. Paused for a day, then one is tried.` });
      }
      save(s);
      throw new Error(fixed()
        ? `Instagram refused it: its daily trial-reel limit is reached (${msg.slice(0, 140)}). Room comes back as each trial reel turns 24 h old; press it again later.`
        : `Instagram refused it for a limit (${msg.slice(0, 160)}). The desk holds trial reels at ${s.blocked_until ? "0 until tomorrow" : `${s.cap} a day`}.`);
    }
  };
  // a gap between posts, so a run of them doesn't trip Instagram's rate limits
  const gap = () => new Promise((r) => setTimeout(r, Math.max(0, (Number(process.env.DESK_TRIAL_GAP_S) || 60) * 1000)));
  const p = (q.__trialQueue ?? Promise.resolve()).catch(() => {}).then(run);
  const after = p.catch(() => {}).then(gap);
  q.__trialQueue = after;
  return p;
}

export interface TrialCapStatus { mode: "ramp" | "fixed"; cap: number; out: number; step: number; ceiling: number | null; blocked_until: string | null;
  hit: CapState["hit"]; retest_days: number; days: CapDay[]; log: CapState["log"]; next: string }

/** For Results and Launch: where the ramp stands. */
export async function trialCapStatus(): Promise<TrialCapStatus> {
  const f = fixed();
  const s = state();
  const cap = trialCap(), out = await trialsLastDay();
  const next = f ? `Fixed at ${f} a day (DESK_DAILY_TRIALS); the ramp is off.`
    : s.blocked_until ? `Paused: Instagram refused a trial reel with almost nothing out. One is tried after ${s.blocked_until.slice(0, 16).replace("T", " ")} UTC.`
    : s.hit ? `Instagram's limit for this account: ${s.ceiling} a day (refused ${s.hit.at.slice(0, 10)}). Holding there; one more is tried ${RETEST_DAYS()} days after the refusal.`
    : cap >= MAX ? `At ${MAX} a day, the API's own limit for all posts.`
    : `Ramping: ${cap} today. If all ${cap} go out with no refusal, tomorrow is ${Math.min(MAX, cap + STEP())}. The first refusal sets the ceiling.`;
  return { mode: f ? "fixed" : "ramp", cap, out, step: STEP(), ceiling: s.ceiling, blocked_until: s.blocked_until, hit: s.hit, retest_days: RETEST_DAYS(),
    days: Object.values(s.days).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14), log: s.log.slice(0, 8), next };
}
