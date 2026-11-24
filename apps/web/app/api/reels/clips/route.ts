import { getRepo, type ReelClip } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { queueClipReads } from "@/lib/clip-reader";
import { engine } from "@/lib/reels";

const SAFE = /^[\w.\- ]+$/; // same rule as engine/server.py

/** Engine rhythm profile -> clip kind. Informational: renders use every checked clip whatever its kind. */
function autoKind(p: Record<string, unknown> | null): ReelClip["kind"] {
  if (!p) return null;
  if (p.talking_likely) return "talking";
  if (Number(p.shots) <= 1 && Number(p.duration) >= 6) return "oneshot";
  return "broll";
}

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const clips = await getRepo().list("reel_clips", { order: { col: "added_at", asc: false } });
  queueClipReads([...clips].reverse()); // any clip not yet looked at gets read in the background, oldest first
  return Response.json(clips);
}

/** Drop zone: raw body streamed to the engine's POST /upload, then recorded in reel_clips. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const url = new URL(req.url);
  const name = (url.searchParams.get("name") ?? "").replace(/[^\w.\- ]/g, "_");
  if (!SAFE.test(name) || !/\.(mp4|mov|m4v|webm)$/i.test(name)) return Response.json({ error: "video file name required (.mp4/.mov/.m4v/.webm)" }, { status: 400 });
  if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });
  const e = engine();
  const up = e.stub ? { path: name, bytes: Number(req.headers.get("content-length") ?? 0) } : await e.upload(name, req.body);
  const repo = getRepo();
  const existing = (await repo.list("reel_clips")).find((c) => c.file === up.path);
  if (existing) return Response.json(existing);
  const auto = e.stub ? null : await e.analyzeRef(up.path).catch(() => null);
  const kind = (url.searchParams.get("kind") as ReelClip["kind"]) ?? autoKind(auto);
  const [row] = await repo.insert("reel_clips", [{
    id: `c${Date.now().toString(36)}`, file: up.path, source: "upload", kind, star: false, tags: [], thumb: null, quality: null,
    duration: typeof auto?.duration === "number" ? auto.duration : null, talking_likely: typeof auto?.talking_likely === "boolean" ? auto.talking_likely : null,
    added_at: new Date().toISOString(),
  }]);
  if (!e.stub) queueClipReads([row]);
  return Response.json({ ...row, stub: e.stub });
}

/**
 * Clear the bin: removes clips from the list (`ids`, or every clip except `keep`).
 * The footage files stay on the engine, so finished renders keep working.
 */
export async function DELETE(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; keep?: string[] };
  const repo = getRepo();
  const all = await repo.list("reel_clips");
  const drop = body.ids ? all.filter((c) => body.ids!.includes(c.id)) : all.filter((c) => !(body.keep ?? []).includes(c.id));
  for (const c of drop) await repo.remove("reel_clips", { id: c.id });
  return Response.json({ removed: drop.length, left: all.length - drop.length });
}
