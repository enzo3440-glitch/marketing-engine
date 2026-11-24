import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { getTest, improveTest, measureTest } from "@/lib/improve";

export const dynamic = "force-dynamic";

/** {action: "improve"} → proposals to the Decide queue; {action: "measure"} → refresh results only. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content", "growth");
  if (s instanceof Response) return s;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    if (action === "measure") return Response.json(await measureTest(await getTest(params.id)));
    return Response.json(await improveTest(params.id, s.email));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content", "growth");
  if (s instanceof Response) return s;
  const t = await getTest(params.id).catch(() => null);
  if (!t) return Response.json({ error: "not found" }, { status: 404 });
  if (t.candidates.some((c) => c.screen?.ad_campaign_id || c.trial?.media_id)) return Response.json({ error: "This test has posted or spent; it stays for the record." }, { status: 409 });
  await getRepo().remove("growth_tests", { id: params.id });
  return Response.json({ ok: true });
}
