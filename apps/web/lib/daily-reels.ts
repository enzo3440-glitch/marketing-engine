import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getRepo, type Approval, type ReelVariant } from "@engine/db";
import { metaAds } from "./ad-campaigns";
import { bragRuns, startBragAd } from "./brag-ad";
import { bragFolder, bragTweak, startBragTweak } from "./brag-tweak";
import { igPosts } from "./meta-insights";
import { markFolder, streamFolders, streamOf } from "./streams";
import { FEATURES, featureName, featureOf, type FeatureId } from "./features";
import { optimizeOn } from "./optimize";
import { trialCap, trialsLastDay, trialCapStatus } from "./trial-cap";
import { hstToday } from "./utils";
import { chosenNote, findSound, pickSound, soundFallback, type ViralSound } from "./viral-sounds";
import { BRAND } from "./brand";

/**
 * The Instagram stream's daily engine.
 *
 * Once per desk-clock day it makes enough Instagram reels to fill today's trial-reel cap (ramping up until Instagram refuses, lib/trial-cap.ts):
 *  - about a third are REMIXES of what's working on the account: the best recent posts by (saves + shares) / reach,
 *    each changed a little (a new opening line, a different first shot, a different place or song start). A desk-made
 *    winner is tweaked in its own /brag folder; one posted from outside the desk is downloaded and re-cut.
 *  - the rest are NEW reels in the Instagram philosophy, rotating through angles and places so no two days repeat:
 *    film photos and the best of the roll, analog and real, one short line, the app at most a small card.
 * When they're rendered it proposes one approval: "Post today's N trial reels" (another only once that one is decided) (free, non-followers only, off the
 * grid). DESK_AUTO_TRIALS=on approves that batch by itself (trial reels only, never ads or spend).
 * The autopilot then judges each one like any launched video, and the winners feed tomorrow's remixes.
 */

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const STATE = path.join(DATA, "ads", "_daily.json");
const now = () => new Date().toISOString();
/** Trial reels a day: today's step of the ramp that finds Instagram's limit for this account (lib/trial-cap.ts). */
export const dailyTrials = () => trialCap();
export { trialsLastDay };
const autoTrials = () => (process.env.DESK_AUTO_TRIALS ?? "off").toLowerCase() === "on";

// swaps: tries at putting a viral sound on a reel ("<job>|<video>"), so one that keeps failing stops being retried
// resound: reels already on a viral sound that get a different one
interface State { date: string; started: string[]; proposal: string | null; remixed: Record<string, string>; swaps?: Record<string, number>; resound?: string[];
  // soundFor: a sound picked by hand for a reel ("<job>|<video>" -> sound name), matched to its place, pace and mood
  soundFor?: Record<string, string>;
  // fixFor: one more change for a reel's next swap, in the owner's words ("<job>|<video>" -> ask)
  fixFor?: Record<string, string>;
  // extra: one-off videos asked for by hand (an idea to test), started on the next pass, on top of the day's quota
  extra?: { title: string; ask: string; stream: "ig" | "ad"; sound?: string }[];
  // daily learning
  featureFor?: Record<string, string>; changeFor?: Record<string, string>; lessons?: Lessons; plan?: { date: string; items: PlanItem[] } }

export interface FeatureLesson { id: string; name: string; reels: number; reach: number; ss: number; act: number; watch: number | null; pbest: number }
export interface Lessons { date: string; read: number; features: FeatureLesson[]; changes: { change: string; reels: number; act: number; vs: number }[];
  sounds: { sound: string; reels: number; act: number }[]; notes: string[] }
export interface PlanItem { kind: "new" | "remix"; feature?: string; change?: string; title: string; why: string }
const load = (): State => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { date: "", started: [], proposal: null, remixed: {} }; } };
const save = (s: State) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); };

