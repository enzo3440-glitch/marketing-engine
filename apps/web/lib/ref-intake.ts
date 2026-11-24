import "server-only";
import { getRepo, REF_ASPECTS, type RefAspect, type ReelRef } from "@engine/db";
import { gradeFor, parseMeta, readAudio, readMetas, readReel, readSounds, type ReelMeta } from "./reel-reader";
import { reelTurn } from "./claude-look";
import { engine } from "./reels";

/**
 * What you want from a reference, from the choice you made or what you wrote in its note:
 * "make a template" (default) = a fixed template your clips are fitted to (its cuts, text, song);
 * "learn the color / editing technique / text / music" = only those parts feed the other edits.
 */
export function intentFrom(notes: string | null | undefined, chosen?: { intent?: string; learn?: string[] }): { intent: "template" | "learn"; learn: RefAspect[] } {
  const asked = (chosen?.learn ?? []).filter((a): a is RefAspect => REF_ASPECTS.includes(a as RefAspect));
  // "both": a fixed template that also teaches (its parts feed your other edits)
  if (chosen?.intent === "both") return { intent: "template", learn: asked.length ? asked : [...REF_ASPECTS] };
  if (chosen?.intent === "template" || chosen?.intent === "learn") return { intent: chosen.intent, learn: chosen.intent === "learn" ? (asked.length ? asked : [...REF_ASPECTS]) : asked };
  const n = (notes ?? "").toLowerCase();
  const learn = new Set<RefAspect>(asked);
  if (/colou?r|grade|grading|tone|look\b|film look/.test(n)) learn.add("color");
  if (/technique|transition|cuts?\b|cutting|editing|pacing|grid|mask|timeline|rhythm/.test(n)) learn.add("cuts");
  if (/\btext\b|font|caption|hook|typography/.test(n)) learn.add("text");
  if (/song|music|audio|sound|sync/.test(n)) learn.add("music");
  const wantsTemplate = /template|copy (it|this)|recreate|same edit|exact|literal/.test(n);
  const onlyLearn = /\blearn|just (the|for)|only (the|for)|inspiration|technique called/.test(n);
  if (!wantsTemplate && onlyLearn && learn.size) return { intent: "learn", learn: [...learn] };
  return { intent: "template", learn: [] };
}

/** References the trend research adds ("Style: … Adapt: …") teach by default; one that's popping off is templated too. */
export const POPPING_LIKES = 10_000;
export function researchIntent(ref: ReelRef): { intent: "template" | "learn"; learn: RefAspect[] } | null {
  if (!/^Style:/.test(ref.notes ?? "") || ref.metrics.intent) return null;
  return { intent: (ref.metrics.likes ?? 0) >= POPPING_LIKES ? "template" : "learn", learn: [...REF_ASPECTS] };
}

// ---- titles and "what it's for" -----------------------------------------------------------------------------

/** Titles made from a link ("reels / DeC1mDNAjts") get replaced by a summary; one you typed never does. */
export const autoTitle = (t: string | null | undefined) => !t || /^[\w.-]+ \/ [\w-]+$/.test(t.trim());

