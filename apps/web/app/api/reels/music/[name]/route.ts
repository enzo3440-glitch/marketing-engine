import { guardApi } from "@/lib/auth";
import { engine } from "@/lib/reels";

/** Preview a track (hover in the batch builder). Proxied so REEL_TOKEN stays server-side. */
export async function GET(_req: Request, { params }: { params: { name: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  if (!/^[\w.\- ]+\.(mp3|m4a|wav|aac|ogg)$/i.test(params.name)) return Response.json({ error: "bad name" }, { status: 400 });
  const res = await engine().fetchMusic(params.name);
  if (!res?.ok) return Response.json({ error: "track unavailable (engine offline?)" }, { status: 404 });
  return new Response(res.body, { headers: { "Content-Type": res.headers.get("Content-Type") ?? "audio/mpeg", "Cache-Control": "private, max-age=86400" } });
}
