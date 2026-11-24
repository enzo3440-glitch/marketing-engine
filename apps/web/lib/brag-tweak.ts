import { dropRule, wholeVideoCheck } from "./brag-check";
import "server-only";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRepo } from "@engine/db";
import { claudeCli } from "./clip-reader";
import { importVideo } from "./video-import";
import { BRAND } from "./brand";

/**
 * Tweak a finished /brag ad: Claude Code goes back into the folder the ad was made in (its overlay, render script,
 * footage picks and README with the brand voice are all still there), makes only the change asked for, re-renders, and
 * the new cut lands on Launch as its own video beside the original. Much faster than a fresh run: nothing is rebuilt
 * that the change doesn't touch. Same Max login, same rules as the first run.
 */

export interface Tweak {
  status: "working" | "done" | "error"; ask: string; at: number; job_id?: string; summary?: string; error?: string;
}

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const ENGINE = path.resolve(process.cwd(), "../../services/reel-engine");
const KIT = path.join(DATA, "ads", "_kit");
// keyed "<job>/<video>"; on globalThis so a dev reload keeps what's running
const T = ((globalThis as { __bragTweaks?: Map<string, Tweak> }).__bragTweaks ??= new Map<string, Tweak>());

/** Seconds of video in a file (ffmpeg's own Duration line), or 0 if it can't be read. */
function seconds(file: string): number {
  const r = spawnSync(path.join(ENGINE, "bin", "ffmpeg.exe"), ["-hide_banner", "-i", file], { encoding: "utf8", windowsHide: true });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr ?? "");
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

export const bragTweak = (jobId: string, variantId: string): Tweak | null => T.get(`${jobId}/${variantId}`) ?? null;

/** The /brag run folder a Launch video came from: its tag, or (ads made before the tag) the run whose final cut is the
 * same file as the imported video (same size in bytes: the import copies it as is). */
export function bragFolder(jobId: string, tags: Record<string, string> | null | undefined): string | null {
  const ads = path.join(DATA, "ads");
  if (tags?.brag && fs.existsSync(path.join(ads, tags.brag))) return path.join(ads, tags.brag);
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return -1; } };
  const mine = size(path.join(DATA, "output", jobId, "video.mp4"));
  if (mine <= 0 || !fs.existsSync(ads)) return null;
  for (const d of fs.readdirSync(ads).filter((x) => x.startsWith("brag-"))) {
    const out = path.join(ads, d, "out");
    const cuts = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => /^ad(-v\d+)?\.mp4$/.test(f)) : [];
    if (cuts.some((f) => size(path.join(out, f)) === mine)) return path.join(ads, d);
  }
  return null;
}

/** asNew: the new cut is its own video on Launch (an A/B partner), not a newer version that replaces this one there. */
export async function startBragTweak(jobId: string, variantId: string, ask: string, asNew = false, extra: Record<string, string> = {}): Promise<Tweak> {
  const k = `${jobId}/${variantId}`;
  if (T.get(k)?.status === "working") throw new Error("Already making a change to this video");
  const [v] = await getRepo().list("reel_variants", { eq: { job_id: jobId, id: variantId } });
  if (!v) throw new Error("That video is gone");
  const work = bragFolder(jobId, v.tags);
  if (!work) throw new Error("The folder this ad was made in is gone, so it can't be tweaked. Make it again from Make.");
  const t: Tweak = { status: "working", ask, at: Date.now() };
  T.set(k, t);
  run(work, jobId, v.tags ?? {}, t, v.tags?.revision_of || `${jobId}/${variantId}`, asNew, extra).catch((e) => Object.assign(t, { status: "error", error: (e as Error).message }));
  return t;
}

