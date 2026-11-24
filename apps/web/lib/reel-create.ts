import "server-only";
import { getRepo, type ReelClip, type ReelJobRequest } from "@engine/db";
import type { Library } from "@engine/connectors";
import { claudeLook } from "./claude-look";
import { submitWhenRead } from "./clip-reader";
import { batchStamp, engine } from "./reels";
import { buildTemplates, templateJob } from "./templates";
import { BRAND } from "./brand";

/**
 * Make what was asked for, from one sentence: Claude (headless Claude Code on the Max login, no API key) reads what we
 * know (engine knowledge/*.md), the asset library (footage with places, our phone shots, app screens), your clip bin
 * with its reads, the references and templates, and any videos you attached; it writes the ads, reels or carousels as
 * briefs, and the engine renders them as one new batch. Placeholders stand in for shots we don't have.
 */
export type CreateKind = "auto" | "ad" | "reel" | "carousel";
export interface Creation {
  id: string; ask: string; kind: CreateKind; at: number;
  status: "thinking" | "rendering" | "done" | "error";
  plan?: string; needs?: string[]; note?: string; job_id?: string; error?: string; made?: number;
}

// on globalThis so a dev reload keeps what's running
const C = ((globalThis as { __creations?: Map<string, Creation> }).__creations ??= new Map<string, Creation>());

export function creations(): Creation[] {
  return [...C.values()].sort((a, z) => z.at - a.at).slice(0, 8);
}

/** Show work made outside Claude's brief (a story doc render) in Make's "Making" list. */
export function trackCreation(ask: string): Creation {
  const c: Creation = { id: `ask-${batchStamp()}`, ask, kind: "reel", at: Date.now(), status: "thinking" };
  C.set(c.id, c);
  return c;
}

export function startCreation(ask: string, kind: CreateKind, count: number, clipIds: string[], attached: string[]): Creation {
  const c: Creation = { id: `ask-${batchStamp()}`, ask, kind, at: Date.now(), status: "thinking" };
  C.set(c.id, c);
  run(c, Math.min(Math.max(count, 1), 6), clipIds, attached).catch((e) => Object.assign(c, { status: "error", error: (e as Error).message.replace(/^\d+ [\w ]+: /, "") }));
  return c;
}

type Brief = Record<string, unknown>;
interface Answer {
  plan?: string; note?: string; needs?: string[];
  make?: { id: string; kind: "phone" | "placeholder" | "placeholder_screen"; screen?: string; bg: string; bg_start?: number; dur?: number; text?: string }[];
  videos?: Brief[]; carousels?: Brief[]; templates?: { template: string; clips: string[]; hook?: string }[];
}

const KINDS: Record<CreateKind, string> = {
  auto: "whatever fits the request best (ad, brand reel or carousel)",
  ad: "product ads (paid reels)", reel: "brand reels for Instagram", carousel: "carousel posts",
};

