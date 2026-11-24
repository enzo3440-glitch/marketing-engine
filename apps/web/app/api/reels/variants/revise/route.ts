import { guardApi } from "@/lib/auth";
import { revisions, startRevision } from "@/lib/reel-revise";

/** Revisions running or finished for a batch's videos: ?job_id=<batch> → {<video>: {status, ask, id, summary, error}} */
export async function GET(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const jobId = new URL(req.url).searchParams.get("job_id");
  if (!jobId) return Response.json({ error: "job_id" }, { status: 400 });
  return Response.json(revisions(jobId));
}

/** Ask Claude to change one video: {job_id, id, ask}. It renders as a new copy beside the original. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { job_id, id, ask } = (await req.json()) as { job_id?: string; id?: string; ask?: string };
  const text = ask?.trim() ?? "";
  if (!job_id || !id || text.length < 3) return Response.json({ error: "say what to change" }, { status: 400 });
  try {
    return Response.json(startRevision(job_id, id, text.slice(0, 1000)));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
