import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { deleteVideos, syncJob } from "@/lib/reels";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const repo = getRepo();
  const [job] = await repo.list("reel_jobs", { eq: { job_id: params.id } });
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const synced = await syncJob(job);
  const [variants, posts] = await Promise.all([repo.list("reel_variants", { eq: { job_id: params.id }, order: { col: "id" } }), repo.list("reel_posts", { eq: { job_id: params.id } })]);
  return Response.json({ job: synced, variants, posts });
}

/** Delete a batch, or one video of it (?variant=<id>), files included. Posted videos are kept (their results feed learning). */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const variant = new URL(req.url).searchParams.get("variant");
  try {
    return Response.json(await deleteVideos(params.id, variant ? [variant] : null));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