const GUIDE = (kind: CreateKind, count: number) => `# Making ${BRAND.name} content from a request

Make ${count} piece${count > 1 ? "s" : ""}: ${KINDS[kind]}. If the request names a number or a kind, follow the request.

## Files
- KNOWLEDGE.md: everything we've learned (product truth, the three kinds of content, ad formats that worked, hooks,
  structure). Follow it.
- library.json + library.jpg: real footage (with where and when it was shot), ready-made phone shots ("phone", our phone
  over a real shot showing a real app screen) and app screens ("screen", to put in our phone over ANY clip).
- bin.json: your clip bin, with Claude's read of each clip (rating, what's in it, best moments, hold/quick). Clips
  marked "picked" were chosen for this request: build from them first. "attached" clips came with this request
  (attached_N.jpg shows each one over time).
- references.json and templates.json: the reels we study, and the trend templates built from them (brand reels).
- music.json: songs you may use (ads use the happy-beats-business-moves beds).

## Answer: one JSON object
{
 "plan": "2-3 sentences: what you're making, which format from KNOWLEDGE.md, and why someone would share it",
 "make": [clips to make first, each used by id like any clip:
   {"id": "m1", "kind": "phone", "screen": "<screen id>", "bg": "<clip or library id>", "bg_start": s, "dur": s}
   {"id": "m2", "kind": "placeholder", "text": "what to film", "bg": "<clip id for the backdrop>", "dur": s}
   {"id": "m3", "kind": "placeholder_screen", "text": "app screen to record", "bg": "<clip id>", "dur": s}],
 "videos": [video briefs (ads, or reels you direct shot by shot):
   {"id": "short-kebab-id", "format": "montage", "duration": 12-20, "music": "<path from music.json>", "sfx": true,
    "pacing": "cinematic", "grade": "film", "transitions": "cut", "transitions_style": "clean",
    "hook": "...", "hook_pos": "upper",
    "sequence": [{"clip": id, "beats": n, "start": s}, ...],   shot n lasts n beats; the first shot 8+ beats
    "lines": [{"text", "shot": i, "to"?: j, "pos"?: "top|center|lower", "style"?: "pill|hook"}],
    "build_drop"?: true, "drop_shot"?: k,
    "endcard": "${BRAND.name}|tagline", "cta": "real action", "endcard_hold": 2.6,
    "caption": "why someone sends it to a friend + who to send it to", "hashtags": [${BRAND.niche ? JSON.stringify(BRAND.niche) : ""}, ...]}],
 "templates": [brand reels from a trend template: {"template": "<id from templates.json>", "clips": [bin clip ids], "hook"?: "..."}],
 "carousels": [{"id": "...", "format": "carousel", "caption": "...", "hashtags": [...],
   "slides": [{"clip": id, "t": seconds into the clip, "text": "...", "sub"?: "...", "style"?: "hook|pill|caption|stamp",
              "pos"?: "top|center|lower", "screen"?: "<screen id: our phone shows it on this slide>", "screen_t"?: s}],
   "endcard": "${BRAND.name}|tagline", "cta": "..."}],
 "needs": ["shots or app screens that would make this better, plainly"],
 "note": "only if part of the request couldn't be done, and why"
}
Use only ids that exist in library.json, bin.json or your own "make" list. Leave out the keys you don't use.

## Timing and legibility (the engine flags anything that breaks these)
- Open on real footage, never on a phone or placeholder: the hook is big white type and can't sit over a bright screen.
  Lines over a phone shot go at "top" as a pill.
- A shot carrying a line of n words needs about 0.3n + 1 seconds; a beat is about 0.5 s, so give it at least
  0.6n + 2 beats. Quick 2-beat shots carry no text.
- No line on the last shot before the end card unless that shot has the beats for it.
- Keep the end-card tagline to 6 words or fewer (the engine holds it long enough to read).`;

const pickRead = (c: ReelClip) => c.read && !c.read.skip ? {
  rating: c.read.rating, subject: c.read.subject, scene: c.read.scene, best_for: c.read.best_for,
  moments: c.read.moments.slice(0, 3).map((m) => ({ t0: m.t0, t1: m.t1, why: m.why })),
} : c.read?.skip ? { skip: true } : null;

const words = (s: unknown) => (typeof s === "string" ? s.trim().split(/\s+/).filter(Boolean).length : 0);

/** Make a video brief readable before it renders: the opening shot outlasts the hook, each shot with a line has the
 * beats to read it (about 0.5 s a beat), and the end card stays up long enough for its tagline and button. */
