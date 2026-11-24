import { getRepo, type BuildItem } from "@engine/db";
import { guardApi } from "@/lib/auth";

export async function POST(req: Request) {
  const s = await guardApi("build");
  if (s instanceof Response) return s;
  const { title, kind } = (await req.json()) as { title: string; kind: BuildItem["kind"] };
  if (!title?.trim() || !["feature", "bug", "test"].includes(kind)) return Response.json({ error: "title and kind required" }, { status: 400 });
  const [row] = await getRepo().insert("build_items", [{ id: `b-${Date.now().toString(36)}`, title: title.trim(), kind, status: "backlog", priority: 2, notes: null }]);
  return Response.json(row);
}
