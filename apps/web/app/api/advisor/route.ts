import { TASKS } from "@engine/advisor";
import { ideate } from "@engine/advisor/ideation";
import { guardApi } from "@/lib/auth";
import { advisor, claudeProvider, dbLedger, toEvidence } from "@/lib/advisor";
import { getRepo } from "@engine/db";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const ledger = await dbLedger.read();
  return Response.json({ status: advisor().status(), ledger });
}

/**
 * { action: "propose", task, context, evidenceIds } → recommendations (review required)
 * { action: "ideate", context, evidenceIds }        → campaign drafts, or the copyable prompt when unconnected
 * { action: "feedback", event, expectedRevision }   → append to the ledger
 */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  if (Number(req.headers.get("content-length") ?? 0) > 100_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  const body = (await req.json()) as { action: string; task?: string; context?: Record<string, unknown>; evidenceIds?: string[]; event?: { id: string; type: string }; expectedRevision?: number };
  const ids = (body.evidenceIds ?? []).filter((x) => typeof x === "string").slice(0, 25);
  try {
    if (body.action === "propose") {
      if (!TASKS.includes(body.task as never)) return Response.json({ error: `task must be one of ${TASKS.join(", ")}` }, { status: 400 });
      return Response.json(await advisor().propose({ task: body.task as (typeof TASKS)[number], context: body.context ?? {}, evidenceIds: ids }));
    }
    if (body.action === "ideate") {
      const items = await getRepo().list("content_items");
      const evidence = items.filter((c) => ids.includes(c.id)).map(toEvidence);
      return Response.json(await ideate({ provider: claudeProvider(), context: body.context ?? {}, evidence }));
    }
    if (body.action === "feedback") {
      if (!body.event || typeof body.expectedRevision !== "number") return Response.json({ error: "event and expectedRevision required" }, { status: 400 });
      return Response.json(await advisor().recordFeedback({ ...body.event, actor: s.email }, body.expectedRevision));
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    const msg = (e as Error).message;
    return Response.json({ error: msg }, { status: /conflict/i.test(msg) ? 409 : 422 });
  }
}
