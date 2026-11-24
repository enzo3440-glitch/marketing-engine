import { guardApi } from "@/lib/auth";
import { autopilotStatus, tickAutopilot } from "@/lib/autopilot";

export const dynamic = "force-dynamic";

/** The desk's own clock calls POST with its per-process key (instrumentation-node.ts); people use their session. */
const fromClock = (req: Request) => {
  const key = (globalThis as { __autopilotKey?: string }).__autopilotKey;
  return !!key && req.headers.get("x-autopilot-key") === key;
};

/** What the autopilot did lately. */
export async function GET() {
  const s = await guardApi("content", "growth", "calendar");
  if (s instanceof Response) return s;
  return Response.json(autopilotStatus());
}

/** One pass now: measure, judge, make new versions, propose trials (nothing posts or spends without Decide). */
export async function POST(req: Request) {
  if (!fromClock(req)) {
    const s = await guardApi("content", "growth", "calendar");
    if (s instanceof Response) return s;
  }
  try {
    return Response.json({ ...(await tickAutopilot()), status: autopilotStatus() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