const IG = `This is an INSTAGRAM REEL for ${BRAND.name}'s own account${BRAND.handle ? ` (@${BRAND.handle})` : ""}, not an ad. Its Instagram is real and never commercial:
the subject and the feeling are the whole video. No phone, no app screens, no CTA, no "download". No map pins or
location badges unless one marks a real, named place the line is about. One or two short lines in the brand voice (README.md),
lowercase is fine, or none; the lines sit around the middle of the frame or in the lower third, never at the top. A cinematic
grade: natural filmic colour, soft contrast, light grain, never oversaturated. Unhurried cuts on the music. 8-14 s, vertical
9:16. Real VIDEO only, from the best clips (the kit's footage.md "Best of the roll" sections): no photo-only reels and no
panning or zooming on photos. No clip appears twice in one reel.
Real video plays as real video: slow motion only on clips shot at 60 fps or more, a 30 fps clip at normal speed, never stretched,
frame-stepped or zoomed as stills (README.md, "Footage speed"). One place per reel. Few people, small or from behind.`;

/** New reel angles, rotated by day so the account doesn't repeat itself. Each names its place and its material. */
const ANGLES: { feature: FeatureId; title: string; ask: string }[] = [
  { feature: "custom_tours", title: "A route made for you", ask: "One place from the best-of footage as a single route made for you: each stop flowing into the next like something planned around the viewer. One short line in the brand voice." },
  { feature: "trip_guide", title: "Nothing to research", ask: "One place from the best-of footage, shown as if everything was already taken care of: no planning, no tabs, just the place. One short line in the brand voice." },
  { feature: "like_a_local", title: "Where locals go", ask: "One place from the best-of footage at the hour locals are out: the small, real spots over the famous ones. One short line in the brand voice, or none." },
  { feature: "get_lost", title: "No plan needed", ask: "One place from the best-of footage, slow and unhurried, as if nobody had a plan. One short line in the brand voice, or none." },
  { feature: "hidden_gems", title: "Not on the feed", ask: "One place from the best-of footage that most people never see, kindly contrasted with the crowded version for one beat. One short line in the brand voice." },
  { feature: "gamification", title: "Follow the clue", ask: "One place from the best-of footage as a trail of clues, each shot leading to the next, ending on the reveal. One short line in the brand voice." },
];

/** The one thing a remix changes, so each remix teaches us something (the daily read compares them). */
const CHANGES: Record<string, string> = {
  "opening shot": "a new opening shot: the most striking frame first, the line arrives a beat later",
  "opening line": "a different opening line in the brand voice, same shots",
  "place": "the same idea in a different place from the kit's best-of footage or film photos (one place only)",
  "song start": "a different song start: land the first cut on the song's drop",
};
const REMIX = (why: string, change: string) => `Results: this reel is one of our best on Instagram (${why}). Make a new version that keeps what works
(the place, the mood, the music feel) and changes ONE thing so we learn something: ${CHANGES[change] ?? CHANGES["opening shot"]}. Instagram reel, not an ad: no app screens, no CTA.`;

// ---------------------------------------------------------------- daily learning
// Instagram allows only so many trial reels a day, so each day's slots are spent on what we most need to learn:
// every feature keeps a reel a day until MIN_READS of its reels have been read, the rest go to the features most likely
// to be the best (sampled from their saves + shares per reach, so a lucky reel doesn't decide it), about 30% are remixes
// of the account's winners that change ONE thing (the change we know least about), and live optimize's re-cuts keep
// RESERVE slots free. Read once a desk-clock day, before the day's reels are made.

const MIN_READS = 4;
const RESERVE = () => (optimizeOn() ? 2 : 0);
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
/** Saves + shares per reach, shrunk toward ~1% so a small reel with three saves doesn't look like a winner. */
const actOf = (ss: number, reach: number) => (ss + 1) / (reach + 100);

