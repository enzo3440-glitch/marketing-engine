import { importPlan, planState } from "@/lib/marketing-plan";
import { guardApi } from "@/lib/auth";

export async function GET() {
  const s = await guardApi("content", "calendar");
  if (s instanceof Response) return s;
  const { items, launch_start, missing } = await planState();
  return Response.json({ count: items.length, launch_start, missing });
}

/** {launch_start?: "YYYY-MM-DD"}: put the guide's posts + template ideas on the calendar as ideas (idempotent). */
export async function POST(req: Request) {
  const s = await guardApi("content", "calendar");
  if (s instanceof Response) return s;
  const { launch_start } = (await req.json().catch(() => ({}))) as { launch_start?: string };
  return Response.json(await importPlan(launch_start));
}
