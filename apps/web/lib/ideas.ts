import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getRepo, PILLARS, type ContentItem } from "@engine/db";
import { claudeLook } from "./claude-look";
import { archiveIdea, deleteIdea, hiddenIdeas, lessonsBrief, outcomesByIdea, syncLessons } from "./idea-feedback";
import { BRAND } from "./brand";

/**
 * Ideas: one list of everything worth making. Plan posts and the slate, Marketing Map cards, ideas you type, and ideas
 * Claude generates (on the Max login) from the marketing advisor skill. Each one can be turned into a video on Make.
 */

export type IdeaSource = "slate" | "plan" | "map" | "yours" | "generated";
export interface Idea {
  id: string; title: string; hook: string; tier: string | null; pillar: string | null; color: string | null;
  channel: string | null; beats: string[]; cta: string | null; why: string | null; source: IdeaSource; made: number;
  /** place in the ranked list (1 = best), null until it's ranked; where it should run; why it ranks there */
  rank: number | null; where: Where[]; rankWhy: string | null;
  /** the idea this one repeats (hidden by default), and how many repeats were folded into this one */
  dupOf: string | null; dups: number;
  /** archived (house cleaning, hidden by default); what its videos did with real viewers; its hook before Claude adjusted it */
  archived: boolean; outcome: { killed: number; worked: number; best: number | null; why: string | null } | null; hookWas: string | null;
}

export type Where = "ads" | "ig" | "tiktok";
const WHERE: Where[] = ["ads", "ig", "tiktok"];
const whereOf = (channel: string | null): Where[] => [channel === "ig_paid" ? "ads" : channel === "tiktok" ? "tiktok" : "ig"];

/** The ranking: duplicates folded together, best to worst, where each should run. Re-ranked by Claude from Ideas. */
interface Ranking { ranked_at: string; by: string; order: { id: string; rank: number; where: Where[]; why: string; dups: string[] }[] }
const RANK_FILE = process.env.IDEA_RANK_FILE || path.resolve(process.cwd(), "../../packages/db/data/private/idea-rank.json");
function ranking(): Ranking | null {
  try { return JSON.parse(fs.readFileSync(RANK_FILE, "utf8")) as Ranking; } catch { return null; }
}
export const rankedAt = () => ranking()?.ranked_at ?? null;

type Meta = { hook_was?: string; adjusted_why?: string; hook?: string; tier?: string; pillar?: string; channel?: string; beats?: string[]; cta?: string; hypothesis?: string; source?: string; made_job?: string[]; where?: Where[] };

const color = (p?: string | null) => PILLARS.find((x) => x.id === p)?.color ?? null;

function fromItem(c: ContentItem): Idea {
  const m = c.meta as Meta;
  const source: IdeaSource = c.source === "idea-slate" ? "slate" : c.id.startsWith("plan-") ? "plan" : c.source === "advisor" ? "generated" : "yours";
  return {
    id: c.id, title: c.title ?? c.id, hook: m.hook ?? c.caption ?? "", tier: m.tier ?? null, pillar: m.pillar ?? null, color: color(m.pillar),
    channel: m.channel ?? (c.platform === "tiktok" ? "tiktok" : null), beats: m.beats ?? [], cta: m.cta ?? null, why: m.hypothesis ?? null,
    source, made: m.made_job?.length ?? 0, rank: null, where: (m.where ?? []).filter((w) => WHERE.includes(w)), rankWhy: null, dupOf: null, dups: 0,
    archived: false, outcome: null, hookWas: m.hook_was ?? null,
  };
}

/** Every idea not yet posted: content ideas first (slate, then generated, yours, plan), then Marketing Map cards. */
export async function listIdeas(): Promise<Idea[]> {
  const repo = getRepo();
  const [items, map] = await Promise.all([repo.list("content_items"), repo.getMap()]);
  const ideas = items.filter((c) => c.status === "idea" || c.status === "draft").map(fromItem);
  const cards: Idea[] = map.doc.nodes.map((n) => ({
    id: `map:${n.id}`, title: n.title, hook: n.hook ?? "", tier: n.channel === "ads" ? "sell" : null, pillar: null, color: null,
    channel: n.channel === "ads" ? "ig_paid" : n.channel === "tiktok" ? "tiktok" : "ig_organic",
    beats: n.visual ? [n.visual] : [], cta: n.cta || null, why: n.hypothesis || null, source: "map", made: 0,
    rank: null, where: [], rankWhy: null, dupOf: null, dups: 0, archived: false, outcome: null, hookWas: null,
  }));
  const f = await syncLessons().catch(() => null);
  const hid = hiddenIdeas(), outs = f ? outcomesByIdea(f) : {};
  const all = [...ideas, ...cards].filter((i) => !hid.deleted[i.id]);
  for (const i of all) { i.archived = !!hid.archived[i.id]; i.outcome = outs[i.id] ?? null; }
  const r = ranking();
  const by = new Map(r?.order.map((o) => [o.id, o]) ?? []);
  const dupOf = new Map(r?.order.flatMap((o) => o.dups.map((d) => [d, o.id] as const)) ?? []);
  for (const i of all) {
    const o = by.get(i.id);
    if (o) Object.assign(i, { rank: o.rank, where: o.where.filter((w) => WHERE.includes(w)), rankWhy: o.why, dups: o.dups.length });
    else i.dupOf = dupOf.get(i.id) ?? null;
    if (!i.where.length) i.where = whereOf(i.channel);
  }
  // new (not ranked yet) first so you see them, then best to worst, repeats last
  const key = (i: Idea) => (i.dupOf ? 1e6 : i.rank ?? 0);
  return all.sort((a, b) => key(a) - key(b));
}

