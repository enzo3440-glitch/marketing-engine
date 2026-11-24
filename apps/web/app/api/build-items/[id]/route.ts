import { getRepo, type BuildItem } from "@engine/db";
import { guardApi } from "@/lib/auth";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("build");
  if (s instanceof Response) return s;
  const body = (await req.json()) as Partial<Pick<BuildItem, "status" | "priority" | "notes">>;
  const patch: Partial<BuildItem> = {};
  if (body.status && ["backlog", "active", "done"].includes(body.status)) patch.status = body.status;
  if (typeof body.priority === "number") patch.priority = body.priority;
  if (typeof body.notes === "string") patch.notes = body.notes;
  const n = await getRepo().update("build_items", { id: params.id }, patch);
  return n ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}
