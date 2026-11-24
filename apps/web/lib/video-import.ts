import "server-only";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRepo } from "@engine/db";
import { importEngineJobs, engine, syncJob } from "./reels";

/**
 * Bring a finished video made elsewhere (a /brag render, an edit from your phone) into the desk as a one-video batch
 * with its script and caption, so it can be launched like anything made here. The engine and the desk share this
 * machine's disk (REEL_DATA_DIR, default services/reel-engine/reel-data).
 */
const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
// the engine's bundled ffmpeg (run-local.cmd) when it isn't installed
const BUNDLED = path.resolve(process.cwd(), "../../services/reel-engine/bin/ffmpeg.exe");
const FFMPEG = process.env.FFMPEG || (fs.existsSync(BUNDLED) ? BUNDLED : "ffmpeg");

// text a Windows shell wrote as UTF-8 twice ("â€¦" for "…"): put the usual punctuation back
const MOJIBAKE: [string, string][] = [
  ["â€¦", "…"], ["â€™", "’"], ["â€˜", "‘"], ["â€œ", "“"],
  ["â€\u009d", "”"], ["â€”", "—"], ["â€“", "–"], ["Ã©", "é"],
  ["Ã¨", "è"], ["Ã ", "à"], ["Ã²", "ò"], ["Ã¹", "ù"], ["Ê»", "ʻ"],
];
export const unmangle = (s: string) => MOJIBAKE.reduce((t, [bad, good]) => t.split(bad).join(good), s);

export async function importVideo(o: { video: Buffer; name: string; script: string; caption: string; ideaId: string | null; madeBy: string; tags?: Record<string, string> }): Promise<string> {
  const id = `imp-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  const dest = path.join(DATA, "output", id);
  fs.mkdirSync(dest, { recursive: true });
  const ext = (/\.(mp4|mov|m4v)$/i.exec(o.name)?.[1] ?? "mp4").toLowerCase();
  const file = path.join(dest, `video.${ext}`), poster = path.join(dest, "video.jpg"), cap = path.join(dest, "video.txt");
  fs.writeFileSync(file, o.video);
  o = { ...o, script: unmangle(o.script), caption: unmangle(o.caption) };
  fs.writeFileSync(cap, o.caption);
  spawnSync(FFMPEG, ["-y", "-ss", "1", "-i", file, "-frames:v", "1", poster], { windowsHide: true });
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({
    job_id: id, clips: {}, variants: [{
      id: "video", format: o.madeBy, file, poster: fs.existsSync(poster) ? poster : null, caption_file: cap,
      hook: cleanHook(o.script),
      tags: { made_by: o.madeBy, script: o.script.slice(0, 4000), ...(o.ideaId ? { idea: o.ideaId } : {}), ...(o.tags ?? {}) },
    }],
  }, null, 1));
  await adoptImports();
  return id;
}

/** The hook as a viewer reads it. Briefs sometimes start with an editing note ("Hook (frame one, 0.0 s): ...", "[hook, no
 * text, 0-2.97 s] ..."). Skip those and use the first line that's real on-screen text. */
export function cleanHook(script: string): string | null {
  const note = /^\s*(\[|\(|hook\s*\(|format:|cta:|sound:|look:)|\b\d+(\.\d+)?\s*-\s*\d+(\.\d+)?\s*s\b|\b\d+\.\d+\s*s\b|IMG_\d+/i;
  const lines = script.split("\n")
    .map((l) => l.replace(/^hook:\s*/i, "").replace(/\s*\((on screen|over|lands)[^)]*\)\s*$/i, "").trim())
    .filter(Boolean);
  return lines.find((l) => !note.test(l))?.slice(0, 200) ?? null;
}

/** Bring saved imports onto Launch. An engine started before /rehydrate existed (or not running) loads them on its
 * next start instead (it reads each output folder's manifest.json); Launch calls this again, so they show up then. */
export async function adoptImports(): Promise<void> {
  await engine().rehydrate().catch(() => null);
  await importEngineJobs().catch(() => 0);
  const waiting = (await getRepo().list("reel_jobs")).filter((j) => j.job_id.startsWith("imp-") && j.status !== "done");
  for (const j of waiting) await syncJob(j).catch(() => null);
}
