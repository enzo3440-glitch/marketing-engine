import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";

/** Star a keeper (picked) or send a variant to the approval queue as a post draft. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { job_id, id, action, picked, platform = "instagram" } = (await req.json()) as { job_id: string; id: string; action: "pick" | "approve"; picked?: boolean; platform?: "instagram" | "tiktok" };
  const repo = getRepo();
  const [v] = await repo.list("reel_variants", { eq: { job_id, id } });
  if (!v) return Response.json({ error: "variant not found" }, { status: 404 });
  if (action === "pick") {
    await repo.update("reel_variants", { job_id, id }, { picked: Boolean(picked) });
    return Response.json({ ok: true });
  }
  const contentId = `reel-${job_id}-${id}`.slice(0, 80);
  const [existing] = await repo.list("content_items", { eq: { id: contentId } });
  if (!existing) {
    await repo.insert("content_items", [{
      id: contentId, platform, kind: "reel", status: "draft", title: v.hook ?? id, caption: v.caption, media_url: v.file ? `/api/reels/files/${job_id}/${v.file}` : null,
      scheduled_at: null, posted_at: null, views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: "reel_engine",
      meta: { job_id, variant_id: id, format: v.format, hook_id: v.hook_id, bare: v.bare },
    }]);
  }
  await repo.update("reel_variants", { job_id, id }, { picked: true });
  const [a] = await repo.insert("approvals", [{
    id: crypto.randomUUID(), type: "post", ref_table: "content_items", ref_id: contentId, title: `Reel: ${v.hook ?? id}`,
    summary: `${v.format} · ${v.grade ?? "clean"} · ${v.duration ?? "?"}s · hook ${v.hook_id ?? "—"}. Post the _bare cut if adding a trending sound in-app.`,
    preview: { caption: v.caption, platform, video: v.file, bare: v.bare }, status: "pending", created_by_agent: s.email,
    decided_by: null, decided_at: null, result: null, created_at: new Date().toISOString(),
  }]);
  return Response.json(a);
}
