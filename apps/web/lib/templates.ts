import "server-only";
import { getRepo, type ReelClip, type ReelJobRequest, type ReelRef } from "@engine/db";
import { batchStamp, hookRanking } from "./reels";
import { BRAND } from "./brand";

/**
 * Templates: whole edit recipes (structure, pacing, look, text, transitions, music behaviour) learned from
 * your style references. Drop footage, pick one or more templates, get one video per template.
 */
export interface Template {
  id: string; name: string; blurb: string;
  /** references this template was learned from */
  refs: { id: string; title: string; url: string | null }[];
  format: string; pacing: "fast" | "medium" | "cinematic"; grade: string; grain: boolean;
  text: "caption" | "hook_serif" | "stamp" | "hook"; tone: string;
  fx: "clean" | "playful"; buildDrop: boolean; letterbox: boolean; duration: number;
  /** why it does or doesn't suit the clips you picked, and what footage would make it right */
  fit: { ok: boolean; note: string; needs?: string };
  /** what a reference template is for, e.g. "Fast montage · inspirational" */
  purpose?: string | null;
  /** literal template copied from one reference video: its exact cuts, words and song */
  literal?: { refId: string; slots: number[]; turn: "cw" | "ccw" | null; fx: NonNullable<ReelRef["metrics"]["shot_fx"]> | null; lines: RefLineLook[]; song: string | null; file: string | null; url: string | null; audio: string | null; textOverride: ReelRef["metrics"]["text_override"] | null;
    /** every reel using this song, as sounds placed where each sits in it (stitched into a longer stretch of the song),
     * and where this template's own reel starts in it */
    parts: { audio: string; at: number }[]; at: number | null };
}

/** A reference's caption line, with the look measured from the reel (engine/reflook.py). */
type RefLineLook = NonNullable<ReelRef["metrics"]["lines"]>[number];

interface Recipe extends Omit<Template, "refs" | "fit" | "pacing"> {
  match: (r: ReelRef) => boolean;
  pacing?: Template["pacing"];
  needs: (c: ReelClip[]) => { ok: boolean; note: string };
}

const has = (r: ReelRef, re: RegExp) => re.test(`${r.notes ?? ""} ${r.title ?? ""}`.toLowerCase());
const many = (n: number) => (c: ReelClip[]) => (c.length >= n ? { ok: true, note: `${c.length} clips` } : { ok: false, note: `needs ${n}+ clips` });
const longShot = (c: ReelClip[]) => {
  const l = c.filter((x) => (x.duration ?? 0) >= 6);
  return l.length ? { ok: true, note: `holds on your ${Math.round(Math.max(...l.map((x) => x.duration ?? 0)))}s shot` } : { ok: false, note: "needs one clip of 6s+" };
};

const RECIPES: Recipe[] = [
  { id: "film-montage", name: "Cinematic film montage", blurb: "Beat-synced cuts, film color and grain, a caption per shot, the song's drop on the reveal.",
    match: (r) => r.format === "montage" && (r.metrics.look === "film" || has(r, /cinemat|color|colou?r/)),
    format: "montage", grade: "film", grain: true, text: "caption", tone: "cinematic", fx: "clean", buildDrop: true, letterbox: false, duration: 18, needs: many(4) },
  { id: "grid-montage", name: "Grid & mask montage", blurb: "Same rhythm with creative reveals: iris mask, tile squares and soft wipes where a cut suits them.",
    match: (r) => has(r, /grid|mask|square|transition|edit style|editing technique/),
    format: "montage", grade: "film", grain: true, text: "caption", tone: "playful", fx: "playful", buildDrop: true, letterbox: false, duration: 16, needs: many(5) },
  { id: "funny-montage", name: "Funny / call-out montage", blurb: "Bold stamp hook, quick cuts, warm color. Comedy timing over polish.",
    match: (r) => has(r, /funny|call-?out|nerd|humou?r/),
    format: "montage", grade: "golden", grain: false, text: "stamp", tone: "funny", fx: "clean", buildDrop: true, letterbox: false, duration: 15, pacing: "fast", needs: many(3) },
  { id: "oneshot-song", name: "One shot + song + text", blurb: "One great shot held the whole time, a serif line over it, the song does the work.",
    match: (r) => r.format === "oneshot",
    format: "oneshot", grade: "golden", grain: true, text: "hook_serif", tone: "warm", fx: "clean", buildDrop: false, letterbox: false, duration: 10, pacing: "cinematic", needs: longShot },
  { id: "memory-cinematic", name: "Cinematic memory", blurb: "Long holds, letterbox, film look. Feels like remembering the trip.",
    match: (r) => r.format === "cinematic" || has(r, /memory|nostalg|seasonal|atmosphere/),
    format: "cinematic", grade: "film", grain: true, text: "hook_serif", tone: "nostalgic", fx: "clean", buildDrop: false, letterbox: true, duration: 16, pacing: "cinematic", needs: many(3) },
  { id: "reveal", name: "Setup → reveal", blurb: "Hold the setup, cut to the payoff on the beat.",
    match: (r) => r.format === "reveal",
    format: "reveal", grade: "clean", grain: false, text: "hook", tone: "surprise", fx: "clean", buildDrop: true, letterbox: false, duration: 12, needs: many(2) },
  { id: "ad-dropin", name: "Ad: hook, quiet, drop", blurb: "Ad structure: call-out hook over a quiet start, drop on the product shot, CTA end card.",
    match: (r) => r.format === "ad" || has(r, /\bad\b|our ad|sponsored/),
    format: "montage", grade: "film", grain: true, text: "stamp", tone: "ad", fx: "clean", buildDrop: true, letterbox: false, duration: 17, pacing: "fast", needs: many(3) },
];

