import { guardApi } from "@/lib/auth";
import { ensureStoryIdeas, listStoryDocs, makeStoryDoc } from "@/lib/story-docs";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  await ensureStoryIdeas().catch(() => null);
  return Response.json(listStoryDocs());
}

/**
 * Form data: slug, and one of: audio (his narration: wav, mp3, m4a) · voice=1 (read the script in our voice model) ·
 * hook=<new first paragraph> (in our voice, joined to his recording). Renders the trial reel and the ad; both land on Launch.
 */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const f = await req.formData();
  const audio = f.get("audio");
  const slug = String(f.get("slug") ?? "");
  const hook = String(f.get("hook") ?? "").trim().slice(0, 400);
  const voice = f.get("voice") === "1";
  try {
    if (audio instanceof File) {
      const ext = /\.(wav|mp3|m4a|aac|flac|ogg)$/i.exec(audio.name)?.[1]?.toLowerCase();
      if (!ext) return Response.json({ error: "Attach the narration (.wav, .mp3, .m4a, .flac)" }, { status: 400 });
      if (audio.size > 200 * 1024 * 1024) return Response.json({ error: "Over 200 MB" }, { status: 413 });
      return Response.json(makeStoryDoc(slug, { audio: Buffer.from(await audio.arrayBuffer()), ext }));
    }
    return Response.json(makeStoryDoc(slug, { voice, hook: hook || undefined }));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
