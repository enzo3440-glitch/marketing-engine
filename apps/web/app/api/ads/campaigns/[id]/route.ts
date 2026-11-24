import type { AdCampaign } from "@engine/db";
import { buildCampaign, deleteCampaign, editCampaign, setPaused, submitCampaign } from "@/lib/ad-campaigns";
import { guardApi } from "@/lib/auth";
import { lowerBudget } from "@/lib/improve";
import { sendCampaign } from "@/lib/launch";

const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: 400 });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("calendar");
  if (s instanceof Response) return s;
  try {
    return Response.json(await editCampaign(params.id, (await req.json()) as Partial<AdCampaign>));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const s = await guardApi("calendar");
  if (s instanceof Response) return s;
  try {
    await deleteCampaign(params.id);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/**
 * {action}: submit (to the approvals queue) · send (Launch: submit the ads + post the videos marked for trial) · pause (stop spend; anyone on the calendar) ·
 * resume / build (turn spend back on, retry a failed build: approvers only, like the approvals queue).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { action, daily_budget } = (await req.json().catch(() => ({}))) as { action?: string; daily_budget?: number };
  const s = await guardApi(...(action === "resume" || action === "build" || action === "lower_budget" ? (["command"] as const) : (["calendar"] as const)));
  if (s instanceof Response) return s;
  try {
    if (action === "submit") return Response.json(await submitCampaign(params.id, s.email));
    if (action === "send") return Response.json(await sendCampaign(params.id, s.email));
    if (action === "pause") return Response.json(await setPaused(params.id, true));
    if (action === "resume") return Response.json(await setPaused(params.id, false));
    if (action === "build") return Response.json(await buildCampaign(params.id));
    if (action === "lower_budget") return Response.json(await lowerBudget(params.id, Number(daily_budget)));
    return Response.json({ error: "action must be submit, send, pause, resume, build or lower_budget" }, { status: 400 });
  } catch (e) {
    return fail(e);
  }
}
