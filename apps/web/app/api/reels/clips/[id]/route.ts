import { getRepo, type ReelClip } from "@engine/db";
import { guardApi } from "@/lib/auth";

const KINDS = ["oneshot", "broll", "talking", "podcast", "screen", "reference"];

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const body = (await req.json()) as Partial<ReelClip>;
  const patch: Partial<ReelClip> = {};
  if (typeof body.star === "boolean") patch.star = body.star;
  if (body.kind === null || (body.kind && KINDS.includes(body.kind))) patch.kind = body.kind;
  if (Array.isArray(body.tags)) patch.tags = body.tags.map(String).slice(0, 12);
  await getRepo().update("reel_clips", { id: params.id }, patch);
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  await getRepo().remove("reel_clips", { id: params.id });
  return Response.json({ ok: true });
}
