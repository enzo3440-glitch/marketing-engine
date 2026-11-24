import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { submitWhenRead } from "@/lib/clip-reader";
import { engine } from "@/lib/reels";
import { queueSongs } from "@/lib/ref-intake";
import { styleTemplates, templateJob, templatesFor } from "@/lib/templates";

export const dynamic = "force-dynamic";

/** Templates learned from your references, with how well each suits the clips in ?clips=a,b,c. */
export async function GET(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const url = new URL(req.url);
  if (url.searchParams.get("kind") === "style") return Response.json(styleTemplates(await getRepo().list("reel_refs")));
  const ids = (url.searchParams.get("clips") ?? "").split(",").filter(Boolean);
  queueSongs(await getRepo().list("reel_refs"));  // references not yet matched to a song merge in as they're placed
  return Response.json(await templatesFor(ids));
}

/** Make one video per chosen template from the chosen clips. Hook and music are optional overrides. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as { templateIds?: string[]; clipIds?: string[]; hook?: string; music?: string[]; place?: string };
  if (!b.clipIds?.length) return Response.json({ error: "Drop or check some clips first" }, { status: 400 });
  if (!b.templateIds?.length) return Response.json({ error: "Pick at least one template" }, { status: 400 });
  if (b.hook && /\[[^\]]+\]/.test(b.hook)) return Response.json({ error: "Fill in the blanks in your hook first" }, { status: 400 });
  const request = await templateJob({ templateIds: b.templateIds, clipIds: b.clipIds, hook: b.hook, music: b.music, place: b.place });
  if (!request.variants?.length) return Response.json({ error: "None of those templates are available" }, { status: 400 });
  const e = engine();
  const created = await submitWhenRead(request); // reads any unread clip first, then renders
  const [row] = await getRepo().insert("reel_jobs", [{
    job_id: created.job_id, status: created.status, created_at: new Date().toISOString(), request, manifest: null, error: null, stub: e.stub,
  }]);
  return Response.json(row);
}