/** Have Claude fold duplicates together, rank every idea best to worst and mark where each should run. */
export async function rerankIdeas(): Promise<number> {
  const ideas = (await listIdeas()).filter((i) => !i.archived).map((i) => ({ id: i.id, source: i.source, title: i.title, hook: i.hook, tier: i.tier, channel: i.channel, beats: i.beats, cta: i.cta, videos: i.outcome }));
  const ans = await claudeLook<{ order?: Ranking["order"] }>(
    `You are ${BRAND.name}'s marketing advisor (SKILL.md, entertain-educate-sell.md; brand-voice.md is how we sound and wins over older notes). ideas.json is every video idea we have; current.json is the last ranking.
1. Fold duplicates together: ideas with the same hook or the same concept (slate items and their Marketing Map cards, plan items repeating a map card).
   Keep the most complete one (prefer slate, then plan, then map) and list the others in its "dups".
2. Rank the kept ideas best to worst for getting ${BRAND.goal}: easy to understand, creates desire,
   shows a shipped feature, and fits where it runs. Keep the current order where nothing changed; place new ideas where they belong.
3. "where": any of "ads" (paid Meta ads), "ig" (our organic Instagram, originals do best there), "tiktok".
4. Learn from lessons.json (follow its how_to_weigh): what real viewers killed and what worked, and ideas the founder deleted.
   Sink ideas that repeat a killed pattern, lift ideas that share what worked. An idea's own "videos" says what its videos did.
   When an idea's video was killed but the idea itself is still worth making, adjust it: give a better "hook" that fixes
   what failed (the why), in brand-voice.md, and say the fix in "adjusted". Leave "hook" out when it doesn't need changing.
Every id in ideas.json must appear exactly once (as a kept idea or in a dups list).
Answer {"order":[{"id","rank","where":["ads"|"ig"|"tiktok"],"why":"one short sentence","dups":["ids"],"hook"?:"new hook","adjusted"?:"what it fixes"}]}.`,
    {
      "SKILL.md": read("SKILL.md"), "brand-voice.md": voice(), "entertain-educate-sell.md": read("references/entertain-educate-sell.md"),
      "ideas.json": JSON.stringify(ideas, null, 1), "current.json": JSON.stringify(ranking()?.order ?? [], null, 1),
      "lessons.json": JSON.stringify(lessonsBrief(await syncLessons()), null, 1),
    }, 10 * 60_000);
  const order = (ans?.order ?? []).filter((o) => o?.id && Array.isArray(o.dups));
  if (order.length < 5) throw new Error("Claude didn't come back with a ranking. Is Claude Code signed in on this machine?");
  order.sort((a, b) => a.rank - b.rank).forEach((o, n) => { o.rank = n + 1; });
  // adjusted hooks: the idea itself changes (the old hook is kept on it)
  const repo = getRepo();
  for (const o of order as (Ranking["order"][number] & { hook?: string; adjusted?: string })[]) {
    if (!o.hook?.trim() || o.id.startsWith("map:")) continue;
    const [c] = await repo.list("content_items", { eq: { id: o.id } });
    if (!c) continue;
    const m = c.meta as Meta;
    if ((m.hook ?? c.caption ?? "") === o.hook.trim()) continue;
    await repo.update("content_items", { id: o.id }, { caption: o.hook.trim().slice(0, 300), meta: { ...c.meta, hook: o.hook.trim().slice(0, 300), hook_was: m.hook_was ?? m.hook ?? c.caption ?? "", adjusted_why: (o.adjusted ?? "").slice(0, 240) } });
    o.why = `${o.why}${o.adjusted ? ` Hook adjusted: ${o.adjusted}` : ""}`;
  }
  fs.writeFileSync(RANK_FILE, JSON.stringify({ ranked_at: new Date().toISOString(), by: "Claude (Re-rank)", order }, null, 1));
  return order.length;
}

export async function getIdea(id: string): Promise<Idea | null> {
  return (await listIdeas()).find((i) => i.id === id) ?? null;
}

/** The idea as a request the video makers can follow. */
export function ideaBrief(i: Idea): string {
  return [
    `Idea: ${i.title}.`, i.hook && `Hook: "${i.hook}".`, i.beats.length && `Beats: ${i.beats.join(" → ")}.`,
    i.cta && `Payoff / CTA: ${i.cta}.`, i.why && `Why it should work: ${i.why}`,
  ].filter(Boolean).join(" ");
}

