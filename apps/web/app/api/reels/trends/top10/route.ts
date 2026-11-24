import { guardApi } from "@/lib/auth";
import { findTopTravelReels, learnTravelTrends, travelTrendsStatus } from "@/lib/travel-trends";

export const dynamic = "force-dynamic";

/** The daily top 10 travel reels study: what was found, what was learned, when. */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json(travelTrendsStatus());
}

/** {action: "find" | "learn"}: run a step now instead of waiting for the autopilot clock. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    if (action === "find") return Response.json(await findTopTravelReels());
    if (action === "learn") return Response.json({ note: await learnTravelTrends(true) });
    return Response.json({ error: "action must be find or learn" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