function readable(v: Brief) {
  const seq = (v.sequence as { clip: string; beats: number }[] | undefined) ?? [];
  if (!seq.length) return;
  const need = (n: number) => Math.ceil(0.6 * n + 2);
  if (v.hook) seq[0].beats = Math.max(seq[0].beats || 0, need(words(v.hook)), 8);
  for (const l of (v.lines as { text: string; shot: number; to?: number }[] | undefined) ?? []) {
    const span = seq.slice(l.shot, (l.to ?? l.shot) + 1);
    const have = span.reduce((a, s) => a + (s.beats || 0), 0);
    if (span.length && have < need(words(l.text))) span[span.length - 1].beats += need(words(l.text)) - have;
  }
  const [, tag = ""] = String(v.endcard ?? "").split("|");
  if (v.endcard) v.endcard_hold = Math.max(Number(v.endcard_hold) || 0, 2.6, Math.round((0.3 * words(tag) + 1.2 + (v.cta ? 0.8 : 0)) * 10) / 10);
  const beats = seq.reduce((a, s) => a + (s.beats || 0), 0);
  v.duration = Math.min(Math.max(Number(v.duration) || 0, beats * 0.5 + Number(v.endcard_hold ?? 0)), 30);
}

async function run(c: Creation, count: number, clipIds: string[], attached: string[]) {
  const e = engine();
  if (e.stub) throw new Error("The request box needs the engine running (VIDEO_ENGINE_URL).");
  const repo = getRepo();
  const [lib, bin, refs, music] = await Promise.all([e.library(), repo.list("reel_clips"), repo.list("reel_refs"), e.listMusic()]);
  const picked = new Set([...clipIds, ...attached]);
  const usable = bin.filter((x) => !x.read?.skip || picked.has(x.id))
    .sort((a, z) => Number(picked.has(z.id)) - Number(picked.has(a.id)) || (z.read?.rating ?? 0) - (a.read?.rating ?? 0)).slice(0, 120);
  const templates = buildTemplates(refs, usable.filter((x) => picked.size ? picked.has(x.id) : true))
    .map((t) => ({ id: t.id, name: t.name, purpose: t.purpose ?? t.blurb, format: t.format, pacing: t.pacing, fits_these_clips: t.fit.ok, fit_note: t.fit.note }));
  const sheets = await Promise.all(attached.slice(0, 4).map(async (id) => {
    const clip = bin.find((x) => x.id === id);
    return clip ? e.clipSheet(clip.file).catch(() => null) : null;
  }));
  const files: Record<string, Buffer | string> = {
    "GUIDE.md": GUIDE(c.kind, count),
    "KNOWLEDGE.md": lib.knowledge.map((k) => k.text).join("\n\n"),
    "library.json": JSON.stringify(lib.items, null, 1),
    ...(lib.sheet ? { "library.jpg": Buffer.from(lib.sheet, "base64") } : {}),
    "bin.json": JSON.stringify(usable.map((x) => ({
      id: x.id, file: x.file, duration: x.duration, kind: x.kind, star: x.star || undefined,
      picked: picked.has(x.id) || undefined, attached: attached.includes(x.id) || undefined, read: pickRead(x),
    })), null, 1),
    "references.json": JSON.stringify(refs.slice(0, 80).map((r) => ({ id: r.id, title: r.title, format: r.format, notes: r.notes, purpose: r.metrics.purpose, look: r.metrics.look, pacing: r.metrics.pacing })), null, 1),
    "templates.json": JSON.stringify(templates, null, 1),
    "music.json": JSON.stringify(music.map((m) => ({ path: m.path, name: m.name, source: m.source })), null, 1),
    ...Object.fromEntries(sheets.flatMap((s, i) => (s ? [[`attached_${i + 1}.jpg`, Buffer.from(s.jpg, "base64")]] : []))),
  };
  const ans = await claudeLook<Answer>(
    `You make ${BRAND.name}'s ads, reels and carousels. The request: "${c.ask.replace(/"/g, "'")}".
Read GUIDE.md and KNOWLEDGE.md first, then look at the other files, and answer as GUIDE.md says.`, files, 12 * 60_000);
  if (!ans) throw new Error("Claude didn't answer. Is Claude Code signed in on this machine?");
  Object.assign(c, { plan: ans.plan, needs: ans.needs ?? [], note: ans.note });

  // only ids that exist: the bin, the library, or clips this answer makes
  const binIds = new Map(bin.map((x) => [x.id, x]));
  const libIds = new Set(lib.items.map((x) => x.id));
  const make = (ans.make ?? []).filter((m) => m.id && (binIds.has(m.bg) || libIds.has(m.bg)) && (m.kind !== "phone" || libIds.has(m.screen ?? "")));
  const known = (id: unknown) => typeof id === "string" && (binIds.has(id) || libIds.has(id) || make.some((m) => m.id === id));
  const bad: string[] = [];
  const videos = (ans.videos ?? []).filter((v) => {
    const ids = ((v.sequence as { clip: string }[] | undefined) ?? []).map((x) => x.clip);
    const ok = ids.length > 0 && ids.every(known);
    if (!ok) bad.push(String(v.id));
    return ok;
  });
  const carousels = (ans.carousels ?? []).filter((v) => {
    const sl = (v.slides as { clip: string; screen?: string }[] | undefined) ?? [];
    const ok = sl.length > 0 && sl.every((s) => known(s.clip) && (!s.screen || libIds.has(s.screen)));
    if (!ok) bad.push(String(v.id));
    return ok;
  }).map((v): Brief => ({ ...v, format: "carousel" }));
  if (bad.length) c.note = [c.note, `Skipped ${bad.join(", ")}: it named clips that don't exist.`].filter(Boolean).join(" ");
  for (const v of videos) readable(v);

  // the bin clips the briefs use (library clips and made clips are resolved by the engine)
  const used = new Set<string>();
  for (const v of videos) for (const x of (v.sequence as { clip: string }[])) used.add(x.clip);
  for (const v of carousels) for (const s of (v.slides as { clip: string }[])) used.add(s.clip);
  for (const m of make) used.add(m.bg);
  const request: ReelJobRequest = {
    job_id: c.id,
    clips: [...used].filter((id) => binIds.has(id)).map((id) => {
      const x = binIds.get(id)!;
      return { id: x.id, path: x.file, star: x.star, tags: x.tags, ...(x.read ? { read: x.read } : {}) };
    }),
    defaults: { hashtags: [BRAND.niche, BRAND.name].map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean) },
    variants: [...videos, ...carousels].map((v) => ({ ...v, test_tags: { ask: c.ask.slice(0, 200) } })),
    ...(make.length ? { make } : {}),
  };
  for (const t of (ans.templates ?? []).filter((t) => t.template && t.clips?.every((id) => binIds.has(id)))) {
    const tj = await templateJob({ templateIds: [t.template], clipIds: t.clips, hook: t.hook }).catch(() => null);
    if (!tj?.variants?.length) continue;
    for (const cl of tj.clips) if (!request.clips.some((x) => x.id === cl.id)) request.clips.push(cl);
    request.variants!.push(...tj.variants.map((v) => ({ ...v, test_tags: { ask: c.ask.slice(0, 200) } })));
  }
  if (!request.variants!.length) {
    Object.assign(c, { status: "done", made: 0, note: c.note || ans.note || "Claude made nothing for this request." });
    return;
  }
  const created = await submitWhenRead(request);
  await repo.insert("reel_jobs", [{ job_id: created.job_id, status: created.status, created_at: new Date().toISOString(), request, manifest: null, error: null, stub: false }]);
  Object.assign(c, { status: "rendering", job_id: created.job_id, made: request.variants!.length });
}

/** The desk's job sync marks the batch done; this keeps the box's status in step with it. */
export async function refreshCreations() {
  const repo = getRepo();
  for (const c of C.values()) {
    if (c.status !== "rendering" || !c.job_id) continue;
    const [j] = await repo.list("reel_jobs", { eq: { job_id: c.job_id } });
    if (j?.status === "done") c.status = "done";
    if (j?.status === "error") Object.assign(c, { status: "error", error: j.error ?? "render failed" });
  }
}