/** P(each feature is the best at saves and shares), by sampling each one's uncertainty. */
function pBest(rows: { id: string; ss: number; reach: number }[], seed: number): Record<string, number> {
  const r = rng(seed), wins: Record<string, number> = {}, N = 2000;
  for (let i = 0; i < N; i++) {
    let best = "", top = -Infinity;
    for (const f of rows) {
      const p = actOf(f.ss, f.reach), sd = Math.sqrt((p * (1 - p)) / (f.reach + 102));
      const x = p + sd * gauss(r);
      if (x > top) { top = x; best = f.id; }
    }
    wins[best] = (wins[best] ?? 0) + 1;
  }
  return Object.fromEntries(rows.map((f) => [f.id, (wins[f.id] ?? 0) / N]));
}

/** Once a day: read every trial reel from the last 10 days (18 h+ old) and work out what it's teaching us. */
async function learnDay(s: State, say: (t: string) => void): Promise<void> {
  const today = hstToday();
  if (s.lessons?.date === today) return;
  const m = metaAds();
  if (!m) return;
  const repo = getRepo();
  const [vs, posts] = await Promise.all([repo.list("reel_variants"), repo.list("reel_posts")]);
  const at = (v: ReelVariant) => posts.find((p) => p.job_id === v.job_id && p.variant_id === v.id)?.posted_at;
  const trials = vs.filter((v) => v.tags?.launched === "trial" && v.tags?.ig_media_id && v.tags?.launch_status !== "deleted" && at(v))
    .filter((v) => { const h = (Date.now() - Date.parse(at(v)!)) / 3_600_000; return h >= 18 && h <= 240; }).slice(0, 80);
  const rows: { f: string; change?: string; sound?: string; reach: number; ss: number; watch: number | null }[] = [];
  for (const v of trials) {
    const r = await m.reelResults(v.tags.ig_media_id).catch(() => null);
    if (!r || !r.reach) continue;
    const planned = v.tags.brag ? s.featureFor?.[v.tags.brag] : undefined;
    if (planned && !v.tags.feature) await repo.update("reel_variants", { job_id: v.job_id, id: v.id }, { tags: { ...v.tags, feature: planned } }).catch(() => null);
    rows.push({ f: v.tags.feature || planned || featureOf(v), change: v.tags.learn_change || (v.tags.brag ? s.changeFor?.[v.tags.brag] : undefined),
      sound: v.tags.sound, reach: r.reach, ss: r.saves + r.shares, watch: r.avgWatchMs != null && v.duration ? r.avgWatchMs / 1000 / v.duration : null });
  }
  const sum = (xs: typeof rows) => ({ reels: xs.length, reach: xs.reduce((n, x) => n + x.reach, 0), ss: xs.reduce((n, x) => n + x.ss, 0) });
  const fRows = FEATURES.map((f) => ({ id: f.id as string, ...sum(rows.filter((x) => x.f === f.id)) }));
  const pb = pBest(fRows, Math.floor(Date.parse(today + "T00:00:00Z") / 86400_000));
  const features: FeatureLesson[] = fRows.map((f) => {
    const w = rows.filter((x) => x.f === f.id && x.watch != null).map((x) => x.watch!);
    return { id: f.id, name: featureName(f.id), reels: f.reels, reach: f.reach, ss: f.ss, act: actOf(f.ss, f.reach),
      watch: w.length ? w.reduce((a, b) => a + b, 0) / w.length : null, pbest: pb[f.id] ?? 0 };
  }).sort((a, b) => b.pbest - a.pbest);
  const all = sum(rows), base = actOf(all.ss, all.reach);
  const changes = Object.keys(CHANGES).map((c) => {
    const t = sum(rows.filter((x) => x.change === c));
    return { change: c, reels: t.reels, act: actOf(t.ss, t.reach), vs: t.reels ? actOf(t.ss, t.reach) / base - 1 : 0 };
  });
  const sounds = [...new Set(rows.map((x) => x.sound).filter((x): x is string => !!x))]
    .map((snd) => { const t = sum(rows.filter((x) => x.sound === snd)); return { sound: snd, reels: t.reels, act: actOf(t.ss, t.reach) }; })
    .filter((x) => x.reels >= 2).sort((a, b) => b.act - a.act);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const notes: string[] = [];
  const lead = features[0];
  if (!rows.length) notes.push("No trial reel has been out 18 h yet, so today's slots are spread evenly across the features.");
  else {
    notes.push(lead.pbest >= 0.6
      ? `${lead.name} is clearly leading (${Math.round(lead.pbest * 100)}% likely the best at saves and shares: ${pct(lead.act)} vs ${pct(base)} overall), so it gets the most new reels today.`
      : `No clear leader yet (${lead.name} is ahead at ${Math.round(lead.pbest * 100)}%), so today keeps spreading reels across the features.`);
    const thin = features.filter((f) => f.reels < MIN_READS).map((f) => f.name);
    if (thin.length) notes.push(`Too few reads to judge yet: ${thin.join(", ")}. Each keeps at least one reel a day until ${MIN_READS} have been read.`);
    const bestChange = changes.filter((c) => c.reels >= 2).sort((a, b) => b.vs - a.vs)[0];
    if (bestChange && bestChange.vs > 0.15) notes.push(`Of the remix changes, a new ${bestChange.change} works best so far (+${Math.round(bestChange.vs * 100)}% saves and shares vs the average).`);
    if (sounds.length >= 2) notes.push(`Best sound so far: "${sounds[0].sound}" (${pct(sounds[0].act)}); weakest: "${sounds[sounds.length - 1].sound}" (${pct(sounds[sounds.length - 1].act)}).`);
  }
  s.lessons = { date: today, read: rows.length, features, changes, sounds: sounds.slice(0, 8), notes };
  say(`Instagram daily read: ${rows.length} trial reels. ${notes[0] ?? ""}`);
}

