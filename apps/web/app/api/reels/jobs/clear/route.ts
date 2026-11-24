import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { deleteVideos, importEngineJobs, syncJob } from "@/lib/reels";

export const dynamic = "force-dynamic";

/** Clear only touches batches made here in the desk; ones from elsewhere (CLI brag remixes, autopilot, seeds) stay
 * unless you delete them one by one. */
const madeHere = (j: { job_id: string; stub?: boolean; request?: { defaults?: Record<string, unknown> } }) =>
  !j.stub && !j.request?.defaults?.imported && /^(dir|tpl|reel)-\d/.test(j.job_id);

/** Batches the engine finished (incl. ones only on disk) get their videos recorded first, so none are missed. */
async function settled() {
  await importEngineJobs();
  for (const j of await getRepo().list("reel_jobs")) await syncJob(j).catch(() => j);
}

/** What "clear" would remove: every finished video that isn't starred as a keeper or posted. */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const repo = getRepo();
  await settled();
  const [jobs, variants, posts] = await Promise.all([repo.list("reel_jobs"), repo.list("reel_variants"), repo.list("reel_posts")]);
  const done = new Set(jobs.filter((j) => (j.status === "done" || j.status === "error") && madeHere(j)).map((j) => j.job_id));
  const posted = new Set(posts.map((p) => `${p.job_id}/${p.variant_id}`));
  const mine = variants.filter((v) => done.has(v.job_id));
  const keep = mine.filter((v) => v.picked || posted.has(`${v.job_id}/${v.id}`));
  return Response.json({ videos: mine.length - keep.length, kept: keep.length, batches: done.size });
}

/** Clear every finished batch down to its keepers (starred or posted); batches with none go entirely. */
export async function POST() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  await settled();
  const jobs = (await getRepo().list("reel_jobs")).filter((j) => (j.status === "done" || j.status === "error") && madeHere(j));
  let deleted = 0, kept = 0, batches = 0;
  const failed: string[] = [];
  for (const j of jobs) {
    try {
      const r = await deleteVideos(j.job_id, null, true);
      deleted += r.deleted; kept += r.kept; batches += r.job_deleted ? 1 : 0;
    } catch {
      failed.push(j.job_id);
    }
  }
  return Response.json({ deleted, kept, batches_removed: batches, failed });
}
