import { guardApi } from "@/lib/auth";
import { spendable } from "@/lib/improve";
import { assignToCampaign, deleteFromLaunch, setStream, inFlight, launchTest, launchVideo, readyVideos, type LaunchInput } from "@/lib/launch";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const [videos, flight, money] = await Promise.all([readyVideos(), inFlight(), spendable().catch(() => null)]);
  return Response.json({ videos, ...flight, money: money && { free: money.free, committed: money.committed, currency: money.funds?.currency ?? "USD" } });
}

/** {action: "launch", job_id, variant_id, dest: post|trial|ad, caption, daily_budget?, days?}, {action: "test", name, picks}
 * {action: "assign", job_id, variant_id, campaign_id, as: ad|trial|none} or {action: "delete", job_id, variant_id}. */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as LaunchInput & { action?: string; campaign_id?: string; stream?: "ig" | "ad"; as?: "ad" | "trial" | "none"; name?: string; picks?: { job_id: string; variant_id: string; caption?: string; content_id?: string | null }[] };
  try {
    if (b.action === "launch") {
      if (!["post", "trial", "ad"].includes(b.dest)) return Response.json({ error: "dest must be post, trial or ad" }, { status: 400 });
      return Response.json(await launchVideo(b, s.email));
    }
    if (b.action === "assign") {
      if (!b.campaign_id || !["ad", "trial", "none"].includes(b.as ?? "")) return Response.json({ error: "assign needs campaign_id and as: ad, trial or none" }, { status: 400 });
      return Response.json(await assignToCampaign(b.job_id, b.variant_id, b.campaign_id, b.as!));
    }
    if (b.action === "stream") {
      if (b.stream !== "ig" && b.stream !== "ad") return Response.json({ error: "stream must be ig or ad" }, { status: 400 });
      return Response.json(await setStream(b.job_id, b.variant_id, b.stream));
    }
    if (b.action === "delete") return Response.json(await deleteFromLaunch(b.job_id, b.variant_id, String((b as { why?: string }).why ?? "").slice(0, 500), s.email));
    if (b.action === "test") return Response.json(await launchTest((b.name ?? "").trim() || `Test ${new Date().toISOString().slice(0, 10)}`, (b.picks ?? []).slice(0, 15), s.email));
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
