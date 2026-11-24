import { dropRule, wholeVideoCheck } from "./brag-check";
import "server-only";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeCli } from "./clip-reader";
import type { Creation } from "./reel-create";
import { noteMade } from "./ideas";
import { importVideo } from "./video-import";
import { markFolder, streamFolders, type Stream } from "./streams";
import { findSound, pickSound, soundBrief } from "./viral-sounds";
import { BRAND } from "./brand";

/**
 * App ads made by the real /brag skill (Hyperframes: app screens rebuilt from the latest app code, brag music and SFX),
 * run headless on the Claude Max login with shell access inside its own work folder (the owner allowed this).
 * Two looks: our phone springing up into frame, or the app's screens and widget cards floating over one film-look shot
 * with no phone (the style reference in input/library/refs). One run at a time; the rest wait in line.
 * The finished ad and its script come back into the desk as a one-video batch, ready on Launch.
 * Shares this machine's disk with the engine (REEL_DATA_DIR, default services/reel-engine/reel-data).
 */

export type BragStyle = "phone" | "floating";

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const ENGINE = path.resolve(process.cwd(), "../../services/reel-engine");
const KNOWLEDGE = path.join(ENGINE, "knowledge");
// the app's repo and the branch that holds its latest version (optional: without APP_DIR the ads are made without a code snapshot)
const APP_DIR = process.env.APP_DIR || "";
const APP_REF = process.env.APP_REF || "origin/main";
const R = ((globalThis as { __brags?: Map<string, Creation> }).__brags ??= new Map<string, Creation>());
// two runs at once by default (BRAG_LANES); each new run joins the shorter line
const LANES = Math.max(1, Number(process.env.BRAG_LANES) || 2);
const Q = globalThis as { __bragLanes?: { tail: Promise<void>; n: number }[] };
// set up once and shared by every run: render tools (puppeteer-core, ffmpeg-static), the app's fonts, and a past ad
// whose overlay and render script are a working starting point, so a run doesn't reinstall and rewrite them each time
const KIT = path.join(DATA, "ads", "_kit");

// the Claude Code run behind each ad, so Make's Cancel can stop it
const PROCS = ((globalThis as { __bragProcs?: Map<string, ChildProcess> }).__bragProcs ??= new Map<string, ChildProcess>());
const CANCELLED = ((globalThis as { __bragCancelled?: Set<string> }).__bragCancelled ??= new Set<string>());

/** Stops a queued or running /brag ad: kills its Claude Code run (and the renders it started) and takes it off the line. */
export function cancelBragAd(id: string): boolean {
  const c = R.get(id);
  if (!c || c.status === "done" || c.status === "error") return false;
  CANCELLED.add(id);
  const p = PROCS.get(id);
  if (p?.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true });
  writeQueue(readQueue().filter((x) => x.id !== id));
  Object.assign(c, { status: "error", error: "Cancelled.", plan: undefined });
  return true;
}

export const bragRuns = (): Creation[] => {
  resumeQueue();
  return [...R.values()].sort((a, z) => z.at - a.at).slice(0, 16);
};

/** Tracks cleared for paid social ads (assets/music/ads, see its README); without any, brag's own picks that fit the voice. */
function music(): string {
  const dir = path.join(ENGINE, "assets", "music", "ads");
  const tracks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f)) : [];
  return tracks.length
    ? `pick the track from ${dir} that best fits this ad (warm, cinematic, aspirational; read the README there) and cut to its build, kept under the visuals.`
    : `a warm, cinematic, aspirational track (indie / chill electronic with a lift, like a film score) from your bundled music, kept under the visuals. Not corporate stock beds.`;
}

type LibItem = { id: string; kind: string; path: string; what?: string; note?: string };

function library(): LibItem[] {
  try {
    const dir = path.join(DATA, "input", "library");
    const items = (JSON.parse(fs.readFileSync(path.join(dir, "library.json"), "utf8")) as { items: LibItem[] }).items;
    return items.map((it) => ({ ...it, path: path.isAbsolute(it.path) ? it.path : path.join(dir, it.path) })).filter((it) => fs.existsSync(it.path));
  } catch {
    return [];
  }
}

