import { guardApi } from "@/lib/auth";
import { engine, soundLibrary } from "@/lib/reels";

export const dynamic = "force-dynamic";

/** The sound library: trending songs you dropped in + the audio of reference reels. No stock tracks. */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json(await soundLibrary());
}

/** Upload a song (raw body, ?name=song.mp3). It's stored on the engine and selectable as music/<name>. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const name = new URL(req.url).searchParams.get("name")?.replace(/[^\w.\- ]+/g, "_") ?? "";
  if (!/\.(mp3|m4a|wav|aac|ogg)$/i.test(name)) return Response.json({ error: "Songs must be mp3, m4a, wav, aac or ogg" }, { status: 400 });
  if (!req.body) return Response.json({ error: "Empty upload" }, { status: 400 });
  try {
    return Response.json(await engine().uploadMusic(name, req.body));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