const paceFrom = (refs: ReelRef[], fallback: Template["pacing"]) => {
  const s = refs.map((r) => r.metrics.avg_shot).filter((x): x is number => !!x).sort((a, z) => a - z);
  if (!s.length) return fallback;
  const m = s[Math.floor(s.length / 2)];
  return m < 1.2 ? "fast" : m < 2.5 ? "medium" : "cinematic";
};

/** A reference that's been read (a dropped video, or a link watched by the reel reader) and isn't marked
 * "just learn from it" is a fixed template: its cuts, its words at the same moments, its song. */
export const isLiteral = (r: ReelRef) => (r.metrics.shot_lengths?.length ?? 0) > 0 && (r.file || r.metrics.read_at) && r.metrics.intent !== "learn";

/**
 * Can your clips fill this reel's cuts without repeating themselves, and if not, what to shoot or add.
 * A clip gives about one distinct shot per (its length / the template's typical cut), up to 3 (a long clip has a
 * few moments, not endless ones). The longest hold needs one clip at least that long; a one-shot needs it steady.
 */
export function footageFit(slots: number[], clips: ReelClip[], purpose: string | null): { ok: boolean; note: string; needs?: string } {
  if (!clips.length) return { ok: false, note: "check some clips first" };
  const sorted = [...slots].sort((a, z) => a - z);
  const typical = Math.max(0.8, sorted[Math.floor(sorted.length / 2)] ?? 1);
  const hold = Math.max(...slots);
  const shots = clips.reduce((n, c) => n + Math.max(1, Math.min(3, Math.floor((c.duration ?? 0) / Math.max(typical * 1.5, 1.2)))), 0);
  const longest = Math.max(...clips.map((c) => c.duration ?? 0));
  const kind = (purpose ?? "").toLowerCase();
  const what = kind.includes("fast") ? "short, varied moments (movement, details, people)"
    : kind.includes("text story") || kind.includes("cinematic") ? "calm, wide shots you can hold on (5s+ each)"
    : kind.includes("talking") ? "you talking to camera"
    : "different moments from the trip";
  if (slots.length === 1) {
    return longest + 0.3 >= hold ? { ok: true, note: `one ${Math.round(hold)}s shot from your longest clip` }
      : { ok: false, note: `needs one steady clip of ${Math.ceil(hold)}s+ (your longest is ${Math.round(longest)}s)`, needs: `one steady ${Math.ceil(hold)}s+ shot` };
  }
  const missing = slots.length - shots;
  const tooShort = longest + 0.3 < hold;
  if (missing <= Math.ceil(slots.length * 0.15) && !tooShort) return { ok: true, note: `${slots.length} cuts from your ${clips.length} clips` };
  const parts = [
    missing > 0 ? `about ${missing} more shot${missing > 1 ? "s" : ""}: ${what}` : "",
    tooShort ? `one clip of ${Math.ceil(hold)}s+ for its longest hold` : "",
  ].filter(Boolean);
  // still makes it (shots repeat / the hold is cut short), but says what would make it right
  return { ok: missing < slots.length * 0.5 && !tooShort, note: `works, but needs ${parts.join(" and ")}`, needs: parts.join("; ") };
}

/** One template per song: references sharing a song (heard or named the same, metrics.song_key) merge into one, cut
 * from the longest reel, with every reel's sound joined into a longer stretch of the song. */
