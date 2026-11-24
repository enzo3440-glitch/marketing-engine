import { getRepo, type ContentItem } from "@engine/db";
import { guardApi } from "@/lib/auth";

const NEXT: Record<string, ContentItem["status"][]> = { idea: ["draft"], draft: [], approved: ["scheduled"], scheduled: ["posted"], posted: [] };

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const body = (await req.json()) as Partial<ContentItem> & { gates?: { reviewed?: boolean; tested?: boolean } };
  const repo = getRepo();
  const [cur] = await repo.list("content_items", { eq: { id: params.id } });
  if (!cur) return Response.json({ error: "not found" }, { status: 404 });
  const patch: Partial<ContentItem> = {};
  const was = cur.status; // the mock repo updates rows in place, so read this before the update
  // Plan ideas (marketing guide templates) carry review gates: reviewed and tested, then approval.
  const gates = (cur.meta as { gates?: Record<string, unknown> }).gates;
  if (body.gates && gates) {
    const next = { ...gates };
    for (const k of ["reviewed", "tested"] as const) {
      if (typeof body.gates[k] === "boolean") Object.assign(next, { [k]: body.gates[k], [`${k}_by`]: body.gates[k] ? s.email : undefined });
    }
    patch.meta = { ...cur.meta, gates: next };
  }
  if (body.status) {
    const g = (patch.meta?.gates ?? gates) as { reviewed?: boolean; tested?: boolean } | undefined;
    if (cur.status === "idea" && body.status === "draft" && g && !(g.reviewed && g.tested)) {
      return Response.json({ error: "Review and test this idea before it goes for approval" }, { status: 409 });
    }
    // draft → approved happens only via the approval queue.
    if (!NEXT[cur.status].includes(body.status)) return Response.json({ error: `can't move ${cur.status} → ${body.status} here` }, { status: 409 });
    patch.status = body.status;
    if (body.status === "posted") patch.posted_at = new Date().toISOString();
    if (body.status === "scheduled" && !cur.scheduled_at) patch.scheduled_at = new Date(Date.now() + 86400_000).toISOString();
  }
  for (const k of ["caption", "scheduled_at", "views", "likes", "saves", "shares", "attributed_signups"] as const) {
    if (k in body) (patch as Record<string, unknown>)[k] = body[k];
  }
  await repo.update("content_items", { id: params.id }, patch);
  // A reviewed + tested plan idea becomes a draft and goes straight to the approvals queue.
  if (gates && was === "idea" && patch.status === "draft") {
    const m = cur.meta as { hook?: string; beats?: string[]; hypothesis?: string; measure?: string; pillar?: string; channel?: string; format?: string; template?: string };
    await repo.insert("approvals", [{
      id: crypto.randomUUID(), type: "post", ref_table: "content_items", ref_id: cur.id, title: `Idea: ${cur.title}`,
      summary: `${m.channel ?? cur.platform} · ${m.pillar ?? ""} · ${m.format ?? ""}. Reviewed and tested; approve to produce and schedule it.`,
      preview: { caption: m.hook ?? cur.caption, bullets: [...(m.beats ?? []), `Hypothesis: ${m.hypothesis ?? "—"}`, `Measure: ${m.measure ?? "—"}`] },
      status: "pending", created_by_agent: s.email, decided_by: null, decided_at: null, result: null, created_at: new Date().toISOString(),
    }]);
  }
  return Response.json({ ...cur, ...patch });
}
