import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { bragTweak, startBragTweak } from "@/lib/brag-tweak";
import { revisions, startRevision } from "@/lib/reel-revise";

export const dynamic = "force-dynamic";

/** The change running or last made to a video: ?job_id&variant_id → {status, ask, summary, error, job_id?} or null. */
export async function GET(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const u = new URL(req.url);
  const job = u.searchParams.get("job_id"), id = u.searchParams.get("variant_id");
  if (!job || !id) return Response.json({ error: "job_id and variant_id" }, { status: 400 });
  return Response.json(bragTweak(job, id) ?? revisions(job)[id] ?? null);
}

/**
 * Change one video: {job_id, variant_id, ask, as_new?}. as_new makes the new cut its own video on Launch (an A/B
 * partner) instead of the newer version of this one. /brag ads go back into the folder they were made in; videos the engine
 * made are revised from their brief. Either way the new cut lands beside the original, which stays.
 */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { job_id, variant_id, ask, as_new } = (await req.json()) as { job_id?: string; variant_id?: string; ask?: string; as_new?: boolean };
  const text = ask?.trim() ?? "";
  if (!job_id || !variant_id || text.length < 3) return Response.json({ error: "Say what to change" }, { status: 400 });
  const [v] = await getRepo().list("reel_variants", { eq: { job_id, id: variant_id } });
  if (!v) return Response.json({ error: "That video is gone" }, { status: 404 });
  try {
    return Response.json(String(v.tags?.made_by ?? "").startsWith("brag")
      ? await startBragTweak(job_id, variant_id, text.slice(0, 1000), !!as_new)
      : startRevision(job_id, variant_id, text.slice(0, 1000)));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
