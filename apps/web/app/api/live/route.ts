import { guardApi } from "@/lib/auth";
import { markDeleted } from "@/lib/optimize";
import { decidePending, freshReel, liveBoard, proposeBudget, proposePromote, saveNote } from "@/lib/live";

export const dynamic = "force-dynamic";

/** Command → Live: every live reel and ad campaign with its numbers and the optimizer's read. ?reel=<job/video>: fresh IG numbers. */
export async function GET(req: Request) {
  const s = await guardApi("command", "growth", "calendar");
  if (s instanceof Response) return s;
  const reel = new URL(req.url).searchParams.get("reel");
  try {
    if (reel) return Response.json({ fresh: await freshReel(reel) });
    return Response.json(await liveBoard());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Nothing here changes Meta: money goes into Decide as a pending approval.
 * {action: "budget", campaign_id, daily_budget, extend_days, note?}  → set_budget proposal
 * {action: "promote", key, daily_budget, days}                       → promote_post proposal for a live reel
 * {action: "note", key, text}                                        → the founder's suggestion for the next re-cut
 * {action: "approve" | "reject", key}                                → push out / turn down the change live optimize is waiting on
 */
export async function POST(req: Request) {
  const s = await guardApi("command", "growth", "calendar");
  if (s instanceof Response) return s;
  const b = (await req.json().catch(() => ({}))) as { action?: string; campaign_id?: string; key?: string; daily_budget?: number; extend_days?: number; days?: number; note?: string; text?: string };
  const by = s.email || s.userId || "founder";
  try {
    if (b.action === "budget" && b.campaign_id) {
      const a = await proposeBudget(b.campaign_id, Number(b.daily_budget), Number(b.extend_days ?? 0), by, b.note);
      return Response.json({ ok: true, approval_id: a.id, detail: `Sent to Decide: ${a.title}.` });
    }
    if (b.action === "promote" && b.key) {
      const a = await proposePromote(b.key, Number(b.daily_budget), Number(b.days ?? 4), by);
      return Response.json({ ok: true, approval_id: a.id, detail: `Sent to Decide: ${a.title}.` });
    }
    if ((b.action === "approve" || b.action === "reject") && b.key) return Response.json({ ok: true, detail: await decidePending(b.key, b.action === "approve", by) });
    if (b.action === "deleted" && b.key) return Response.json({ ok: true, detail: markDeleted(b.key) });
    if (b.action === "note" && b.key) return Response.json({ ok: true, notes: await saveNote(b.key, b.text ?? "", by), detail: "Saved: the next re-cut uses it." });
    return Response.json({ error: "action must be budget {campaign_id}, promote {key} or note {key, text}" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
