import { guardApi } from "@/lib/auth";
import { improveCampaign, improvePost } from "@/lib/improve";

export const dynamic = "force-dynamic";

/** The Improve button on a campaign or an Instagram post: {kind: "campaign", id} | {kind: "post", id, caption}. */
export async function POST(req: Request) {
  const s = await guardApi("content", "growth", "calendar");
  if (s instanceof Response) return s;
  const b = (await req.json().catch(() => ({}))) as { kind?: string; id?: string; caption?: string };
  try {
    if (b.kind === "campaign" && b.id) return Response.json(await improveCampaign(b.id, s.email));
    if (b.kind === "post" && b.id) return Response.json(await improvePost(b.id, b.caption ?? "", s.email));
    return Response.json({ error: "kind must be campaign or post, with an id" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