function literalTemplates(refs: ReelRef[], clips: ReelClip[]): Template[] {
  const songs = new Map<string, ReelRef[]>();
  for (const r of refs.filter(isLiteral)) {
    const k = r.metrics.song_key ?? r.id;
    songs.set(k, [...(songs.get(k) ?? []), r]);
  }
  return [...songs.values()].map((group) => {
    const r = [...group].sort((a, z) => (z.metrics.duration ?? 0) - (a.metrics.duration ?? 0))[0];
    const parts = group.flatMap((x) => {
      const audio = x.metrics.audio ?? x.file;
      return audio && x.metrics.song_at != null ? [{ audio: `input/${audio.replace(/^input\//, "")}`, at: x.metrics.song_at }] : [];
    });
    const slots = r.metrics.shot_lengths!;
    const lines = r.metrics.lines?.length ? r.metrics.lines : r.metrics.hook ? [{ shot: 0, text: r.metrics.hook, pos: "top" as const }] : [];
    return {
      id: `ref-${r.id}`, name: r.title ?? "Reference", purpose: r.metrics.purpose ?? null, literal: { refId: r.id, slots, turn: r.metrics.turn ?? null, fx: r.metrics.shot_fx ?? null, lines, song: r.metrics.song ?? null, file: r.file, url: r.url, audio: r.metrics.audio ?? null, textOverride: r.metrics.text_override ?? null, parts, at: r.metrics.song_at ?? null },
      blurb: `${group.length > 1 ? `One template for this song, from ${group.length} reels: cut like` : "Copies"} this reel: ${slots.length === 1 ? "one held shot" : `${slots.length} cuts`} over ${Math.round(r.metrics.duration ?? 0)}s${lines.length ? `, ${lines.length} text line${lines.length > 1 ? "s" : ""} at the same moments` : ""}, timed to its song${r.metrics.song ? ` (${r.metrics.song})` : ""}, flexing shot lengths on the beat to your footage.`,
      refs: group.map((x) => ({ id: x.id, title: x.title ?? x.file ?? x.url ?? x.id, url: x.url })),
      format: slots.length === 1 ? "oneshot" : "montage", pacing: (r.metrics.pacing ?? "medium") as Template["pacing"], grade: r.metrics.look ?? "film", grain: true,
      text: "caption", tone: "reference", fx: "clean", buildDrop: false, letterbox: false, duration: Math.round(r.metrics.duration ?? 15),
      fit: footageFit(slots, clips, r.metrics.purpose ?? null),
    };
  });
}

/** Library template a reference's style maps to (engine/edit_rules.py ids), from its format and your notes. */
export function baseFor(r: ReelRef): string {
  const n = `${r.notes ?? ""} ${r.title ?? ""}`.toLowerCase();
  if (r.format === "oneshot" || r.format === "talking") return "hero-oneshot";
  if (r.format === "ad") return "quiet-drop";
  if (/grid|mask|square|transition|editing technique/.test(n)) return "grid-mask";
  if (/funny|humou?r|call-?out/.test(n)) return "cant-all-be-in";
  if (r.format === "reveal") return "transition-chain";
  if (r.format === "list" || /carousel|photo|slideshow|dump/.test(n)) return "beat-photo-dump";
  if (r.format === "cinematic" || /memory|nostalg|seasonal|atmosphere/.test(n)) return "memory-film";
  if (/slow|diary|calm|walk/.test(n)) return "slow-travel-diary";
  if (/cut|sync|beat|exciting|fast/.test(n)) return "beat-photo-dump";
  return "memory-film";
}

export interface StyleTemplate {
  id: string; refId: string; name: string; base: string; url: string | null; hook: string | null; look: string | null;
  song: string | null; notes: string | null; format: string;
  /** Not read from its link yet: styled on the closest structure until the reel reader gets to it. */
  thin: boolean;
}

/** One template per reference link: its structure from the closest library template, its own hook, look and song. */
export function styleTemplates(refs: ReelRef[]): StyleTemplate[] {
  // links not read yet (or that couldn't be read): styled on the closest structure until the reader gets them
  return refs.filter((r) => !isLiteral(r) && r.metrics.intent !== "learn").map((r) => ({
    id: `style-${r.id}`, refId: r.id, name: r.title ?? r.url ?? r.id, base: baseFor(r), url: r.url,
    hook: r.metrics.hook ?? null, look: r.metrics.look ?? null, song: r.metrics.song ?? null, notes: r.notes, format: r.format,
    thin: !r.metrics.hook && !r.metrics.song && !(r.metrics.shot_lengths?.length ?? 0),
  })).sort((a, z) => Number(a.thin) - Number(z.thin));
}