async function run(work: string, jobId: string, tags: Record<string, string>, t: Tweak, origin: string, asNew = false, extra: Record<string, string> = {}) {
  const out = path.join(work, "out");
  const cuts = fs.readdirSync(out).filter((f) => /^ad(-v\d+)?\.mp4$/.test(f));
  const num = (f: string) => Number(/-v(\d+)/.exec(f)?.[1] ?? 1);
  const n = Math.max(1, ...cuts.map(num)) + 1;
  const file = path.join(out, `ad-v${n}.mp4`);
  // the cut this Launch video is (the import copies it byte for byte): with A/B partners in one folder, "the latest" may be the other one
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return -1; } };
  const mine = size(path.join(DATA, "output", jobId, "video.mp4"));
  const prev = path.join(out, cuts.find((f) => size(path.join(out, f)) === mine) ?? cuts.sort((a, b) => num(a) - num(b)).pop() ?? "ad.mp4");
  // the lab's playbook as of now (the run folder's README is from when the ad was first made)
  const playbook = path.join(ENGINE, "knowledge", "what-works.md");
  const hasPlaybook = fs.existsSync(playbook) ? (fs.copyFileSync(playbook, path.join(work, "what-works.md")), true) : false;
  // and the voice and look rules as of now
  const voice = path.join(ENGINE, "knowledge", "brand-voice.md");
  const hasVoice = fs.existsSync(voice) ? (fs.copyFileSync(voice, path.join(work, "brand-voice.md")), true) : false;
  const trends = path.join(ENGINE, "knowledge", "niche-trends.md");
  const hasTrends = fs.existsSync(trends) ? (fs.copyFileSync(trends, path.join(work, "niche-trends.md")), true) : false;
  const prompt = `You made the ${BRAND.name} ad in this folder (your plan, overlay, render script and work files are in brag-output/).
The cut to change is ${prev}. Other ad*.mp4 files there are other versions; leave them as they are.
Its compose script and work files may be from a later version: check which render made ${path.basename(prev)} before reusing them.
README.md is the product truth and its voice section is how we sound: follow it.${hasPlaybook ? `
what-works.md is what our live results say works so far (rules, watch curves, scored tests): use it where the ask leaves room.` : ""}${hasVoice ? `
brand-voice.md is the newest version of our voice and look rules. Where it differs from README.md, it wins. Its section
"The cinematic look" applies to every cut, including this one, even where the ask doesn't mention it: no photo pans or zooms,
text around the middle or lower third, no clip twice, no map pin unless it marks a real named place, a natural cinematic grade
that is never oversaturated, and only words on screen that make sense.` : ""}${hasTrends ? `
niche-trends.md is what today's top ${BRAND.niche} reels on Instagram share: borrow their structure where the ask leaves room
(never their content), and never against brand-voice.md.` : ""}
Change it as asked, and nothing else: "${t.ask.replace(/"/g, "'")}"
Reuse what's here: edit the existing overlay / render files and re-render only what the change needs. ffmpeg is at
${path.join(ENGINE, "bin", "ffmpeg.exe")}; render tools are installed in ${path.join(KIT, "tools")}. Don't reinstall anything.
Never put an email address or any personal detail in a request, and don't download photos from the web.
This run is headless: nothing wakes you up later. Run every render in the foreground and wait for it to finish; if
you end your turn while a render runs in the background, the cut is lost or half-written.
When it's rendered:
- write the new vertical MP4 to ${file} (keep every other ad*.mp4 as it is)
- rewrite ${path.join(out, "script.txt")} and ${path.join(out, "caption.txt")} so they match this new cut's lines and caption
- write one short sentence on what you changed to ${path.join(out, `change-v${n}.txt`)}
${dropRule(KIT, path.join(ENGINE, "bin", "ffmpeg.exe"))}
${wholeVideoCheck(file, `${t.ask} (and every line already in the ad that this change didn't touch)`)}
Don't post, upload or publish anything, and don't touch files outside this folder.`;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // the Max login, never a key
  const log = await new Promise<string>((resolve) => {
    const p = spawn(claudeCli(), ["-p", prompt, "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,TodoWrite", "--permission-mode", "acceptEdits",
      "--add-dir", path.join(DATA, "input"), "--add-dir", path.join(ENGINE, "assets"), "--add-dir", KIT, "--add-dir", path.join(ENGINE, "bin"),
      "--strict-mcp-config", "--output-format", "text"], { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let s = "";
    p.stdout.on("data", (d) => { s += d; });
    p.stderr.on("data", (d) => { s += d; });
    const kill = setTimeout(() => p.kill(), 45 * 60_000); // same limit as a new ad: a picture re-render plus the whole-video check can pass 30 min
    p.on("error", (e) => { clearTimeout(kill); resolve(`could not start Claude Code (${e.message})`); });
    p.on("close", () => { clearTimeout(kill); resolve(s); });
  });
  fs.writeFileSync(path.join(work, `tweak-v${n}.log`), log);
  if (!fs.existsSync(file)) throw new Error(`No new cut came back. ${log.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
  // a cut much shorter than the one it changed is a render that was cut off, not a finished change
  const [now, was] = [seconds(file), seconds(prev)];
  if (was > 0 && now < was * 0.8) throw new Error(`The new cut is ${now.toFixed(1)} s, the one it changed is ${was.toFixed(1)} s: the render was cut off, so it wasn't added to Launch. Ask again.`);
  const text = (f: string) => { try { return fs.readFileSync(path.join(out, f), "utf8").trim(); } catch { return ""; } };
  const summary = text(`change-v${n}.txt`).slice(0, 300);
  // the sound label comes from the song this run actually used (its fresh out/sound.txt), never copied from the cut
  // it changed (re-cuts once kept the old label and the cards couldn't be trusted)
  const soundFile = path.join(out, "sound.txt");
  const fresh = (() => { try { return fs.statSync(soundFile).mtimeMs >= fs.statSync(prev).mtimeMs; } catch { return false; } })();
  const used = fresh ? text("sound.txt") : "";
  const job = await importVideo({ video: fs.readFileSync(file), name: "ad.mp4", script: text("script.txt"), caption: text("caption.txt"),
    ideaId: tags.idea ?? null, madeBy: tags.made_by ?? "brag",
    tags: { brag: path.basename(work), ...(asNew ? { partner_of: origin } : { revision_of: origin }), revision_ask: t.ask.slice(0, 300), revision_summary: summary, version: String(n), ...(tags.sound ? { sound: tags.sound } : {}), ...extra, ...(used ? { sound: used } : {}) } });
  Object.assign(t, { status: "done", job_id: job, summary });
}
