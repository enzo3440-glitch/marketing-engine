import { guardApi } from "@/lib/auth";
import { getIdea, ideaBrief, noteMade } from "@/lib/ideas";
import { getRepo } from "@engine/db";
import { bragRuns, cancelBragAd, startBragAd } from "@/lib/brag-ad";
import { type Creation, creations, refreshCreations, startCreation } from "@/lib/reel-create";
import { syncJob } from "@/lib/reels";

export const dynamic = "force-dynamic";

/** Template videos go straight to the engine (POST /api/reels/templates), so show the recent ones here too. */
async function templateRuns(skip: Set<string>): Promise<Creation[]> {
  const since = Date.now() - 6 * 3600_000;
  const jobs = (await getRepo().list("reel_jobs")).filter((j) => j.job_id.startsWith("tpl-") && !skip.has(j.job_id) && Date.parse(j.created_at) > since);
  const out: Creation[] = [];
  for (const j0 of jobs) {
    const j = await syncJob(j0).catch(() => j0);
    const n = j.request.variants?.length ?? 1;
    const status = j.status === "done" ? "done" : j.status === "error" ? "error" : "rendering";
    out.push({
      id: j.job_id, kind: "reel", at: Date.parse(j.created_at), status, job_id: j.job_id, error: j.error ?? undefined,
      ask: `Template video${n > 1 ? `s · ${n}` : ""} · ${j.request.clips.length} clips`,
      plan: status === "rendering" ? (j.status === "queued" ? "Reading the clips, then it renders." : "The engine is cutting it to the template.") : undefined,
    });
  }
  return out;
}

const APP_AD = `A product ad: a recognizable problem hook in the first 1-2 s, then the app screens of the feature the idea is about,
the real place or payoff, one CTA. Only shipped features.`;
const RAW = `Pick the most eye-catching footage for this idea from the bin and the library (highest-rated reads first), build it shot by shot,
and use labelled placeholders for any shot we don't have yet. No phone or app-screen shots: those are made by /brag (App ad).`;

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  await refreshCreations();
  const mine = [...bragRuns(), ...creations()];
  const tpl = await templateRuns(new Set(mine.map((c) => c.job_id).filter((x): x is string => !!x)));
  return Response.json([...mine, ...tpl].sort((a, z) => z.at - a.at));
}

/**
 * {mode: "footage" | "app_ad" | "app_screens" | "raw", idea_id?, note?, clip_ids?, count?}
 *   footage: a reel from the clips you picked;
 *   app_ad / app_screens: an idea as a product ad made by /brag from the latest app code, in our phone (app_ad) or as
 *   screens floating over one film shot with no phone (app_screens); count = how many takes (they run one at a time);
 *   raw: an idea built from the best footage we have (+ any clips you add), placeholders for the gaps.
 */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as { mode?: string; idea_id?: string; note?: string; clip_ids?: string[]; count?: number };
  const idea = b.idea_id ? await getIdea(b.idea_id) : null;
  if (b.idea_id && !idea) return Response.json({ error: "That idea is gone" }, { status: 404 });
  const clips = (b.clip_ids ?? []).filter((x) => typeof x === "string").slice(0, 40);
  const note = (b.note ?? "").trim().slice(0, 600);
  const count = Math.min(Math.max(Number(b.count) || 1, 1), 4);
  if (b.mode === "app_ad" || b.mode === "app_screens") {
    if (!idea && !note) return Response.json({ error: "Pick an idea or say what to make" }, { status: 400 });
    const bin = await getRepo().list("reel_clips");
    const files = clips.map((id) => bin.find((x) => x.id === id)?.file).filter((f): f is string => !!f);
    const ask = [idea && ideaBrief(idea), note, APP_AD].filter(Boolean).join("\n");
    const runs = Array.from({ length: count }, () => startBragAd(idea?.id ?? null, idea?.title ?? null, ask, files, b.mode === "app_ad" ? "phone" : "floating"));
    return Response.json({ ...runs[0], title: idea?.title ?? null, runs });
  }
  let ask: string, kind: "reel" | "auto";
  if (b.mode === "footage") {
    if (!clips.length) return Response.json({ error: "Pick at least one clip" }, { status: 400 });
    ask = [`A brand reel built from the picked clips.`, idea && ideaBrief(idea), note].filter(Boolean).join(" ");
    kind = "reel";
  } else if (b.mode === "raw") {
    if (!idea && !note) return Response.json({ error: "Pick an idea or say what to make" }, { status: 400 });
    ask = [idea && ideaBrief(idea), note, RAW].filter(Boolean).join("\n");
    kind = "auto";
  } else return Response.json({ error: "mode must be footage, app_ad, app_screens or raw" }, { status: 400 });
  const c = startCreation(ask, kind, count, clips, b.mode === "raw" ? clips : []);
  if (idea) await noteMade(idea.id, c.id);
  return Response.json({ ...c, title: idea?.title ?? null });
}

/** ?id=brag-…: cancel a queued or running /brag ad. */
export async function DELETE(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  return cancelBragAd(id) ? Response.json({ ok: true }) : Response.json({ error: "That one isn't running" }, { status: 404 });
}