/** Today's new-reel slots by feature: one each for features still under-read, the rest in proportion to P(best). */
function allocate(n: number, lessons: Lessons | undefined, seed: number): FeatureId[] {
  const rows = lessons?.features ?? FEATURES.map((f) => ({ id: f.id, reels: 0, pbest: 1 / FEATURES.length }) as FeatureLesson);
  const r = rng(seed);
  const out: FeatureId[] = [];
  for (const f of [...rows].filter((x) => x.reels < MIN_READS).sort((a, b) => a.reels - b.reels || r() - 0.5)) if (out.length < n) out.push(f.id as FeatureId);
  const left = n - out.length;
  if (left > 0) {
    const share = rows.map((f) => ({ id: f.id as FeatureId, x: f.pbest * left, k: Math.floor(f.pbest * left) }));
    let k = share.reduce((a, b) => a + b.k, 0);
    for (const w of [...share].sort((a, b) => (b.x - b.k) - (a.x - a.k))) { if (k >= left) break; w.k++; k++; }
    for (const w of share) for (let i = 0; i < w.k; i++) out.push(w.id);
  }
  return out;
}

/** The remix change we know least about (fewest reads and tries), so every kind of change gets tested. */
function nextChange(s: State, i: number): string {
  const keys = Object.keys(CHANGES);
  const reads = Object.fromEntries((s.lessons?.changes ?? []).map((c) => [c.change, c.reels]));
  const tried: Record<string, number> = {};
  for (const c of Object.values(s.changeFor ?? {})) tried[c] = (tried[c] ?? 0) + 1;
  const score = (c: string) => (reads[c] ?? 0) + (tried[c] ?? 0);
  return [...keys].sort((a, b) => score(a) - score(b) || ((keys.indexOf(a) + i) % keys.length) - ((keys.indexOf(b) + i) % keys.length))[0];
}