/** A short title from the reel's own caption: its first real sentence, hashtags / mentions / emoji dropped. */
export function summarize(caption: string | null | undefined, fallback?: string | null): string | null {
  const clean = (caption ?? "").replace(/https?:\/\/\S+/g, " ").replace(/[#@][\w.]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}‍️]/gu, " ").replace(/[ \t]+/g, " ").trim();
  const sentence = clean.split(/(?<=[.!?])\s+|\n/).map((x) => x.trim().replace(/[.!?…]+$/, "")).find((x) => x.split(" ").length >= 3) ?? clean;
  const words = sentence.split(" ").filter(Boolean);
  if (words.length >= 2) return words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : words.join(" ");
  return fallback?.trim() || null;
}

const MOODS: [RegExp, string][] = [
  [/inspir|motivat|dream|live (your|a) life/, "inspirational"], [/funny|humou?r|lol|joke|call-?out|nerd/, "funny"],
  [/calm|slow|peace|quiet|relax/, "calm"], [/cinemat|film look/, "cinematic"], [/memor|nostalg|remember|miss/, "nostalgic"],
  [/exciting|hype|energy|fast/, "hype"], [/love|romant|couple/, "romantic"], [/adventur|hike|explore|wild/, "adventure"],
  [/guide|tips?|how to|itinerar|list/, "guide"],
];

/** What a reference is for, from what the reader measured plus the mood in your note and its caption. */
export function purposeOf(m: ReelRef["metrics"], notes: string | null, format: string): string {
  const shots = m.shots ?? 0, avg = m.avg_shot ?? 0, lines = m.lines?.length ?? 0;
  const kind = /photo post/.test(m.read_error ?? "") ? "Photo carousel"
    : format === "talking" ? "Talking to camera"
    : shots === 1 ? (lines ? "One shot + text" : "One shot")
    : lines >= 3 && avg >= 1 ? "Text story montage"
    : avg && avg < 0.8 ? "Fast montage"
    : m.pacing === "cinematic" || format === "cinematic" ? "Cinematic montage"
    : shots ? "Montage" : format === "oneshot" ? "One shot" : "Montage";
  const text = `${notes ?? ""} ${m.caption ?? ""}`.toLowerCase();
  const moods = MOODS.filter(([re]) => re.test(text)).map(([, label]) => label).filter((x) => !kind.toLowerCase().includes(x)).slice(0, 2);
  return [kind, ...moods].join(" · ");
}

/** Caption, account, likes, title and purpose for a reference (the title only if it was made from the link). */
function describe(ref: ReelRef, m: ReelRef["metrics"], meta: ReelMeta | null): { metrics: ReelRef["metrics"]; title?: string } {
  const metrics: ReelRef["metrics"] = {
    ...m, ...(meta?.caption ? { caption: meta.caption } : {}), ...(meta?.account ? { account: meta.account } : {}),
    ...(meta?.likes != null ? { likes: meta.likes } : {}),
  };
  metrics.purpose = purposeOf(metrics, ref.notes, ref.format);
  const title = autoTitle(ref.title) ? summarize(metrics.caption, metrics.lines?.[0]?.text ?? metrics.hook ?? null) ?? undefined : undefined;
  return { metrics, title };
}

/** Titles + purposes for references read before this existed: one page load each, no playback. */
export async function describeAll(refs: ReelRef[]): Promise<number> {
  const todo = refs.filter((r) => r.url);
  const metas = await readMetas(todo.filter((r) => !r.metrics.caption).map((r) => r.url!));
  let n = 0;
  for (const r of todo) {
    const now = await latest(r);
    const d = describe({ ...r, metrics: now }, now, metas[r.url!] ?? null);
    await getRepo().update("reel_refs", { id: r.id }, { metrics: d.metrics, ...(d.title ? { title: d.title } : {}) });
    n++;
  }
  return n;
}

const pacingOf = (avg: number): "fast" | "medium" | "cinematic" => (avg < 0.8 ? "fast" : avg < 2 ? "medium" : "cinematic");

const soundName = (s: { song: string; artist: string | null; original: boolean } | null | undefined) =>
  s ? (s.original ? `Original audio · ${s.artist ?? "the creator"}` : `${s.song}${s.artist ? ` · ${s.artist}` : ""}`) : undefined;

/** A template's sound: pulled once from the reel into the engine's input/ (local), then used by its renders. */
export async function pullAudio(ref: ReelRef): Promise<string | null> {
  if (!ref.url) return null;
  const r = await readAudio(ref.url);
  const now = await latest(ref);
  if ("error" in r) {
    await getRepo().update("reel_refs", { id: ref.id }, { metrics: { ...now, audio_error: r.error } });
    return null;
  }
  const name = `refaudio_${ref.id.replace(/[^\w-]/g, "_")}.m4a`;
  const up = await engine().upload(name, new Uint8Array(r.data).buffer as ArrayBuffer);
  await getRepo().update("reel_refs", { id: ref.id }, { metrics: { ...(await latest(ref)), audio: up.path ?? name, audio_error: undefined } });
  await placeSong(ref.id).catch((e) => console.error(`[refs] song ${ref.id}:`, e));
  return name;
}

const soundOf = (r: ReelRef) => r.metrics.audio ?? r.file ?? null;
/** "Take Me (To The Moon) · Ian Asher, D A N N Y" and "TAKE ME · D A N N Y" name one song; "Original audio" names none */
const titleKey = (song?: string) => {
  if (!song || /^original audio/i.test(song)) return null;
  const [title, artist = ""] = song.split("·").map((s) => s.toLowerCase());
  const t = title.replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  const a = artist.replace(/\s+/g, "");
  return t ? { t, a } : null;
};
const sameTitle = (x?: string, y?: string) => {
  const a = titleKey(x), b = titleKey(y);
  if (!a || !b || a.t !== b.t) return false;
  return !a.a || !b.a || a.a.includes(b.a) || b.a.includes(a.a) || a.a.split(",").some((p) => p && b.a.includes(p));
};

/** Which song a template's sound is. A reference whose sound is heard in another's (or names the same song) joins that
 * song: one template per song, its reels' cuts and sounds merged. song_at = where this reel's sound sits in the song. */
export async function placeSong(id: string): Promise<void> {
  const refs = await getRepo().list("reel_refs");
  const me = refs.find((r) => r.id === id);
  const mine = me && soundOf(me);
  if (!me || !mine) return;
  const placed = refs.filter((r) => r.id !== id && r.metrics.song_key && soundOf(r));
  const m = await engine().songMatch(`input/${mine}`, placed.map((r) => ({ id: r.id, audio: `input/${soundOf(r)}` }))).catch(() => null);
  const heard = m && placed.find((r) => r.id === m.id);
  const named = !heard ? placed.find((r) => sameTitle(r.metrics.song, me.metrics.song)) : undefined;
  const song_key = heard?.metrics.song_key ?? named?.metrics.song_key ?? me.id;
  const song_at = heard ? (heard.metrics.song_at == null ? null : Math.round((heard.metrics.song_at + m!.at) * 100) / 100) : named ? null : 0;
  await getRepo().update("reel_refs", { id }, { metrics: { ...(await latest(me)), song_key, song_at } });
  console.log(`[refs] song ${id}: ${heard ? `same song as ${heard.id} (+${m!.at}s)` : named ? `same song as ${named.id} (by name)` : "a new song"}`);
}

/** References added before songs were matched: place them one at a time, oldest first (each joins the ones before). */
const S = ((globalThis as { __refSongs?: { chain: Promise<unknown>; busy: Set<string> } }).__refSongs ??= { chain: Promise.resolve(), busy: new Set() });
export function queueSongs(refs: ReelRef[]): number {
  const todo = refs.filter((r) => r.metrics.song_key === undefined && soundOf(r) && !S.busy.has(r.id))
    .sort((a, z) => a.added_at.localeCompare(z.added_at));
  for (const r of todo) {
    S.busy.add(r.id);
    S.chain = S.chain.then(() => placeSong(r.id)).catch((e) => console.error(`[refs] song ${r.id}:`, e)).finally(() => S.busy.delete(r.id));
  }
  return todo.length;
}

/** Templates read before audio pulling existed: get their sound (one browser per reel, ~10s each, in order).
 * Its own queue, so it runs alongside the slower reads instead of waiting behind them. */
const A = ((globalThis as { __refAudio?: { chain: Promise<unknown> } }).__refAudio ??= { chain: Promise.resolve() });
export function queueAudio(refs: ReelRef[]): number {
  const todo = refs.filter((r) => r.url && r.metrics.intent === "template" && !r.metrics.audio);
  for (const ref of todo) {
    A.chain = A.chain.then(async () => {
      const [cur] = await getRepo().list("reel_refs", { eq: { id: ref.id } });
      if (!cur || cur.metrics.audio) return;
      const got = await pullAudio(cur).catch((e) => { console.error(`[refs] audio ${ref.id}:`, e); return null; });
      console.log(`[refs] audio ${ref.id}: ${got ?? "none"}`);
    });
  }
  return todo.length;
}

/** Fill in each reference's song from Instagram (only where you haven't typed one). */
export async function nameSounds(refs: ReelRef[]): Promise<number> {
  const todo = refs.filter((r) => r.url && !r.metrics.song);
  const found = await readSounds(todo.map((r) => r.url!));
  let n = 0;
  for (const r of todo) {
    const name = soundName(found[r.url!]);
    if (!name) continue;
    const now = await latest(r);
    if (now.song) continue;
    await getRepo().update("reel_refs", { id: r.id }, { metrics: { ...now, song: name } });
    n++;
  }
  return n;
}

/** A read takes minutes: start from the stored row, so changes made meanwhile (template / learn, hook, song) stay. */
async function latest(ref: ReelRef): Promise<ReelRef["metrics"]> {
  const [cur] = await getRepo().list("reel_refs", { eq: { id: ref.id } });
  return cur?.metrics ?? ref.metrics ?? {};
}

/** Read a reference from its link and store what it is: cuts, text, look. Keeps anything you typed yourself. */
export async function readReference(ref: ReelRef): Promise<ReelRef["metrics"]> {
  const repo = getRepo();
  if (!ref.url) return ref.metrics ?? {};
  const r = await readReel(ref.url);
  if (!r.video || !r.shots?.length) {
    const why = r.error ?? (r.images ? `a photo post (${r.images} images), not a video` : "no video found on that page");
    const metrics = { ...(await latest(ref)), read_at: new Date().toISOString(), read_error: why };
    await repo.update("reel_refs", { id: ref.id }, { metrics });
    return metrics;
  }
  // Claude looks first: a "turn your phone" reel has its picture and text rotated, and is read the right way up
  const turn = await reelTurn(r.frames ?? []).catch(() => null);
  const lines = await engine().ocrFrames(r.frames ?? [], r.shots, turn).catch((e) => { console.error(`[refs] text ${ref.id}:`, e); return []; });
  const now = await latest(ref);
  const shots = r.shots, dur = r.duration ?? shots.reduce((a, b) => a + b, 0);
  const avg = dur / shots.length;
  const metrics: ReelRef["metrics"] = {
    ...now, ...(researchIntent({ ...ref, metrics: now }) ?? {}),
    duration: dur, shots: shots.length, shot_lengths: shots, shot_fx: r.shot_fx, turn, avg_shot: +avg.toFixed(2),
    cuts_per_10s: +((10 * (shots.length - 1)) / Math.max(dur, 0.1)).toFixed(1), opening_hold: shots[0], pacing: pacingOf(avg),
    width: r.width, height: r.height, color: r.color, look: now.look ?? (r.color ? gradeFor(r.color) : undefined),
    lines: (lines.length ? lines : now.lines ?? []).map((l) => (l.look && now.text_override ? { ...l, look: { ...l.look, ...now.text_override } } : l)),
    hook: now.hook ?? lines[0]?.text,
    song: now.song ?? soundName(r.sound),
    read_at: new Date().toISOString(), read_error: undefined,
  };
  const d = describe(ref, metrics, parseMeta(r.description ?? null, r.caption ?? null));
  await repo.update("reel_refs", { id: ref.id }, { metrics: d.metrics, ...(d.title ? { title: d.title } : {}) });
  return d.metrics;
}

// one reader at a time: each read runs a headless browser for the length of the reel. The queue lives on
// globalThis so a dev reload of this module joins the same queue instead of starting a second one.
const Q = ((globalThis as { __refReads?: { chain: Promise<unknown>; queued: Set<string> } }).__refReads ??= { chain: Promise.resolve(), queued: new Set() });
const queued = Q.queued;

export function queueRead(refs: ReelRef[]): number {
  let n = 0;
  for (const ref of refs) {
    if (!ref.url || queued.has(ref.id)) continue;
    queued.add(ref.id); n++;
    Q.chain = Q.chain.then(async () => {
      const [cur] = await getRepo().list("reel_refs", { eq: { id: ref.id } });
      if (!cur) return;
      const m = await readReference(cur).catch((e) => { console.error(`[refs] read ${ref.id}:`, e); return null; });
      console.log(`[refs] read ${ref.id}: ${m?.read_error ?? (m ? `${m.shots} shots, ${m.lines?.length ?? 0} text lines` : "failed")}`);
      // a template is cut to its sound: pull it once for its renders (local only)
      if (m && !m.read_error && m.intent === "template" && !m.audio) await pullAudio({ ...cur, metrics: m }).catch(() => null);
    }).finally(() => queued.delete(ref.id));
  }
  return n;
}

export const readingNow = () => [...queued];
