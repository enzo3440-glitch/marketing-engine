import { getRepo, REEL_FORMATS } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { submitWhenRead } from "@/lib/clip-reader";
import { buildJobRequest, engine, importEngineJobs, syncJob, type BuilderInput } from "@/lib/reels";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  await importEngineJobs();
  const jobs = await getRepo().list("reel_jobs", { order: { col: "created_at", asc: false }, limit: 30 });
  return Response.json(await Promise.all(jobs.map(syncJob)));
}

export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as BuilderInput;
  if (!b.clipIds?.length) return Response.json({ error: "pick at least one clip" }, { status: 400 });
  if (!b.formats?.length || b.formats.some((f) => !REEL_FORMATS.includes(f as never))) return Response.json({ error: "pick valid formats" }, { status: 400 });
  if (!b.hookIds?.length) return Response.json({ error: "pick at least one hook" }, { status: 400 });
  const templates = (await getRepo().list("reel_hooks")).filter((h) => b.hookIds.includes(h.id) && /\[[^\]]+\]/.test(h.text));
  if (templates.length) {
    return Response.json({ error: `Fill in the blanks first: "${templates[0].text}" (write your version with + Add)` }, { status: 400 });
  }
  const request = await buildJobRequest({ ...b, max: Math.min(Math.max(1, b.max || 12), 48), duration: Math.min(Math.max(5, b.duration || 12), 60) });
  const e = engine();
  const created = await submitWhenRead(request); // reads any unread clip first, then renders
  const [row] = await getRepo().insert("reel_jobs", [{
    job_id: created.job_id, status: created.status, created_at: new Date().toISOString(), request, manifest: null, error: null, stub: e.stub,
  }]);
  return Response.json(row);
}