/** For Results: what the trial reels taught us, and today's plan. */
export async function trialLearning() {
  const s = load();
  const cap = await trialCapStatus();
  return { goal: cap.cap, reserve: cap.cap ? Math.min(RESERVE(), Math.floor(cap.cap / 4)) : 0, cap, lessons: s.lessons ?? null, plan: s.plan?.date === s.date ? s.plan.items : [] };
}


/** Desk videos on the Instagram side that are finished, not launched, not already in a batch, and not replaced by a
 * newer version of themselves (a music swap or a fix is a revision: the revision goes out, not the original). */
async function readyIg(exclude: Set<string>): Promise<ReelVariant[]> {
  const repo = getRepo();
  const [jobs, vs] = await Promise.all([repo.list("reel_jobs", { eq: { status: "done" } }), repo.list("reel_variants")]);
  const since = Date.now() - 7 * 86400_000;
  const fresh = new Set(jobs.filter((j) => Date.parse(j.created_at) >= since).map((j) => j.job_id));
  const folders = streamFolders();
  const replaced = new Set(vs.map((v) => v.tags?.revision_of).filter(Boolean));
  return vs.filter((v) => v.file && fresh.has(v.job_id) && streamOf(v, folders) === "ig" && !(v.tags?.launched && v.tags.launch_status !== "failed")
    && !exclude.has(`${v.job_id}|${v.id}`) && !replaced.has(`${v.job_id}/${v.id}`));
}

