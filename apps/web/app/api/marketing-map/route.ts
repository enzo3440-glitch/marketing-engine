import { getRepo, isConflict, type MarketingMapDoc } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { validateMap } from "@/lib/marketing-map";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json(await getRepo().getMap());
}

/** Save the whole map. Requires the revision the client last read (no silent overwrites). */
export async function PUT(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  if (Number(req.headers.get("content-length") ?? 0) > 300000) return Response.json({ error: "Payload too large" }, { status: 413 });
  const { map, expectedRevision } = (await req.json()) as { map: MarketingMapDoc; expectedRevision: number };
  if (typeof expectedRevision !== "number") return Response.json({ error: "expectedRevision is required. Read the map first." }, { status: 400 });
  try {
    validateMap(map);
    return Response.json(await getRepo().saveMap(map, expectedRevision));
  } catch (e) {
    if (isConflict(e)) return Response.json({ error: "Another edit was saved. Reload and merge your change.", current: e.current }, { status: 409 });
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
