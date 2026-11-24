import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { clipReadStatus, queueClipReads, valid } from "@/lib/clip-reader";

/** Whether a read session (Claude Code on your subscription) is running, and how the last one ended. */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json(clipReadStatus());
}

/**
 * {reads: [{id, ...read}]}: save reads (what the MCP tool save_clip_read calls).
 * {ids}: drop those clips' reads and read them again.
 */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; reads?: ({ id: string } & Record<string, unknown>)[] };
  const repo = getRepo();
  const clips = await repo.list("reel_clips");
  if (body.reads?.length) {
    let saved = 0;
    for (const r of body.reads) {
      const c = clips.find((x) => x.id === r.id);
      const read = c && valid(r, c.duration ?? Infinity);
      if (!c || !read) continue;
      await repo.update("reel_clips", { id: c.id }, { read: { ...read, read_at: new Date().toISOString() }, read_error: undefined });
      saved++;
    }
    return Response.json({ saved });
  }
  const again = clips.filter((c) => body.ids?.includes(c.id));
  for (const c of again) await repo.update("reel_clips", { id: c.id }, { read: undefined, read_error: undefined });
  return Response.json({ queued: queueClipReads(again.map((c) => ({ ...c, read: undefined }))) });
}