/** A /brag Instagram reel cut to a stock track: trial reels go out on a viral sound. */
const needsSound = (v: ReelVariant, again: string[] = []) => String(v.tags?.made_by ?? "").startsWith("brag") && (!v.tags?.sound || again.includes(`${v.job_id}|${v.id}`));
// a tweak runs in the reel's old folder, whose README predates these rules: point at the files themselves
const KIT_NOTES = path.join(DATA, "..", "knowledge", "brag-kit.md");
const FILM_NOTES = path.join(DATA, "ads", "_kit", "film", "film.md");
const SWAP_LANES = Math.max(1, Number(process.env.BRAG_LANES) || 2);
const SWAP = (snd: ViralSound, out: string, was?: string, chosen = false, fix?: string) => {
  const same = was === snd.name;
  return `${same ? `Keep the music: ${snd.file} ("${snd.name}").` : `Swap the music for the viral sound ${snd.file} ("${snd.name}", the audio of a viral reel).`}${snd.note ? ` ${snd.note}` : ""}${was && !same ? `
The edit is good as it is; only the song changes.${chosen ? "" : ` Don't use "${was}" again: too many of our reels are on it.`}` : ""}${was ? `
Fix besides the song: every pan or push-in on a film photo follows the pan rule in ${FILM_NOTES} (stay on the subject, in the
photo's center two-thirds, never ending on a wall or an edge). Look at each photo's frames in your render and re-aim any move that drifts.
And any stutter: a video clip slowed or stepped below its real frame rate (a 30 fps clip stretched with setpts or minterpolate, or
stills pulled from it and zoomed) goes back to normal speed, or real slow motion only if the clip is 60 fps or more ("Footage speed" in ${KIT_NOTES}).` : ""}${fix ? `
Also: ${fix}` : ""}
It is the whole music bed: one start point, no second song, nothing of the old track left. Keep every shot, every line and the
look exactly unless told otherwise above; re-time cuts only where they need to sit on the song's beat, and land the hook's turn on its drop.
SFX very soft or none, so it sounds like a real reel cut to a trending sound.
${chosen ? chosenNote(path.join(out, "sound.txt")) : soundFallback(snd, path.join(out, "sound.txt"))}`;
};

/** Videos already offered in a batch that's still waiting (so they aren't offered twice). */
async function inPendingBatch(): Promise<{ keys: Set<string>; pending: Approval[] }> {
  const pending = (await getRepo().list("approvals", { eq: { status: "pending" } }))
    .filter((a) => (a.preview as { action?: { kind?: string } } | null)?.action?.kind === "post_trials_batch");
  const keys = new Set<string>();
  for (const a of pending) for (const x of ((a.preview as { action: { items: { job_id: string; variant_id: string }[] } }).action.items)) keys.add(`${x.job_id}|${x.variant_id}`);
  return { keys, pending };
}

/** Trial reels and posts that went out in the last 24 h (Instagram's publishing limit counts these). */
async function postedLastDay(): Promise<number> {
  return (await getRepo().list("reel_posts")).filter((p) => p.posted_at && Date.now() - Date.parse(p.posted_at) < 86400_000).length;
}

async function downloadPost(id: string): Promise<string | null> {
  const m = metaAds();
  if (!m) return null;
  const p = await m.get<{ media_url?: string; media_type?: string }>(id, { fields: "media_url,media_type" }).catch(() => null);
  if (!p?.media_url || p.media_type !== "VIDEO") return null;
  const r = await fetch(p.media_url);
  if (!r.ok) return null;
  const rel = path.join("ig", `${id}.mp4`);
  fs.mkdirSync(path.join(DATA, "input", "ig"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "input", rel), Buffer.from(await r.arrayBuffer()));
  return rel.replace(/\\/g, "/");
}

/** One pass of the daily engine; `say` logs to the autopilot's log. */
export async function dailyTick(say: (t: string) => void, judge: (r: { reach: number; saves: number; shares: number }) => number = (r) => (r.saves + r.shares) / Math.max(1, r.reach)) {
  const today = hstToday();
  let s = load();
  if (s.date !== today) s = { ...s, date: today, started: [], proposal: null, remixed: s.remixed ?? {}, swaps: s.swaps ?? {}, resound: s.resound ?? [], plan: { date: today, items: [] } };
  s.plan ??= { date: today, items: [] };
  await learnDay(s, say).catch((e) => say(`Instagram daily read: ${(e as Error).message}`));
  s.swaps ??= {};
  s.resound ??= [];
  const goal = dailyTrials();
  // live optimize's re-cuts post into the slots held back; nothing is made while Instagram has trial reels blocked
  // how many reels to MAKE a day is its own setting (DESK_DAILY_MAKE), not the posting cap: raising the posting cap
  // (so only Instagram limits posting) once made the autopilot read it as "make 100 reels" overnight
  const makeEnv = process.env.DESK_DAILY_MAKE;
  const make = makeEnv != null && makeEnv !== "" ? Math.max(0, Math.min(Number(makeEnv) || 0, 20))
    : goal ? Math.min(10, Math.max(1, goal - Math.min(RESERVE(), Math.floor(goal / 4)))) : 0;
  const { keys, pending } = await inPendingBatch();
  const ready = await readyIg(keys);
  const working = bragRuns().filter((c) => s.started.includes(c.id) && !["done", "error"].includes(c.status)).length;

  // 1. make: fill today's quota (what's ready + what's rendering), never more than the goal started per day
  const need = Math.min(make - ready.length - working, make - s.started.length);
  if (need > 0) {
    const posts = (await igPosts(50).catch(() => null)) ?? [];
    const winners = posts.filter((p) => (p.reach ?? 0) >= 150 && /REELS|VIDEO/.test(p.kind) && (!s.remixed[p.id] || Date.now() - Date.parse(s.remixed[p.id]) > 7 * 86400_000))
      .map((p) => ({ p, score: judge({ reach: p.reach ?? 0, saves: p.saves ?? 0, shares: p.shares ?? 0 }) }))
      .sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.round(need * 0.3)));
    const vs = await getRepo().list("reel_variants");
    let made = 0;
    for (const [i, { p, score }] of winners.entries()) {
      const why = `${p.reach} reach, ${((score) * 100).toFixed(1)}% saved or shared`;
      const desk = vs.find((v) => v.tags?.ig_media_id === p.id);
      const change = nextChange(s, i + s.started.length);
      const feature = desk ? featureOf(desk) : featureOf({ hook: p.caption });
      try {
        const folder = desk && bragFolder(desk.job_id, desk.tags);
        if (desk && folder) {
          markFolder(path.basename(folder), "ig");
          await startBragTweak(desk.job_id, desk.id, REMIX(why, change), true, { learn_change: change, feature });
          s.started.push(`tweak:${desk.job_id}`);
        } else {
          const clip = await downloadPost(p.id);
          if (!clip) continue;
          const c = startBragAd(null, `Remix: ${p.caption.split("\n")[0].slice(0, 60)}`, `${REMIX(why, change)}\nThe original reel is the attached clip (${clip}): re-cut it, reuse its best shots, add better ones from the kit.\n${IG}`, [clip], "floating", "ig");
          s.started.push(c.id);
          (s.changeFor ??= {})[c.id] = change; (s.featureFor ??= {})[c.id] = feature;
        }
        s.plan!.items.push({ kind: "remix", feature, change, title: p.caption.split("\n")[0].slice(0, 60) || "a winning reel", why: `A winner (${why}); this version changes only the ${change}, to learn whether that helps.` });
        s.remixed[p.id] = now();
        made++;
        say(`Instagram: remixing a winner ("${p.caption.split("\n")[0].slice(0, 50)}", ${why}).`);
      } catch (e) { say(`Instagram: couldn't remix "${p.caption.slice(0, 40)}": ${(e as Error).message}`); }
    }
    const day = Math.floor(Date.parse(`${today}T12:00:00Z`) / 86400_000);
    const slots = allocate(need - made, s.lessons, day + s.started.length);
    const usedToday = (f: string) => s.plan!.items.filter((x) => x.kind === "new" && x.feature === f).length;
    for (const f of slots) {
      const pool = ANGLES.filter((a) => a.feature === f);
      const a = pool[(day + usedToday(f)) % pool.length];
      const c = startBragAd(null, a.title, `${a.ask}\n${IG}`, [], "floating", "ig");
      s.started.push(c.id);
      (s.featureFor ??= {})[c.id] = f;
      const l = s.lessons?.features.find((x) => x.id === f);
      s.plan!.items.push({ kind: "new", feature: f, title: a.title, why: !l || l.reels < MIN_READS ? `${featureName(f)} needs more reads (${l?.reels ?? 0} of ${MIN_READS}).` : `${featureName(f)} is ${Math.round(l.pbest * 100)}% likely the best: more reels where it's working.` });
      made++;
    }
    say(`Instagram: making ${made} reel${made > 1 ? "s" : ""} for today (${ready.length} ready, goal ${goal}).`);
  }

  // 1b. one-off videos asked for by hand
  for (const x of (s.extra ?? []).splice(0)) {
    const c = x.stream === "ig"
      ? startBragAd(null, x.title, `${x.ask}
${IG}`, [], "floating", "ig", x.sound)
      : startBragAd(null, x.title, x.ask, [], "floating", undefined, x.sound);
    if (x.stream === "ig") s.started.push(c.id);
    say(`${x.stream === "ig" ? "Instagram" : "Ads"}: making "${x.title}"${x.sound ? ` on "${x.sound}"` : ""}.`);
  }

  // 2. sound: every finished /brag Instagram reel gets a viral sound before it can go out (a revision of it, same shots and lines)
  // no automatic music swaps while making is off (the founder picks what goes out, with the sound he sees)
  const swappable = make ? (await readyIg(keys)).filter((v) => needsSound(v, s.resound) && (s.swaps![`${v.job_id}|${v.id}`] ?? 0) < 2) : [];
  let swapping = swappable.filter((v) => bragTweak(v.job_id, v.id)?.status === "working").length;
  for (const [i, v] of swappable.entries()) {
    if (swapping >= SWAP_LANES) break;
    const t = bragTweak(v.job_id, v.id);
    if (t?.status === "working" || t?.status === "done") continue;
    const again = v.tags?.sound;
    const want = s.soundFor?.[`${v.job_id}|${v.id}`];
    const snd = (want && findSound(want)) || pickSound(i + Object.keys(s.swaps!).length);
    if (!snd) break;
    s.swaps![`${v.job_id}|${v.id}`] = (s.swaps![`${v.job_id}|${v.id}`] ?? 0) + 1; // a try even if it can't start (no /brag folder)
    try {
      await startBragTweak(v.job_id, v.id, SWAP(snd, path.join(bragFolder(v.job_id, v.tags) ?? "", "out"), again, !!want, s.fixFor?.[`${v.job_id}|${v.id}`]), false, { sound: snd.name });
      swapping++;
      say(`Instagram: putting "${snd.name}" on "${(v.hook || v.id).slice(0, 50)}".`);
    } catch (e) { say(`Instagram: couldn't swap the music on "${(v.hook || v.id).slice(0, 40)}": ${(e as Error).message}`); }
  }

  // 3. offer: one batch a day, once the day's reels are rendered and on a viral sound, within Instagram's limit
  const room = Math.max(0, Math.min(goal - (await trialsLastDay()), 100 - (await postedLastDay())));
  // a reel still on its stock track never goes out; one whose swap failed twice is left for you on Launch
  const fresh = (await readyIg(keys)).filter((v) => !needsSound(v, s.resound));
  const rendering = bragRuns().filter((c) => s.started.includes(c.id) && !["done", "error"].includes(c.status)).length
    + swappable.length; // a finished swap replaces its reel, so anything still listed here is waiting on its sound
  // trial reels only launch from Launch. The batch picked autopilot music-swap redos that weren't on Launch,
  // so the daily batch is off unless DESK_TRIAL_BATCH=on; trial reels go out from Launch, one approval per video.
  const trialsOn = (process.env.DESK_TRIAL_POSTING ?? "off").toLowerCase() === "on" && (process.env.DESK_TRIAL_BATCH ?? "off").toLowerCase() === "on";
  if (trialsOn && !pending.length && fresh.length && room && (fresh.length >= Math.min(goal, room) || rendering === 0)) {
    const pick = fresh.sort((a, b) => Number(!!b.tags?.partner_of) - Number(!!a.tags?.partner_of)).slice(0, room);
    const [a] = await getRepo().insert("approvals", [{
      id: crypto.randomUUID(), type: "optimize", ref_table: "reel_variants", ref_id: `daily:${today}`,
      title: `Post today's ${pick.length} trial reel${pick.length > 1 ? "s" : ""}`,
      summary: "Free. Shown only to non-followers, off your grid. The autopilot judges each after 48 h; the winners get remixed and can be promoted as ads.",
      preview: { bullets: pick.map((v) => `${(v.hook || v.id).slice(0, 90)}${v.tags?.partner_of ? " (remix of a winner)" : ""}`),
        action: { kind: "post_trials_batch", items: pick.map((v) => ({ job_id: v.job_id, variant_id: v.id, caption: v.caption ?? "" })) } },
      status: "pending", created_by_agent: "autopilot", decided_by: null, decided_at: null, result: null, created_at: now(),
    }]);
    s.proposal = a.id;
    say(`Instagram: today's ${pick.length} trial reels are waiting for one approval in Decide.`);
    if (autoTrials()) {
      const { runProposal } = await import("./improve");
      await getRepo().update("approvals", { id: a.id }, { status: "approved", decided_by: "autopilot (DESK_AUTO_TRIALS)", decided_at: now() });
      void runProposal({ ...a, status: "approved", decided_by: "autopilot (DESK_AUTO_TRIALS)" }).catch(() => {});
      say("Instagram: DESK_AUTO_TRIALS is on, so they're posting now.");
    }
  }
  save(s);
}