/** Remember which batches were made from an idea, so its card shows it. */
export async function noteMade(ideaId: string, jobId: string) {
  if (ideaId.startsWith("map:")) return;
  const repo = getRepo();
  const [c] = await repo.list("content_items", { eq: { id: ideaId } });
  if (!c) return;
  const m = c.meta as Meta;
  await repo.update("content_items", { id: ideaId }, { meta: { ...c.meta, made_job: [...(m.made_job ?? []), jobId] } });
}

export async function addIdea(title: string, hook: string, channel: string): Promise<Idea> {
  const [row] = await getRepo().insert("content_items", [{
    id: `c-${Date.now().toString(36)}`, platform: channel === "tiktok" ? "tiktok" : "instagram", kind: "reel", status: "idea",
    title, caption: hook || null, media_url: null, scheduled_at: null, posted_at: null, views: null, likes: null, saves: null,
    shares: null, attributed_signups: null, source: "desk", meta: { hook, channel },
  }]);
  return fromItem(row);
}

const SKILL = path.resolve(process.cwd(), "../../packages/advisor/skill/marketing-advisor");
const read = (f: string) => { try { return fs.readFileSync(path.join(SKILL, f), "utf8"); } catch { return ""; } };
// how the brand sounds and how an ad flows: it wins over older hooks and tone notes
const voice = () => { try { return fs.readFileSync(path.resolve(process.cwd(), "../../services/reel-engine/knowledge/brand-voice.md"), "utf8"); } catch { return ""; } };

interface Generated { title: string; hook: string; tier: string; channel: string; pillar?: string; beats: string[]; cta: string; why: string }

/** New ideas from the marketing advisor skill (entertain / educate / sell), on the Max login. Added as ideas. */
export async function generateIdeas(focus: string, count = 5): Promise<Idea[]> {
  const repo = getRepo();
  const [items, map] = await Promise.all([repo.list("content_items"), repo.getMap()]);
  const have = items.filter((c) => c.status !== "posted").map((c) => c.title).filter(Boolean);
  const lessons = lessonsBrief(await syncLessons());
  const ans = await claudeLook<{ ideas?: Generated[] }>(
    `You are ${BRAND.name}'s marketing advisor. Follow SKILL.md and the references (especially entertain-educate-sell.md). brand-voice.md is how ${BRAND.name} sounds and how an ad flows: every hook and line you write follows it, and it wins over older notes.
Propose ${count} NEW, original video ideas${focus ? ` about: "${focus.replace(/"/g, "'")}"` : ""}. Don't repeat the existing ideas in existing.json.
Only use features the product really has (README / brand-voice.md say what they are). The brand is ${BRAND.name}: ${BRAND.pitch}.
Learn from lessons.json first (follow its how_to_weigh): build on the patterns that worked with real viewers, avoid the patterns they killed, and steer away from what the founder deleted.
Mix tiers unless the focus says otherwise. Answer {"ideas":[{"title","hook","tier":"entertain|educate|sell","channel":"ig_organic|ig_paid|tiktok",
"pillar":"${PILLARS.map((p) => p.id).join("|")}","beats":["3-5 short beats"],"cta","why"}]}.`,
    {
      "SKILL.md": read("SKILL.md"), "brand-voice.md": voice(), "entertain-educate-sell.md": read("references/entertain-educate-sell.md"),
      "channels.md": read("references/channels.md"),
      "taglines.json": JSON.stringify({ taglines: map.doc.taglines, strategy: map.doc.strategy }, null, 1),
      "existing.json": JSON.stringify(have, null, 1), "lessons.json": JSON.stringify(lessons, null, 1),
    }, 8 * 60_000);
  const ok = (ans?.ideas ?? []).filter((g) => g?.title && g.hook).slice(0, count);
  if (!ok.length) throw new Error("Claude didn't come back with ideas. Is Claude Code signed in on this machine?");
  const stamp = Date.now().toString(36);
  const rows = await repo.insert("content_items", ok.map((g, i) => ({
    id: `gen-${stamp}-${i}`, platform: g.channel === "tiktok" ? "tiktok" as const : "instagram" as const, kind: "reel" as const, status: "idea" as const,
    title: g.title, caption: g.hook, media_url: null, scheduled_at: null, posted_at: null, views: null, likes: null, saves: null, shares: null,
    attributed_signups: null, source: "advisor",
    meta: { hook: g.hook, tier: ["entertain", "educate", "sell"].includes(g.tier) ? g.tier : null, channel: g.channel,
      pillar: PILLARS.some((p) => p.id === g.pillar) ? g.pillar : null, beats: (g.beats ?? []).slice(0, 6), cta: g.cta, hypothesis: g.why },
  })));
  return rows.map(fromItem);
}

/** Archive (just tidying: no lesson) or put an idea back. */
export async function setArchived(id: string, on: boolean) { archiveIdea(id, on); }

/** The founder deleted an idea: gone from Ideas, and remembered as a light dislike. */
export async function removeIdea(id: string) {
  const i = (await listIdeas()).find((x) => x.id === id);
  if (!i) throw new Error("That idea isn't there any more.");
  deleteIdea(id, i.title, i.hook);
}
