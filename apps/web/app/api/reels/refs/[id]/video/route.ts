import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { engine } from "@/lib/reels";

/** The reference video you dropped, so a template card can show what it copies. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const [ref] = await getRepo().list("reel_refs", { eq: { id: params.id } });
  if (!ref?.file) return Response.json({ error: "no video for this reference" }, { status: 404 });
  const res = await engine().fetchRefVideo(ref.file);
  if (!res?.ok) return Response.json({ error: "video unavailable (engine offline?)" }, { status: 404 });
  return new Response(res.body, { headers: { "Content-Type": res.headers.get("Content-Type") ?? "video/mp4", "Cache-Control": "private, max-age=3600" } });
}
