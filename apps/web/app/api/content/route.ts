import { getRepo, type ContentItem } from "@engine/db";
import { guardApi } from "@/lib/auth";

export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { title, platform } = (await req.json()) as { title: string; platform: ContentItem["platform"] };
  if (!title?.trim()) return Response.json({ error: "title required" }, { status: 400 });
  const [row] = await getRepo().insert("content_items", [{
    id: `c-${Date.now().toString(36)}`, platform: platform === "tiktok" ? "tiktok" : "instagram", kind: "reel", status: "idea",
    title: title.trim(), caption: null, media_url: null, scheduled_at: null, posted_at: null, views: null, likes: null,
    saves: null, shares: null, attributed_signups: null, source: "desk", meta: {},
  }]);
  return Response.json(row);
}
