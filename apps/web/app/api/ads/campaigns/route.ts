import { getRepo } from "@engine/db";
import { metaLink, planBlank, planFromConcept } from "@/lib/ad-campaigns";
import { guardApi } from "@/lib/auth";

/** Campaigns on the calendar + whether the desk is connected to the Meta ad account (?fresh=1 re-checks). */
export async function GET(req: Request) {
  const s = await guardApi("calendar");
  if (s instanceof Response) return s;
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const [campaigns, meta] = await Promise.all([getRepo().list("ad_campaigns", { order: { col: "starts_on" } }), metaLink(fresh)]);
  return Response.json({ campaigns, meta });
}

/** Schedule a Marketing Map ad concept ({concept_id}), or start a blank campaign from Launch ({blank: true, title?}). */
export async function POST(req: Request) {
  const s = await guardApi("calendar");
  if (s instanceof Response) return s;
  const { concept_id, blank, title } = (await req.json().catch(() => ({}))) as { concept_id?: string; blank?: boolean; title?: string };
  if (!concept_id && !blank) return Response.json({ error: "concept_id or blank required" }, { status: 400 });
  try {
    return Response.json(blank ? await planBlank(title) : await planFromConcept(concept_id!));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
