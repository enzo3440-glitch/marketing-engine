import { guardApi } from "@/lib/auth";
import { creations, refreshCreations, startCreation, type CreateKind } from "@/lib/reel-create";

export const dynamic = "force-dynamic";

/** What the request box has made or is making (newest first). */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  await refreshCreations();
  return Response.json(creations());
}

/** {ask, kind?, count?, clipIds?, attached?}: Claude writes it, the engine renders it as a new batch (lib/reel-create.ts). */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as { ask?: string; kind?: CreateKind; count?: number; clipIds?: string[]; attached?: string[] };
  const ask = (b.ask ?? "").trim();
  if (ask.length < 4) return Response.json({ error: "Say what you want made" }, { status: 400 });
  const kind: CreateKind = ["auto", "ad", "reel", "carousel"].includes(b.kind ?? "") ? b.kind! : "auto";
  return Response.json(startCreation(ask.slice(0, 2000), kind, Number(b.count) || 1, b.clipIds ?? [], b.attached ?? []));
}
