import { guardApi } from "@/lib/auth";
import { noteMade } from "@/lib/ideas";
import { importVideo } from "@/lib/video-import";

/** Form data: video (mp4/mov), script?, caption?, idea_id?, made_by? ("brag" for a /brag render). */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const f = await req.formData();
  const video = f.get("video");
  if (!(video instanceof File) || !/\.(mp4|mov|m4v)$/i.test(video.name)) return Response.json({ error: "Attach an .mp4 or .mov" }, { status: 400 });
  if (video.size > 500 * 1024 * 1024) return Response.json({ error: "Over 500 MB" }, { status: 413 });
  const ideaId = String(f.get("idea_id") ?? "") || null;
  const madeBy = String(f.get("made_by") ?? "") === "brag" ? "brag" : "import";
  const id = await importVideo({
    video: Buffer.from(await video.arrayBuffer()), name: video.name, script: String(f.get("script") ?? "").slice(0, 4000),
    caption: String(f.get("caption") ?? "").slice(0, 2200), ideaId, madeBy,
  });
  if (ideaId) await noteMade(ideaId, id);
  return Response.json({ job_id: id });
}
