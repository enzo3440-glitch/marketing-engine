import "server-only";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getRepo } from "@engine/db";
import { trackCreation } from "./reel-create";
import { importVideo } from "./video-import";
import { noteMade } from "./ideas";
import { BRAND } from "./brand";

/**
 * Story docs: a city's story in one narrated voice over archive photos,
 * maps and film, cut like a history-channel doc (see engine/storydoc.py). The script is written in services/reel-engine/knowledge/story-docs/<city>.txt, exactly as spoken.
 * The owner synthesizes it with their narrator voice and uploads the audio on Make. The engine
 * (engine/storydoc.py) times the pictures and captions to that audio. Each upload makes two cards on Launch: a trial
 * reel (Instagram) and an ad (App Store end card). Nothing posts until he approves it on Launch.
 */

const ENGINE = path.resolve(process.cwd(), "../../services/reel-engine");
const DATA = process.env.REEL_DATA_DIR || path.join(ENGINE, "reel-data");
const SCRIPTS = path.join(ENGINE, "knowledge", "story-docs");
const STORIES = path.join(DATA, "story-docs");

export interface StoryDoc {
  slug: string; title: string; script: string; words: number; seconds: number; images: number;
  ready: boolean; missing: string | null; caption: string; ideaId: string; audio: string | null;
}

const titleOf = (slug: string) => slug.replace(/(^|-)(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());

function captions(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(SCRIPTS, "captions.json"), "utf8")); } catch { return {}; }
}

/** Credit lines for the pictures that need one (CC BY / BY-SA); public-domain pictures need none. */
function credits(dir: string): string {
  try {
    const beats = JSON.parse(fs.readFileSync(path.join(dir, "beats.json"), "utf8")) as { beats: { images: (string | { file: string })[] }[] };
    const used = new Set(beats.beats.flatMap((b) => b.images.map((x) => (typeof x === "string" ? x : x.file))));
    const rows = JSON.parse(fs.readFileSync(path.join(dir, "credits.json"), "utf8")) as { file: string; author?: string; license?: string }[];
    const need = rows.filter((r) => used.has(r.file) && /CC BY/i.test(r.license ?? ""))
      .map((r) => `${String(r.author ?? "Unknown").replace(/<[^>]+>/g, "").trim()} (${r.license})`);
    return need.length ? `Archive: ${[...new Set(need)].join("; ")}` : "";
  } catch { return ""; }
}

export function listStoryDocs(): StoryDoc[] {
  if (!fs.existsSync(SCRIPTS)) return [];
  const caps = captions();
  return fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".txt")).map((f) => {
    const slug = f.replace(/\.txt$/, "");
    const script = fs.readFileSync(path.join(SCRIPTS, f), "utf8").replace(/\r/g, "").trim();
    const dir = path.join(STORIES, slug);
    const beats = path.join(dir, "beats.json");
    const images = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /\.(jpe?g|png)$/i.test(x)).length : 0;
    const audio = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => /^narration\./.test(x)) ?? null : null;
    let title = titleOf(slug);
    try { title = JSON.parse(fs.readFileSync(beats, "utf8")).title ?? title; } catch { /* no beats yet */ }
    const words = script.split(/\s+/).length;
    return {
      slug, title, script, words, seconds: Math.round(words / 2.4), images, audio,
      ready: fs.existsSync(beats) && images > 0, missing: !fs.existsSync(beats) ? "pictures and beats not laid out yet" : images ? null : "no pictures yet",
      caption: [caps[slug] ?? "", credits(dir)].filter(Boolean).join("\n\n"), ideaId: `story-${slug}`,
    };
  });
}

/** Each story doc is also an idea (so Ideas and Make list it), where: Instagram and ads. */
export async function ensureStoryIdeas() {
  const repo = getRepo();
  const have = new Set((await repo.list("content_items")).map((c) => c.id));
  const add = listStoryDocs().filter((s) => !have.has(s.ideaId));
  if (!add.length) return;
  await repo.insert("content_items", add.map((s) => ({
    id: s.ideaId, platform: "instagram" as const, kind: "reel" as const, status: "idea" as const,
    title: `Story doc · ${s.title}`, caption: s.script.split("\n")[0], media_url: null, scheduled_at: null, posted_at: null,
    views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: "desk",
    meta: { hook: s.script.split("\n")[0], channel: "ig_organic", format: "story_doc", story: s.slug, where: ["ig", "ads"],
      tier: "entertain", cta: `To hear more stories like these when you're exploring a place, download ${BRAND.name}.`,
      hypothesis: "A narrated city mini-doc (one voice, archive pictures, a dark turn and a warm ending) holds viewers to the end and earns saves and shares better than a scenic montage." },
  })));
}

