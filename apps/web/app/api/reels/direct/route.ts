import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { submitWhenRead } from "@/lib/clip-reader";
import { directJob, engine, soundLibrary } from "@/lib/reels";
import { styleTemplates } from "@/lib/templates";

export const dynamic = "force-dynamic";

/** The trend template library + editing rules, and how many trending sounds are in the library. */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const [lib, sounds] = await Promise.all([engine().getTemplates().catch(() => ({ templates: [], rules: {} })), soundLibrary()]);
  return Response.json({ ...lib, sounds });
}

/** Director batch: judge the checked clips, cast them into the chosen templates, a test set per template. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as { clipIds?: string[]; templateIds?: string[]; perTemplate?: number; hook?: string; place?: string };
  if (!b.clipIds?.length) return Response.json({ error: "Drop or check some clips first" }, { status: 400 });
  if (!b.templateIds?.length) return Response.json({ error: "Pick at least one template" }, { status: 400 });
  if (b.hook && /\[[^\]]+\]/.test(b.hook)) return Response.json({ error: "Fill in the blanks in your hook first" }, { status: 400 });
  // style-<ref> ids: that reference's style copy = a library structure + its own hook, look and name
  const styles = new Map(styleTemplates(await getRepo().list("reel_refs")).map((t) => [t.id, t]));
  const specs = b.templateIds.map((id) => {
    const st = styles.get(id);
    return st ? { id: st.base, as: id, name: st.name, grade: st.look ?? undefined, hooks: st.hook ? [st.hook] : undefined } : id;
  });
  const request = await directJob({ clipIds: b.clipIds, templateIds: specs, perTemplate: b.perTemplate ?? 3, hook: b.hook, place: b.place });
  if (!request.clips.length) return Response.json({ error: "Those clips aren't in the bin anymore. Check the clips you want and try again." }, { status: 400 });
  const e = engine();
  const created = await submitWhenRead(request); // reads any unread clip first, then renders
  const [row] = await getRepo().insert("reel_jobs", [{
    job_id: created.job_id, status: created.status, created_at: new Date().toISOString(), request, manifest: null, error: null, stub: e.stub,
  }]);
  return Response.json(row);
}
