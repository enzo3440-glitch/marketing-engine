import { guardApi } from "@/lib/auth";
import { addIdea, generateIdeas, listIdeas, removeIdea, rerankIdeas, setArchived } from "@/lib/ideas";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json(await listIdeas());
}

/** {action: "add", title, hook?, channel?}, {action: "generate", focus?, count?}, {action: "rerank"}, {action: "archive"|"unarchive"|"delete", id} (Claude on the Max login). */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as { id?: string; action?: string; title?: string; hook?: string; channel?: string; focus?: string; count?: number };
  try {
    if (b.action === "add") {
      if (!b.title?.trim()) return Response.json({ error: "Give the idea a title" }, { status: 400 });
      return Response.json(await addIdea(b.title.trim().slice(0, 120), (b.hook ?? "").trim().slice(0, 300), b.channel ?? "ig_organic"));
    }
    if (b.action === "generate") return Response.json(await generateIdeas((b.focus ?? "").slice(0, 300), Math.min(Math.max(Number(b.count) || 5, 1), 8)));
    if (b.action === "archive" || b.action === "unarchive") { if (!b.id) throw new Error("Which idea?"); await setArchived(b.id, b.action === "archive"); return Response.json({ ok: true }); }
    if (b.action === "delete") { if (!b.id) throw new Error("Which idea?"); await removeIdea(b.id); return Response.json({ ok: true }); }
    if (b.action === "rerank") return Response.json({ ranked: await rerankIdeas(), ideas: await listIdeas() });
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