function py(args: string[], mod = "engine.storydoc"): Promise<void> {
  return new Promise((ok, bad) => {
    const env = { ...process.env, PATH: `${path.join(ENGINE, "bin")}${path.delimiter}${process.env.PATH}`, PYTHONPATH: ENGINE, PYTHONIOENCODING: "utf-8" };
    const p = spawn("python", ["-m", mod, ...args], { cwd: ENGINE, env, windowsHide: true });
    let err = "";
    p.stderr.on("data", (b) => { err = (err + b.toString()).slice(-1500); });
    p.once("error", bad);
    p.once("exit", (code) => (code ? bad(new Error(err.trim().split("\n").pop() || `render failed (${code})`)) : ok()));
  });
}

/**
 * Render the trial reel and the ad; both land on Launch. The narration is one of:
 *   audio  → his recording, uploaded (saved as narration.<ext>)
 *   voice  → the whole script read by his voice model (engine/narrate.py; saved as voice-narration.wav, his recording is kept)
 *   hook   → a new first paragraph in the voice model, joined to his recording from paragraph 2 on; the script's first paragraph is
 *            swapped for the new hook in this render only
 */
export function makeStoryDoc(slug: string, o: { audio?: Buffer; ext?: string; voice?: boolean; hook?: string }) {
  const s = listStoryDocs().find((x) => x.slug === slug);
  if (!s) throw new Error("No story doc by that name");
  if (!s.ready) throw new Error(`${s.title}: ${s.missing}`);
  const dir = path.join(STORIES, slug);
  const outDir = path.join(STORIES, slug, "renders");
  const scriptFile = path.join(SCRIPTS, `${slug}.txt`);
  let narration = "";
  let script = s.script;
  const hook = o.hook?.replace(/\s+/g, " ").trim();
  const lastTiming = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((x) => x.endsWith(".timing.json") && !x.includes("-hook-")).sort().pop() : undefined);
  if (o.audio && o.ext) {
    for (const old of fs.readdirSync(dir).filter((x) => /^narration\./.test(x))) fs.rmSync(path.join(dir, old));
    narration = path.join(dir, `narration.${o.ext}`);
    fs.writeFileSync(narration, o.audio);
  } else if (hook) {
    if (!s.audio) throw new Error("A new hook goes on your recording: upload the narration first (or narrate the whole script in our voice).");
    if (!lastTiming()) throw new Error("Render it once with your recording first: the new hook needs to know where your second paragraph starts.");
    script = [hook, ...s.script.split(/\n\s*\n/).slice(1)].join("\n\n");
  } else if (!o.voice) throw new Error("Attach the narration, or narrate it in our voice");
  const c = trackCreation(`Story doc · ${s.title}${hook ? " · new hook" : o.voice ? " · our voice" : ""} (trial reel + ad)`);
  (async () => {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    fs.mkdirSync(outDir, { recursive: true });
    let useScript = scriptFile;
    if (o.voice || hook) {
      c.status = "rendering"; // narrating first; the plan says so
      c.plan = hook ? `${s.title}: the new hook in our voice, then your recording from the second paragraph.` : `${s.title}: the whole script in our voice model.`;
      if (hook) {
        useScript = path.join(outDir, `${slug}-hook-${stamp}.txt`);
        fs.writeFileSync(useScript, script + "\n");
        narration = path.join(outDir, `${slug}-hook-${stamp}.wav`);
        await py(["--hook", hook, "--audio", path.join(dir, s.audio!), "--timing", path.join(outDir, lastTiming()!), "--out", narration], "engine.narrate");
      } else {
        narration = path.join(dir, "voice-narration.wav");
        await py(["--script", scriptFile, "--out", narration], "engine.narrate");
      }
    }
    c.status = "rendering";
    c.plan = `${s.title}: a history-doc cut timed word by word to the narration (slow pans, archive film, the hook big in the middle, lower-third subtitles, callouts), then the ${BRAND.name} card. A trial reel and an ad.`;
    const made: string[] = [];
    for (const kind of ["trial", "ad"] as const) {
      const out = path.join(outDir, `${slug}${hook ? "-hook" : ""}-${kind}-${stamp}.mp4`);
      await py(["--story", dir, "--script", useScript, "--audio", narration, "--out", out, ...(kind === "ad" ? ["--ad"] : [])]);
      const id = await importVideo({
        video: fs.readFileSync(out), name: path.basename(out), script, caption: s.caption, ideaId: s.ideaId,
        madeBy: "story-doc", tags: { stream: kind === "ad" ? "ad" : "ig", story: slug, sound: hook ? "new hook (our voice) + his narration + bed" : o.voice ? "our voice + bed" : "narration + bed" },
      });
      await noteMade(s.ideaId, id).catch(() => null);
      made.push(id);
    }
    Object.assign(c, { status: "done", job_id: made[0], made: made.length, note: "Trial reel on Launch → Instagram; the ad on Launch → Ads." });
  })().catch((e) => Object.assign(c, { status: "error", error: (e as Error).message }));
  return c;
}