/** The app's code at its latest commit, copied into the run's folder (read-only on the repo: git archive, no checkout). */
function appSnapshot(dest: string): string | null {
  if (!APP_DIR) return null; // APP_DIR isn't set: no app code to snapshot; the ad is made from the README and the screen recordings
  if (!APP_DIR) return null; // APP_DIR isn't set: no app code to snapshot; the ad is made from the README and the screen recordings
  const git = (...a: string[]) => spawnSync("git", ["-C", APP_DIR, ...a], { encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 });
  const sha = git("rev-parse", APP_REF).stdout?.trim();
  if (!sha) return null;
  const files = git("ls-tree", "-r", "-l", "--full-tree", sha).stdout.split("\n").map((l) => l.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/)).filter((m): m is RegExpMatchArray => !!m);
  const want = files.filter(([, size, f]) => /^(src|components)\//.test(f) || /^(App\.js|app\.json|app\.config\.\w+|package\.json)$/.test(f)
    || (/^assets\/.*(icon|logo|splash)[^/]*\.(png|svg|jpg)$/i.test(f) && Number(size) < 1.5e6)).map(([, , f]) => f);
  if (!want.length) return null;
  // whole folders as one pathspec each, so the command line stays short
  const specs = [...new Set(want.map((f) => (/^(src|components)\//.test(f) ? f.split("/")[0] : f)))];
  const tar = path.join(dest, "app.tar");
  git("archive", "-o", tar, sha, "--", ...specs);
  if (!fs.existsSync(tar)) return null;
  fs.mkdirSync(path.join(dest, "app"), { recursive: true });
  // relative paths: GNU tar (Git's, if it's first on PATH) reads "C:\…" as a remote host
  spawnSync("tar", ["-xf", "../app.tar"], { cwd: path.join(dest, "app"), windowsHide: true });
  fs.rmSync(tar, { force: true });
  return sha.slice(0, 8);
}

// the line survives a desk restart: every queued or running ad is written here, and the first look after a restart
// picks them up again (a run whose ad.mp4 already exists is just imported; an unfinished one starts over in its folder)
// sound: a song picked for this run on purpose (a viral sound's name or file name), ads included
type Saved = { id: string; ideaId: string | null; title: string | null; ask: string; clipFiles: string[]; style: BragStyle; at: number; sound?: string };
const QUEUE = path.join(DATA, "ads", "_queue.json");
const readQueue = (): Saved[] => { try { return JSON.parse(fs.readFileSync(QUEUE, "utf8")) as Saved[]; } catch { return []; } };
const writeQueue = (q: Saved[]) => { try { fs.writeFileSync(QUEUE, JSON.stringify(q, null, 1)); } catch { /* the line still runs, it just won't survive a restart */ } };

function enqueue(s: Saved, persist: boolean): Creation {
  const c: Creation = { id: s.id, ask: `${s.title ?? s.ask.split("\n")[0]} · ${s.style === "phone" ? "phone" : "floating screens"}`, kind: "ad", at: s.at,
    status: "thinking", plan: "Waiting for a /brag run ahead of it." };
  R.set(s.id, c);
  if (persist) writeQueue([...readQueue().filter((x) => x.id !== s.id), s]);
  const lanes = (Q.__bragLanes ??= Array.from({ length: LANES }, () => ({ tail: Promise.resolve(), n: 0 })));
  const lane = lanes.reduce((a, z) => (z.n < a.n ? z : a));
  lane.n++;
  lane.tail = lane.tail.then(() => (CANCELLED.has(c.id) ? undefined : run(c, s.ideaId, s.ask, s.clipFiles, s.style, s.sound)))
    .catch((e) => { Object.assign(c, { status: "error", error: CANCELLED.has(c.id) ? "Cancelled." : (e as Error).message }); })
    .finally(() => { lane.n--; PROCS.delete(c.id); writeQueue(readQueue().filter((x) => x.id !== s.id)); });
  return c;
}

/** stream: which Launch column its video lands in (lib/streams.ts); left out, a /brag video counts as an ad. */
export function startBragAd(ideaId: string | null, title: string | null, ask: string, clipFiles: string[], style: BragStyle, stream?: Stream, sound?: string): Creation {
  const id = `brag-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${R.size}-${style}`;
  if (stream) markFolder(id, stream);
  return enqueue({ id, ideaId, title, ask, clipFiles, style, at: Date.now(), ...(sound ? { sound } : {}) }, true);
}

/** After a restart: put the saved line back, oldest first. Runs once per server. */
function resumeQueue() {
  const g = globalThis as { __bragResumed?: boolean };
  if (g.__bragResumed) return;
  g.__bragResumed = true;
  for (const s of readQueue().sort((a, z) => a.at - z.at)) if (!R.has(s.id)) enqueue(s, false);
}

const PHONE = `Look: our phone. The app sits in a clean modern iPhone that springs up into frame and drifts slowly; real footage behind or between phone shots.`;
// a feature is a whole screen or a big card, never a tight zoom on a toggle
const SCREENS = `Showing the app: the feature is a big part of the frame (the full screen, or a card filling most of it: the feature's key result
as the app shows it), held 2-3 s. Never zoom in on a button, a switch, a toggle or a settings row,
and never show or mention a mode or any setting: show what the app finds, not how to turn it on.`;
const FLOATING = (ref: string) => `Look: NO phone. Copy the style reference (${ref}/floating-screens-ref.mp4, frame sheet ${ref}/floating-screens-ref.jpg):
one locked, film-grain real shot fills the whole frame the entire time (sky, palms, a street, a view: pick the most beautiful one from the footage),
and the app's UI floats centred over it as clean rendered screens and widget cards: no bezel, rounded corners (~40px at 1080w), a soft shadow,
about 60% of the frame wide. Move between a full screen and smaller widget cards with a quick scale-in pop and a tiny settle, but hold each one
long enough to read (2.5-3 s for anything with text on it; see "time to read" in README.md).
Keep any text minimal: a few short lines and the CTA.
The real shot plays as real video: slow motion only if it was shot at 60 fps or more, a 30 fps clip at normal speed, never stretched,
frame-stepped or zoomed as stills (brag-kit.md "Footage speed"). No push-in or zoom on it. Captions sit around the middle of the
frame or in the lower third, never at the top. Cinematic grade, never oversaturated (README.md, "The cinematic look").`;

async function run(c: Creation, ideaId: string | null, ask: string, clipFiles: string[], style: BragStyle, chosen?: string) {
  c.plan = "/brag is reading the latest app code, then writing and rendering the ad (usually 5–20 min).";
  c.at = Date.now();
  const work = path.join(DATA, "ads", c.id);
  const out = path.join(work, "out");
  fs.mkdirSync(out, { recursive: true });
  const lib = library();
  const screens = lib.filter((x) => x.kind === "screen");
  const footage = [...clipFiles.map((f) => path.join(DATA, "input", f)).filter((f) => fs.existsSync(f)),
    ...lib.filter((x) => x.kind === "footage").map((x) => x.path)].slice(0, 10);
  const sha = appSnapshot(work);
  const ref = path.join(DATA, "input", "library", "refs");
  // Instagram reels are cut to one of the viral sounds, rotated across runs; ads keep the cleared tracks
  const ig = streamFolders()[c.id] === "ig";
  const picked = chosen ? findSound(chosen) : null;
  const sound = picked ?? (ig ? pickSound(Object.values(streamFolders()).filter((x) => x === "ig").length + Number(/-(\d+)-/.exec(c.id)?.[1] ?? 0)) : null);
  // the "project" brag reads: what the product is and what it really does
  const knowledge = fs.existsSync(KNOWLEDGE)
    ? fs.readdirSync(KNOWLEDGE).filter((f) => f.endsWith(".md")).map((f) => fs.readFileSync(path.join(KNOWLEDGE, f), "utf8")).join("\n\n") : "";
  fs.writeFileSync(path.join(work, "README.md"), `# ${BRAND.name}\n\n${BRAND.pitch}\n\nLink: ${process.env.META_DEFAULT_LINK ?? ""}\n\n${knowledge}`);
  const prompt = `/brag --format vertical --tone cinematic --duration ${style === "phone" ? 15 : 12}
Make a vertical (1080x1920) Instagram ad for ${BRAND.name} (${BRAND.pitch}). README.md in this folder is the product truth: show only what it says the app does.
Its voice section (from brand-voice.md) is how we sound and how an ad flows: follow it over everything else here. Use the tone and example lines given there. The feeling
and the best footage come first, then the app as the how, then the payoff. No gag openers, no app jargon.
The idea below is the angle, not the script: its hook and lines may be in an older voice, so rewrite every on-screen line in the brand voice.
${sha ? `./app is the app's latest code (${APP_REF} @ ${sha}). Read its screens, theme, colours, fonts, icons and copy, and rebuild every app screen you show from it, so the ad matches the latest version of the app. Use real-looking content (real names and places) in those screens.` : ""}
${ask}
${style === "phone" ? PHONE : FLOATING(ref)}
${SCREENS}
Screen recordings of the app (older builds; use them to check layouts and flows, the code wins where they differ): ${screens.map((s) => `${s.path}${s.what ? ` (${s.what})` : ""}`).join("; ") || "none"}.
Real footage you may use: ${footage.join("; ") || "none"}.
${sound ? `Music: ${soundBrief(sound, path.join(out, "sound.txt"), !!picked)}` : `Music: ${music()} SFX: build the bed with ${path.join(KIT, "sound", "sfx_kit.py")} (soft taps, air, a warm tuned reward, the place's own sound),
soft and few; no shimmers or sparkles. No trending, comedy or corporate "business" audio.`}
${fs.existsSync(KIT) ? `Go fast: everything is already set up, so don't install or download tools or fonts.
- ffmpeg: ${path.join(ENGINE, "bin", "ffmpeg.exe")}. Render tools (puppeteer-core, ffmpeg-static) are installed in ${path.join(KIT, "tools")}: require them from there.
- The app's fonts are in ${path.join(KIT, "fonts")}.
- ${path.join(KIT, "quest-ad")} (the floating look) and ${path.join(KIT, "florence-ad")} (the phone look) have the overlay,
  render and compose scripts of ads we liked: start from them and change what this ad needs. README.md's kit section says how to render fast.` : ""}
Never put an email address or any personal detail in a request (no user-agent with an email). Don't download photos from the web
(Wikimedia, stock sites): use the footage and screens given; any image for a place can be a frame from the footage.
Work only inside this folder (the footage, music and reference files above are read-only inputs). When the render is done:
- copy the final vertical MP4 to ${path.join(out, "ad.mp4")}
- write the Instagram caption with 3-5 hashtags to ${path.join(out, "caption.txt")}
- write the script (hook, each on-screen line in order, the CTA; one per line) to ${path.join(out, "script.txt")}
${dropRule(KIT, path.join(ENGINE, "bin", "ffmpeg.exe"))}
${wholeVideoCheck(path.join(out, "ad.mp4"), ask)}
Don't post, upload or publish anything, and don't touch files outside this folder.`;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // the Max login, never a key
  // resumed after a restart with the ad already rendered: just bring it in
  const log = fs.existsSync(path.join(out, "ad.mp4")) ? "rendered before the desk restarted" : await new Promise<string>((resolve) => {
    const p = spawn(claudeCli(), ["-p", prompt, "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,Skill,TodoWrite", "--permission-mode", "acceptEdits",
      "--add-dir", path.join(DATA, "input"), "--add-dir", path.join(ENGINE, "assets"), "--add-dir", KIT, "--add-dir", path.join(ENGINE, "bin"), "--strict-mcp-config", "--output-format", "text"],
    { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    PROCS.set(c.id, p);
    let s = "";
    p.stdout.on("data", (d) => { s += d; });
    p.stderr.on("data", (d) => { s += d; });
    const kill = setTimeout(() => p.kill(), 45 * 60_000);
    p.on("error", (e) => { clearTimeout(kill); resolve(`could not start Claude Code (${e.message})`); });
    p.on("close", () => { clearTimeout(kill); resolve(s); });
  });
  fs.writeFileSync(path.join(work, "brag.log"), log);
  if (CANCELLED.has(c.id)) throw new Error("Cancelled.");
  const video = path.join(out, "ad.mp4");
  if (!fs.existsSync(video)) throw new Error(`/brag didn't produce a video. ${log.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
  const text = (f: string) => { try { return fs.readFileSync(path.join(out, f), "utf8").trim(); } catch { return ""; } };
  c.status = "rendering";
  const job = await importVideo({ video: fs.readFileSync(video), name: "ad.mp4", script: text("script.txt"), caption: text("caption.txt"), ideaId,
    madeBy: style === "phone" ? "brag" : "brag-floating", tags: { brag: c.id, ...(sound ? { sound: text("sound.txt") || sound.name } : {}) } });
  if (ideaId) await noteMade(ideaId, job);
  Object.assign(c, { status: "done", job_id: job, made: 1, plan: `/brag made the ad${sha ? ` from app ${sha}` : ""}. It's on Launch (if not yet, it shows there once the reel engine is running).` });
}
