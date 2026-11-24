import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { guardApi } from "@/lib/auth";
import { engine } from "@/lib/reels";

const OUTPUT = path.join(process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data"), "output");
const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

/**
 * Rendered media. Served straight from this machine's disk when the file is there, with byte ranges so the player's
 * slider can seek (Nov 15 2026: the engine proxy ignored Range, so seeking didn't work). Otherwise it's proxied from the
 * engine, so REEL_TOKEN never reaches the browser.
 */
export async function GET(req: Request, { params }: { params: { job: string; path: string[] } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const rel = params.path.join("/");
  if (rel.includes("..") || params.job.includes("..") || /[\\/]/.test(params.job)) return Response.json({ error: "bad path" }, { status: 400 });
  const local = path.join(OUTPUT, params.job, path.basename(rel));
  if (fs.existsSync(local)) {
    const size = fs.statSync(local).size;
    const type = TYPES[path.extname(local).toLowerCase()] ?? "application/octet-stream";
    const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      start = Math.max(0, start); end = Math.min(size - 1, end);
      if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      const body = Readable.toWeb(fs.createReadStream(local, { start, end })) as unknown as ReadableStream;
      return new Response(body, { status: 206, headers: { ...base, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` } });
    }
    const body = Readable.toWeb(fs.createReadStream(local)) as unknown as ReadableStream;
    return new Response(body, { headers: { ...base, "Content-Length": String(size) } });
  }
  const res = await engine().fetchFile(params.job, rel);
  if (!res) return Response.json({ error: "stub engine has no media; set VIDEO_ENGINE_URL" }, { status: 404 });
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" },
  });
}
