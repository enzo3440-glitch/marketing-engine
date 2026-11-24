import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { submitWhenRead } from "@/lib/clip-reader";
import { engine } from "@/lib/reels";

/** Resubmit a failed (or stuck) job with its original request; same job id, fresh render. */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const repo = getRepo();
  const [job] = await repo.list("reel_jobs", { eq: { job_id: params.id } });
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  if (job.status === "done") return Response.json({ error: "job already finished" }, { status: 409 });
  if (!job.request.clips?.length) return Response.json({ error: "imported job has no original request to resubmit" }, { status: 400 });
  const created = await submitWhenRead(job.request);
  await repo.remove("reel_variants", { job_id: job.job_id });
  await repo.update("reel_jobs", { job_id: job.job_id }, { status: created.status, error: null, manifest: null, created_at: new Date().toISOString() });
  return Response.json({ ok: true, status: created.status });
}
