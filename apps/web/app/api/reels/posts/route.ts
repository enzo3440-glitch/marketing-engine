import { getRepo, type ReelPost } from "@engine/db";
import { guardApi } from "@/lib/auth";

const METRICS = ["views", "avg_watch_s", "likes", "comments", "shares", "saves", "follows"] as const;

/** Mark a variant posted (platform + URL + the in-app sound, if any). */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as Pick<ReelPost, "job_id" | "variant_id" | "platform" | "url" | "sound">;
  if (!["ig", "tiktok"].includes(b.platform)) return Response.json({ error: "platform must be ig|tiktok" }, { status: 400 });
  const repo = getRepo();
  const posts = await repo.list("reel_posts");
  const id = Math.max(0, ...posts.map((p) => Number(p.id) || 0)) + 1;
  const [row] = await repo.insert("reel_posts", [{
    ...(repo.mode === "mock" ? { id } : {}), job_id: b.job_id, variant_id: b.variant_id, platform: b.platform, url: b.url || null, sound: b.sound || null,
    posted_at: new Date().toISOString(), views: null, avg_watch_s: null, likes: null, comments: null, shares: null, saves: null, follows: null, updated_at: new Date().toISOString(),
  }]);
  return Response.json(row);
}

/** Log 48-72h metrics for a post. */
export async function PATCH(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as Partial<ReelPost> & { id: number };
  const patch: Partial<ReelPost> = { updated_at: new Date().toISOString() };
  for (const k of METRICS) if (k in b) (patch as Record<string, unknown>)[k] = b[k] == null || (b[k] as unknown) === "" ? null : Number(b[k]);
  await getRepo().update("reel_posts", { id: Number(b.id) }, patch);
  return Response.json({ ok: true });
}
