import { getRepo } from "@engine/db";
import { onAdDecision } from "@/lib/ad-campaigns";
import { runProposal } from "@/lib/improve";
import { rejectPending } from "@/lib/optimize";
import { guardApi } from "@/lib/auth";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("command");
  if (s instanceof Response) return s;
  const { decision } = (await req.json()) as { decision: "approve" | "reject" };
  if (decision !== "approve" && decision !== "reject") return Response.json({ error: "decision must be approve|reject" }, { status: 400 });
  const repo = getRepo();
  const [a] = await repo.list("approvals", { eq: { id: params.id } });
  if (!a) return Response.json({ error: "not found" }, { status: 404 });
  if (a.status !== "pending") return Response.json({ error: `already ${a.status}` }, { status: 409 });
  await repo.update("approvals", { id: a.id }, { status: decision === "approve" ? "approved" : "rejected", decided_by: s.userId, decided_at: new Date().toISOString() });
  // Approving a drafted post moves its content item forward.
  if (a.ref_table === "content_items" && a.ref_id) await repo.update("content_items", { id: a.ref_id }, { status: decision === "approve" ? "approved" : "idea" });
  // Approving an ad launch builds it in Meta (paused until its start date) in the background.
  if (a.type === "ad_launch") await onAdDecision(a, decision);
  // Approving an Improve proposal carries it out (post trial reels, screen, scale, budget, pause) in the background.
  if (a.type === "optimize" && decision === "approve") void runProposal({ ...a, status: "approved" }).catch(() => {});
  // Turning down a live-optimize change (re-cut swap, repost, pause) keeps the video running as it is
  const act = (a.preview as { action?: { kind?: string; key?: string } } | null)?.action;
  if (a.type === "optimize" && decision === "reject" && act?.kind === "opt_apply" && act.key) await rejectPending(act.key).catch(() => null);
  return Response.json({ ok: true });
}
