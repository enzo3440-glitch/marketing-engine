import { getRepo, type ReelHook } from "@engine/db";
import { guardApi } from "@/lib/auth";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json(await getRepo().list("reel_hooks"));
}

/** Add a hook to the pool (dedupes on text). */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { text, source = "owner", framework = null } = (await req.json()) as { text?: string; source?: ReelHook["source"]; framework?: string | null };
  const t = text?.trim();
  if (!t) return Response.json({ error: "text required" }, { status: 400 });
  const repo = getRepo();
  const hooks = await repo.list("reel_hooks");
  const dup = hooks.find((h) => h.text.toLowerCase() === t.toLowerCase());
  if (dup) return Response.json({ ...dup, existed: true });
  const next = Math.max(0, ...hooks.map((h) => Number(h.id.replace(/\D/g, "")) || 0)) + 1;
  const [row] = await repo.insert("reel_hooks", [{
    id: `h${next}`, text: t, framework, source: ["claude", "radar", "owner", "map"].includes(source) ? source : "owner", status: "new", created_at: new Date().toISOString(),
  }]);
  return Response.json({ ...row, existed: false });
}

export async function PATCH(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { id, status } = (await req.json()) as { id: string; status: ReelHook["status"] };
  if (!["new", "testing", "winner", "retired"].includes(status)) return Response.json({ error: "bad status" }, { status: 400 });
  await getRepo().update("reel_hooks", { id }, { status });
  return Response.json({ ok: true });
}
