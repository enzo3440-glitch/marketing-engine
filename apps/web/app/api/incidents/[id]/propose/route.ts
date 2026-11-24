import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";

/** Send an incident's proposed fix to the approval queue as a fix_pr. */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("build");
  if (s instanceof Response) return s;
  const repo = getRepo();
  const [inc] = await repo.list("incidents", { eq: { id: params.id } });
  if (!inc?.proposed_fix) return Response.json({ error: "no proposed fix" }, { status: 400 });
  const existing = (await repo.list("approvals", { eq: { ref_id: inc.id, type: "fix_pr" } })).find((a) => a.status === "pending");
  if (existing) return Response.json({ error: "already pending in the approval queue" }, { status: 409 });
  const [row] = await repo.insert("approvals", [{
    id: crypto.randomUUID(), type: "fix_pr", ref_table: "incidents", ref_id: inc.id, title: `Fix PR: ${inc.title.slice(0, 80)}`,
    summary: inc.proposed_fix.summary, preview: { diff: inc.proposed_fix.diff, branch: `fix/${inc.id}` }, status: "pending",
    created_by_agent: s.email, decided_by: null, decided_at: null, result: null, created_at: new Date().toISOString(),
  }]);
  return Response.json(row);
}
