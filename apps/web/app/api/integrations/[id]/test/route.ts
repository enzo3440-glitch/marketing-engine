import { createConnectors, testAndRecord } from "@engine/connectors";
import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("settings");
  if (s instanceof Response) return s;
  const ctx = { repo: getRepo(), env: process.env };
  const c = createConnectors(ctx).find((x) => x.id === params.id);
  if (!c) return Response.json({ error: "unknown provider" }, { status: 404 });
  return Response.json(await testAndRecord(c, ctx));
}
