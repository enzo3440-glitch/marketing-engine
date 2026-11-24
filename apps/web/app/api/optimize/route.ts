import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { featureBoard } from "@/lib/feature-board";
import { FEATURE_IDS } from "@/lib/features";
import { labStatus } from "@/lib/lab";
import { optimizeStatus, refreshLab, setOptimize } from "@/lib/optimize";

export const dynamic = "force-dynamic";

/** Live optimize's state and log, plus the feature board (?campaign=<id> narrows the board to one campaign). */
export async function GET(req: Request) {
  const s = await guardApi("growth", "content", "calendar");
  if (s instanceof Response) return s;
  const campaign = new URL(req.url).searchParams.get("campaign");
  return Response.json({ status: optimizeStatus(), lab: labStatus(), board: await featureBoard(campaign) });
}

/**
 * {on: boolean}: the toggle. Turning it on lets the optimizer render re-cuts and propose swaps, reposts and ad pauses; each
 * one waits for the founder's OK (Nov 18 2026). It needs the approver's access ("command"), like Decide.
 * {feature, job_id, variant_id}: set a video's feature by hand (overrides the keyword match).
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { on?: boolean; feature?: string; job_id?: string; variant_id?: string; lab?: boolean };
  // {lab: true}: rewrite the playbook (what-works.md) from the latest numbers now, instead of waiting for a verdict or the day
  if (b.lab) {
    const s = await guardApi("growth", "content");
    if (s instanceof Response) return s;
    await refreshLab();
    return Response.json({ lab: labStatus() });
  }
  if (typeof b.on === "boolean") {
    const s = await guardApi("command");
    if (s instanceof Response) return s;
    return Response.json(setOptimize(b.on, s.email ?? s.userId));
  }
  const s = await guardApi("growth", "content");
  if (s instanceof Response) return s;
  if (!b.job_id || !b.variant_id || !b.feature) return Response.json({ error: "send {on} or {feature, job_id, variant_id}" }, { status: 400 });
  if (b.feature !== "auto" && b.feature !== "other" && !FEATURE_IDS.includes(b.feature as never)) return Response.json({ error: "unknown feature" }, { status: 400 });
  const repo = getRepo();
  const [v] = await repo.list("reel_variants", { eq: { job_id: b.job_id, id: b.variant_id } });
  if (!v) return Response.json({ error: "video not found" }, { status: 404 });
  const tags = { ...(v.tags ?? {}) };
  if (b.feature === "auto") delete tags.feature; else tags.feature = b.feature;
  await repo.update("reel_variants", { job_id: v.job_id, id: v.id }, { tags });
  return Response.json({ ok: true });
}
