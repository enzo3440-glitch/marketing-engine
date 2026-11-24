import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * A clip from the bin, straight off this machine's disk (the engine and the desk share it): ?thumb=1 gives a small
 * poster frame (made once, then cached), otherwise the video itself with Range support so the preview starts at once.
 */
const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const BUNDLED = path.resolve(process.cwd(), "../../services/reel-engine/bin/ffmpeg.exe");
const FFMPEG = process.env.FFMPEG || (fs.existsSync(BUNDLED) ? BUNDLED : "ffmpeg");
const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime" };

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const [clip] = await getRepo().list("reel_clips", { eq: { id: params.id } });
  if (!clip) return new Response("not found", { status: 404 });
  const file = path.join(DATA, "input", path.basename(clip.file));
  if (!fs.existsSync(file)) return new Response("file is gone", { status: 404 });

  if (new URL(req.url).searchParams.get("thumb")) {
    const dir = path.join(DATA, "cache", "thumbs");
    const thumb = path.join(dir, `${path.basename(clip.file)}.jpg`);
    if (!fs.existsSync(thumb)) {
      fs.mkdirSync(dir, { recursive: true });
      const at = Math.min(1.5, Math.max(0, (clip.duration ?? 2) / 2));
      spawnSync(FFMPEG, ["-v", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=240:-2", thumb], { windowsHide: true });
    }
    if (!fs.existsSync(thumb)) return new Response("no frame", { status: 404 });
    return new Response(fs.readFileSync(thumb), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  }

  // ?preview=1: a small H.264 copy (phone .mov files are often HEVC, which the browser can't play), made once
  let src = file;
  if (new URL(req.url).searchParams.get("preview")) {
    const dir = path.join(DATA, "cache", "previews");
    const out = path.join(dir, `${path.basename(clip.file)}.mp4`);
    if (!fs.existsSync(out)) {
      fs.mkdirSync(dir, { recursive: true });
      spawnSync(FFMPEG, ["-v", "error", "-y", "-i", file, "-t", "30", "-vf", "scale=-2:640", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out], { windowsHide: true, timeout: 120_000 });
    }
    if (fs.existsSync(out)) src = out;
  }
  const size = fs.statSync(src).size;
  const type = TYPES[path.extname(src).toLowerCase()] ?? "video/mp4";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  const body = Readable.toWeb(fs.createReadStream(src, { start, end })) as ReadableStream;
  return new Response(body, {
    status: m ? 206 : 200,
    headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) },
  });
}