export function buildTemplates(refs: ReelRef[], clips: ReelClip[]): Template[] {
  return [...literalTemplates(refs, clips), ...buildRecipes(refs, clips)];
}

function buildRecipes(refs: ReelRef[], clips: ReelClip[]): Template[] {
  return RECIPES.flatMap(({ match, needs, ...r }) => {
    const from = refs.filter(match);
    if (!from.length) return [];
    const looks = new Map<string, number>();
    for (const x of from) if (x.metrics.look) looks.set(x.metrics.look, (looks.get(x.metrics.look) ?? 0) + 1);
    const grade = [...looks].sort((a, z) => z[1] - a[1])[0]?.[0] ?? r.grade;
    return [{
      ...r, grade, pacing: r.pacing ?? paceFrom(from, "medium"), fit: needs(clips),
      refs: from.slice(0, 12).map((x) => ({ id: x.id, title: x.title ?? x.url ?? x.id, url: x.url })),
    }];
  }).sort((a, z) => Number(z.fit.ok) - Number(a.fit.ok) || z.refs.length - a.refs.length);
}

export async function templatesFor(clipIds: string[]) {
  const repo = getRepo();
  const [refs, clips] = await Promise.all([repo.list("reel_refs"), repo.list("reel_clips")]);
  return buildTemplates(refs, clips.filter((c) => clipIds.includes(c.id)));
}


// places a reel's text might name; a line naming one that isn't yours would be untrue on your footage
const PLACES = new Set(("japan tokyo kyoto osaka italy rome florence venice milan amalfi naples sicily france paris nice " +
  "spain barcelona madrid seville portugal lisbon porto greece athens santorini mykonos croatia dubrovnik split " +
  "germany berlin munich austria vienna salzburg switzerland zurich geneva swiss netherlands amsterdam belgium " +
  "brussels uk london england scotland edinburgh ireland dublin iceland norway oslo sweden stockholm denmark " +
  "copenhagen finland prague czech budapest hungary poland krakow turkey istanbul morocco marrakech egypt cairo " +
  "dubai thailand bangkok bali indonesia vietnam hanoi singapore korea seoul china beijing india mumbai delhi " +
  "nepal australia sydney melbourne zealand mexico tulum cancun peru brazil rio argentina colombia cuba usa " +
  "america nyc york california la miami hawaii oahu maui canada toronto vancouver georgia tbilisi boston " +
  "europe asia africa caribbean bahamas maldives philippines yamaguchi hokkaido okinawa").split(" "));

/** True of your footage: names no place other than the one you gave (a quote naming a person is fine). */
export function fitsFootage(text: string, place?: string): boolean {
  const mine = new Set((place ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean));
  // OCR doubles letters now and then ("JAPANN"): a word one doubled letter away from a place counts as that place
  const placeOf = (w: string) => {
    const once = w.replace(/(\p{L})\1/u, "$1");
    return PLACES.has(w) ? w : PLACES.has(once) ? once : null;
  };
  return text.toLowerCase().split(/[^\p{L}]+/u).every((w) => { const p = placeOf(w); return !p || mine.has(p); });
}

