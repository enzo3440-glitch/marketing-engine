import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";

export async function POST(req: Request) {
  const s = await guardApi("capital");
  if (s instanceof Response) return s;
  const { contactId, to, subject, body } = (await req.json()) as { contactId: string; to: string; subject: string; body: string };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to ?? "")) return Response.json({ error: "valid recipient email required" }, { status: 400 });
  if (!subject?.trim() || !body?.trim()) return Response.json({ error: "subject and body required" }, { status: 400 });
  const repo = getRepo();
  const [c] = await repo.list("capital_contacts", { eq: { id: contactId } });
  if (!c) return Response.json({ error: "contact not found" }, { status: 404 });
  const [row] = await repo.insert("approvals", [{
    id: crypto.randomUUID(), type: "outreach_email", ref_table: "capital_contacts", ref_id: c.id, title: `Outreach: ${c.name} (${c.org ?? c.segment})`,
    summary: subject, preview: { to, subject, body }, status: "pending", created_by_agent: s.email, decided_by: null, decided_at: null, result: null,
    created_at: new Date().toISOString(),
  }]);
  await repo.update("capital_contacts", { id: c.id }, { stage: c.stage === "cold" ? "drafted" : c.stage });
  return Response.json(row);
}
