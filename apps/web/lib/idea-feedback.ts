import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getRepo } from "@engine/db";
import { ACT_REACH } from "./lab";
import { allItems, type Item } from "./optimize";

/**
 * What each idea taught us. Every video made from an idea reports back here when Instagram or Meta judges
 * it: killed (it failed with real viewers) or worked (it passed the reach goal). The founder's own deletes count too, as
 * a dislike, but far lighter: what real viewers did outweighs taste. Archiving is plain house cleaning and teaches nothing.
 * Idea generation and the ranking read this, so ideas like the failures sink and ideas like the winners rise.
 */

export type Outcome = "killed" | "worked" | "founder_deleted";
export interface Lesson {
  key: string; idea: string; idea_title: string; idea_hook: string; outcome: Outcome; weight: number;
  video: string | null; kind: "ad" | "trial" | null; why: string; reach: number | null; at: string;
}
interface File {
  archived: Record<string, string>; // idea id → when
  deleted: Record<string, string>;
  lessons: Record<string, Lesson>; // by video key (or "deleted:<idea>")
}

/** IG/Meta verdicts weigh 3 (4 for a big winner); the founder deleting an idea weighs 1. */
export const WEIGHT = { ig: 3, igBig: 4, founder: 1 } as const;

const FILE = process.env.IDEA_FEEDBACK_FILE || path.resolve(process.cwd(), "../../packages/db/data/private/idea-feedback.json");
const now = () => new Date().toISOString();
function read(): File {
  try { return { archived: {}, deleted: {}, lessons: {}, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; }
  catch { return { archived: {}, deleted: {}, lessons: {} }; }
}
function write(f: File) { fs.writeFileSync(FILE, JSON.stringify(f, null, 1)); }

export const hiddenIdeas = () => { const f = read(); return { archived: f.archived, deleted: f.deleted }; };

const best = (it: Item) => Math.max(0, ...it.readings.map((r) => (it.kind === "trial" ? r.reach : r.impressions) ?? 0));

/**
 * Bring the lessons up to date from the optimizer: each video made from an idea (or re-cut from one) that was killed or
 * passed the reach goal. Idempotent and retroactive: it reads everything the optimizer has ever judged.
 */
export async function syncLessons(): Promise<File> {
  const f = read();
  const [variants, items] = await Promise.all([getRepo().list("reel_variants"), getRepo().list("content_items")]);
  const vOf = (key: string) => { const [j, id] = key.split(/[|/]/); return variants.find((v) => v.job_id === j && v.id === id); };
  const ideaOf = (it: Item) => {
    const own = vOf(it.key)?.tags?.idea, root = vOf(it.root)?.tags?.idea;
    return (own || root) ? String(own || root) : null;
  };
  let changed = false;
  for (const it of allItems()) {
    // a reel not made from an idea still teaches: its own hook is the pattern (idea "")
    const idea = ideaOf(it) ?? "";
    const reach = best(it);
    // ads judge installs, so only trial reels "work" on reach; a killed ad or trial is a failure either way
    const outcome: Outcome | null = it.status === "killed" ? "killed" : it.kind === "trial" && reach >= ACT_REACH ? "worked" : null;
    const had = f.lessons[it.key];
    if (!outcome) continue;
    if (had && had.outcome === outcome && had.reach === reach) continue;
    const c = idea ? items.find((x) => x.id === idea) : undefined;
    const m = (c?.meta ?? {}) as { hook?: string };
    f.lessons[it.key] = {
      key: it.key, idea, idea_title: c?.title ?? (idea || "(not from an idea)"), idea_hook: m.hook ?? c?.caption ?? "", outcome,
      weight: outcome === "worked" && reach >= 2 * ACT_REACH ? WEIGHT.igBig : WEIGHT.ig, video: it.label.slice(0, 120), kind: it.kind,
      why: outcome === "killed" ? (it.why ?? it.next ?? "killed by the optimizer").slice(0, 240) : `${reach.toLocaleString()} reach`,
      reach, at: had?.at ?? now(),
    };
    changed = true;
  }
  if (changed) write(f);
  return f;
}

/** Archive (house cleaning, no lesson) or put back. */
export function archiveIdea(id: string, on: boolean) {
  const f = read();
  if (on) f.archived[id] = now(); else delete f.archived[id];
  write(f);
}

/** The founder deleted an idea: hidden, and remembered as a (light) dislike. */
export function deleteIdea(id: string, title: string, hook: string) {
  const f = read();
  f.deleted[id] = now();
  delete f.archived[id];
  f.lessons[`deleted:${id}`] = { key: `deleted:${id}`, idea: id, idea_title: title, idea_hook: hook, outcome: "founder_deleted", weight: WEIGHT.founder,
    video: null, kind: null, why: "The founder deleted this idea (taste, not tested with viewers).", reach: null, at: now() };
  write(f);
}

/** Per idea: what its videos did, for the card. */
export function outcomesByIdea(f: File) {
  const by: Record<string, { killed: number; worked: number; best: number | null; why: string | null }> = {};
  for (const l of Object.values(f.lessons)) {
    if (l.outcome === "founder_deleted" || !l.idea) continue;
    const o = (by[l.idea] ??= { killed: 0, worked: 0, best: null, why: null });
    if (l.outcome === "killed") { o.killed++; o.why ??= l.why; } else { o.worked++; o.best = Math.max(o.best ?? 0, l.reach ?? 0); }
  }
  return by;
}

/** What Claude reads before ranking or generating: the lessons, heaviest first, and how to weigh them. */
export function lessonsBrief(f: File) {
  const ls = Object.values(f.lessons).sort((a, b) => b.weight - a.weight || b.at.localeCompare(a.at)).slice(0, 80);
  return {
    how_to_weigh: `Each lesson has a weight. "killed" and "worked" are what real Instagram viewers and Meta ads did (weight ${WEIGHT.ig}-${WEIGHT.igBig}): trust them far more. "founder_deleted" is the founder's taste (weight ${WEIGHT.founder}): a soft dislike, a hint, never proof. Learn the pattern (the kind of hook, subject, angle, format), not just the exact idea. Reach comes first; a reel under ${ACT_REACH} reach that wasn't killed teaches little.`,
    lessons: ls.map(({ idea_title, idea_hook, outcome, weight, video, kind, why, reach }) => ({ idea: idea_title, hook: idea_hook, outcome, weight, video, kind, why, reach })),
  };
}