/** One video per template, all from the same clips. A hook is optional: without one, each template gets a different top-ranked hook. */
export async function templateJob(input: { templateIds: string[]; clipIds: string[]; hook?: string; music?: string[]; place?: string }): Promise<ReelJobRequest> {
  const repo = getRepo();
  const [refs, clips, hooks, rank] = await Promise.all([repo.list("reel_refs"), repo.list("reel_clips"), repo.list("reel_hooks"), hookRanking()]);
  const picked = clips.filter((c) => input.clipIds.includes(c.id));
  const all = buildTemplates(refs, picked);
  const chosen = all.filter((t) => input.templateIds.includes(t.id));
  const pool = hooks.filter((h) => h.status !== "retired" && !/\[[^\]]+\]/.test(h.text)).sort((a, z) => (rank[a.id]?.rank ?? 9) - (rank[z.id]?.rank ?? 9));
  const longest = [...picked].sort((a, z) => (z.duration ?? 0) - (a.duration ?? 0))[0];
  // a one-shot runs on one clip: your star, else the one Claude rated best among the long ones, else the longest
  const rated = picked.filter((c) => c.read && !c.read.skip && (c.duration ?? 0) >= (longest?.duration ?? 0) * 0.5).sort((a, z) => z.read!.rating - a.read!.rating)[0];
  const hero = picked.find((c) => c.star) ?? rated ?? longest;
  const stamp = batchStamp();
  return {
    job_id: `tpl-${stamp}`,
    clips: picked.map((c) => ({ id: c.id, path: c.file, star: c.star, tags: c.tags, ...(c.read ? { read: c.read } : {}) })),
    defaults: { endcard: true, cta: process.env.BRAND_CTA || "Learn more", hashtags: [BRAND.niche, BRAND.name].map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean), transitions_style: "clean", natural: "auto" },
    variants: chosen.flatMap<Record<string, unknown>>((t, i) => {
      if (t.literal) {
        const L = t.literal;
        // each line stays up over the shots it covered in the reel, in the same place, at about the same size
        const bounds = L.slots.reduce<number[]>((a, x) => [...a, a[a.length - 1] + x], [0]);
        const shotAt = (t: number) => Math.max(0, bounds.findIndex((b, k) => k < L.slots.length && t >= b && t < bounds[k + 1]));
        // the template's text is the reel's own words, in its own typeface, colour, size and place on screen.
        // A line naming a place that isn't yours ("…in Japan") is skipped: it would be untrue on your footage.
        // a "turn your phone" reel is composed wide (1920x1080) and turned; its text was read the right way up, so
        // its place and size are shares of that wide frame
        const lineSet = (wide: boolean) => L.lines.filter((l) => fitsFootage(l.text, input.place)).map((l) => {
          const look = l.look ? { ...l.look, ...(L.textOverride ?? {}) } : null;  // your fix on the reference card wins
          const [fw, fh] = wide ? [1920, 1080] : [1080, 1920];
          const k = wide ? 1080 / 1920 : 1;  // sizes were measured against a 1920-tall frame
          return {
            text: l.text, shot: l.shot, ...(l.t1 != null ? { to: Math.max(l.shot, shotAt(l.t1)) } : {}), ...(l.t != null ? { at: l.t, until: l.t1 ?? l.t } : {}),
            // its place in the reel (across and down); the engine nudges it only if it won't read over your shot
            pos: look?.y != null ? [Math.round((look.x ?? 0.5) * fw), Math.round(look.y * fh)] : l.pos === "bottom" ? "lower" : l.pos ?? "top",
            style: look ? { font: look.font, size: look.size.map((v) => Math.round(v * k)), upper: look.upper, fill: look.fill, box: look.box, stroke: look.stroke, shadow: look.shadow, lh: look.lh ?? 1.1 }
              : (l.size ?? 0.05) < 0.04 ? "serif" : "caption",
            anim: "fade",
          };
        });
        // its own sound: the dropped video's audio, or the sound pulled from the reel; the cuts are timed to it
        const music = input.music?.length ? input.music[i % input.music.length] : L.audio ? `input/${L.audio.replace(/^input\//, "")}` : L.file ? `input/${L.file}` : null;
        const one = (id: string, wide: boolean) => ({
          id, format: "montage", slots: L.slots, ...(L.fx ? { shot_fx: L.fx } : {}), lines: lineSet(wide), hook: "",
          ...(wide && L.turn ? { sideways: L.turn } : {}), grade: t.grade, grain: true, transitions_style: "clean", sfx: false,
          endcard: false, cta: "",  // an exact copy of a reel keeps its own ending; the app goes in the caption
          // a dropped reference's own audio keeps the preview in sync; a link's song is added in-app on the _bare cut
          ...(music ? { music, music_start: 0 } : { natural: "auto" }), ...(L.song ? { song_to_add: L.song } : {}),
          // the song's other reels extend its sound, so the edit can run on instead of replaying
          ...(music && !input.music?.length && L.parts.length > 1 && L.at != null ? { music_parts: L.parts, music_at: L.at } : {}),
          template: t.id, styled_after: [L.refId],
        });
        // a "turn your phone" reel: one cut exactly like it (sideways), one upright, to compare
        return L.turn ? [one(t.id, true), one(`${t.id}-upright`, false)] : [one(t.id, false)];
      }
      const h = input.hook?.trim() ? { id: "custom", text: input.hook.trim() } : pool[i % Math.max(pool.length, 1)];
      const song = input.music?.length ? input.music[i % input.music.length] : null;  // no stock music, ever
      return {
        id: t.id, format: t.format, pacing: t.pacing, grade: t.grade, grain: t.grain, fx: t.fx, duration: t.duration,
        hook: h?.text ?? "", hook_id: h?.id, hook_style: t.text, music: song, build_drop: t.buildDrop,
        ...(t.letterbox ? { letterbox: true } : {}), ...(t.format === "oneshot" && hero ? { hero: hero.id, clips: [hero.id] } : {}),
        template: t.id, styled_after: t.refs.slice(0, 3).map((r) => r.id),
      };
    }),
  };
}
