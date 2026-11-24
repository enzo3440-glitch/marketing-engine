import "server-only";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The viral sounds.
 * Two sources:
 *  - the audio of the viral reels we dropped in as references (input/refaudio_*.m4a): the template reels were cut to
 *    them, ranked by how many template reels used each one;
 *  - trending songs added by hand to assets/music/ig. The file name is the sound's name ("Artist - Song Title.mp3").
 * Instagram trial reels use these; ads never do (ads keep the cleared tracks in assets/music/ads).
 *
 * The rotation goes to the sound used least in the last few days, so one sound can't take over the feed.
 */
// note: where to cut it, from a .txt next to a hand-added song ("start at 12.4 s: the part the owner likes...")
export interface ViralSound { file: string; name: string; uses: number; secs: number; note?: string }

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const ENGINE = path.resolve(DATA, "..");
const FF = path.join(ENGINE, "bin", "ffmpeg.exe");
const IG_DIR = path.join(ENGINE, "assets", "music", "ig");
// a song whose rights holder is known to mute reels gets skipped; sounds the owner has banned (BANNED_SOUNDS, a regex such as
// "song one|song two") never go out. Unset means none is banned: (?!) never matches.
export const BANNED_SOUND = new RegExp(process.env.BANNED_SOUNDS || "(?!)", "i");
const SKIP = new RegExp(`prince|purple rain|${BANNED_SOUND.source}`, "i");
// our reels run 12-13 s; a sound has to cover that from a start point that still lands the drop
const MIN_SECS = 14;
let cache: { at: number; list: ViralSound[] } | null = null;
const lengths = new Map<string, number>();

function secs(file: string): number {
  if (lengths.has(file)) return lengths.get(file)!;
  const r = spawnSync(fs.existsSync(FF) ? FF : "ffmpeg", ["-hide_banner", "-i", file], { encoding: "utf8" });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(`${r.stderr ?? ""}`);
  const s = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  lengths.set(file, s);
  return s;
}

export function viralSounds(): ViralSound[] {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.list;
  const uses = new Map<string, number>(), names = new Map<string, string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    if (typeof r.music === "string" && /refaudio_/.test(r.music)) {
      const k = path.basename(r.music.replace(/\\/g, "/"));
      uses.set(k, (uses.get(k) ?? 0) + 1);
      if (typeof r.song_to_add === "string" && r.song_to_add) names.set(k, r.song_to_add);
    }
    Object.values(r).forEach(walk);
  };
  const jobs = path.join(DATA, "jobs");
  for (const f of fs.existsSync(jobs) ? fs.readdirSync(jobs).filter((x) => /^tpl-.*\.json$/.test(x)) : []) {
    try { walk(JSON.parse(fs.readFileSync(path.join(jobs, f), "utf8"))); } catch { /* a half-written job */ }
  }
  const saved = [...uses.entries()]
    .map(([k, n]) => ({ file: path.join(DATA, "input", k), name: names.get(k) ?? k, uses: n, secs: 0 }))
    .filter((s) => s.uses >= 1);
  const added = (fs.existsSync(IG_DIR) ? fs.readdirSync(IG_DIR) : []).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f))
    .map((f) => {
      const txt = path.join(IG_DIR, f.replace(/\.[^.]+$/, ".txt"));
      return { file: path.join(IG_DIR, f), name: f.replace(/\.[^.]+$/, ""), uses: 99, secs: 0, note: fs.existsSync(txt) ? fs.readFileSync(txt, "utf8").trim() : undefined };
    });
  const list = [...added, ...saved as ViralSound[]]
    .filter((s) => !SKIP.test(s.name) && fs.existsSync(s.file))
    .map((s) => ({ ...s, secs: secs(s.file) }))
    // a sound used by a single reference only makes the list when it's long enough to pick a good part from
    .filter((s) => s.secs >= MIN_SECS && (s.uses >= 3 || s.secs >= 20))
    .sort((a, b) => b.uses - a.uses);
  cache = { at: Date.now(), list };
  return list;
}

// picks handed out but not rendered yet count as uses, so one tick's swaps spread over the sounds
const picked: { name: string; at: number }[] = [];

/** How many Instagram reels made in the last 3 days are on each sound (by name). */
export function soundUse(): Map<string, number> {
  const n = new Map<string, number>();
  const out = path.join(DATA, "output");
  const since = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10).replace(/-/g, "");
  for (const d of fs.existsSync(out) ? fs.readdirSync(out) : []) {
    const m = /^imp-(\d{8})/.exec(d);
    if (!m || m[1] < since) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(out, d, "manifest.json"), "utf8")) as { variants?: { tags?: Record<string, string> }[] };
      for (const v of j.variants ?? []) if (v.tags?.sound) n.set(v.tags.sound, (n.get(v.tags.sound) ?? 0) + 1);
    } catch { /* no manifest yet */ }
  }
  for (const p of picked.filter((p) => Date.now() - p.at < 3 * 3600_000)) n.set(p.name, (n.get(p.name) ?? 0) + 1);
  return n;
}

/** The sound used least lately (ties go to the better-ranked one, then rotate by n), so a day's reels spread over the sounds. */
export const pickSound = (n = 0): ViralSound | null => {
  const l = viralSounds();
  if (!l.length) return null;
  const use = soundUse();
  const low = Math.min(...l.map((s) => use.get(s.name) ?? 0));
  const tied = l.filter((s) => (use.get(s.name) ?? 0) === low);
  const s = tied[Math.abs(n) % tied.length];
  picked.push({ name: s.name, at: Date.now() });
  return s;
};

/** The other sounds, least used first, for the run to choose from when the picked one doesn't fit the edit. */
export const soundFallback = (s: ViralSound, out: string) => {
  const use = soundUse();
  const others = viralSounds().filter((x) => x.file !== s.file).sort((a, b) => (use.get(a.name) ?? 0) - (use.get(b.name) ?? 0));
  return `Listen to it against the edit first. If its mood or tempo doesn't fit this edit (the shots, the pace, the line), or it can't cover
the whole reel from a start point that lands its drop well, don't loop it, shorten the reel or ask: use the one from these viral sounds whose
mood and tempo fit the edit best, preferring the ones used least lately (uses in the last 3 days in brackets):
${others.map((x) => `${x.file} ("${x.name}", ${Math.round(x.secs)} s${x.note ? `; ${x.note}` : ""}) [${use.get(x.name) ?? 0}]`).join("; ")}.
Never stop to ask a question: nobody can answer this run. Write the name of the sound you used (as given in quotes) to ${out}.`;
};

/** A sound by its name or file name (a hand pick for one reel). */
export const findSound = (k: string): ViralSound | null =>
  viralSounds().find((x) => x.name === k || path.basename(x.file) === k) ?? null;

/** Said instead of the fallback when the song was picked on purpose: the run may not switch it. */
export const chosenNote = (out: string) => `This song was picked for this video on purpose (we're testing how each song does): use it, never another one. Re-time the cuts
and the hook's turn to its beat and drop as needed. Write its name (as given in quotes) to ${out}.`;

/** The music line for an Instagram reel cut to one viral sound. */
export const soundBrief = (s: ViralSound, out: string, chosen = false) => `the viral sound ${s.file} ("${s.name}", the audio of a viral reel) is the whole
music bed: one start point, no second song, no stock track under it.${s.note ? ` ${s.note}` : ""} Cut to its beat and land the hook's turn on its drop (find it with the
drop rule below). Keep the SFX very soft or none, so it sounds like a real reel cut to a trending sound.
${chosen ? chosenNote(out) : soundFallback(s, out)}`;
