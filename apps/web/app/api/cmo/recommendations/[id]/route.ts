import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { status } = (await req.json()) as { status: "new" | "accepted" | "dismissed" };
  if (!["new", "accepted", "dismissed"].includes(status)) return Response.json({ error: "bad status" }, { status: 400 });
  const n = await getRepo().update("cmo_recommendations", { id: params.id }, { status });
  return n ? Response.json({ ok: true }) : Response.json({ error: "not found" }, { status: 404 });
}
