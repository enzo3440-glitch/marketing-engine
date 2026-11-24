import { getRepo } from "@engine/db";
import { BRAND } from "@/lib/brand";
import { guardApi } from "@/lib/auth";
import { engine, importEngineJobs, soundLibrary } from "@/lib/reels";

export const dynamic = "force-dynamic";

/** Status of the engine's autopilot run (and adopt any finished stories into the gallery). */
export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const e = engine();
  const status = await e.autopilotStatus().catch((err: Error) => ({ status: "error", error: err.message }));
  await importEngineJobs().catch(() => 0);
  return Response.json({ ...status, defaultFolder: process.env.AUTOPILOT_DEFAULT_FOLDER ?? "" });
}

/**
 * Start a run. Styles come from the style references (your own tags weigh most: format + look),
 * hooks from the hook pool (winners first, then the evidence-ranked library), music from the bundle.
 */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as { action?: "stop"; folder?: string; hours?: number; maxVideos?: number; hooksPerStory?: number };
  const e = engine();
  if (b.action === "stop") {
    await e.autopilotStop();
    return Response.json({ ok: true });
  }
  const repo = getRepo();
  const [refs, hooks] = await Promise.all([repo.list("reel_refs"), repo.list("reel_hooks")]);
  // Weight styles: references you added (ids ref-mv…) count 3×, researched ones 1×.
  const tally = new Map<string, { format: string; look?: string; pacing?: string; n: number; titles: string[] }>();
  for (const r of refs) {
    if (!["montage", "cinematic", "oneshot", "pov", "reveal"].includes(r.format)) continue;
    const look = r.metrics.look ?? (r.format === "cinematic" ? "film" : undefined);
    const key = `${r.format}|${look ?? ""}|${r.metrics.pacing ?? ""}`;
    const t = tally.get(key) ?? { format: r.format, look, pacing: r.metrics.pacing, n: 0, titles: [] };
    t.n += /^ref-mv/.test(r.id) ? 3 : 1;
    t.titles.push(r.title ?? r.id);
    tally.set(key, t);
  }
  const styles = [...tally.values()].sort((a, z) => z.n - a.n).slice(0, 3).map((t) => ({
    format: t.format, look: t.look, pacing: t.pacing ?? (t.format === "cinematic" ? "cinematic" : t.format === "oneshot" ? "medium" : "fast"),
    label: `${t.format}${t.look ? ` · ${t.look}` : ""} (${t.n} pts)`,
  }));
  const rank = { winner: 0, testing: 1, new: 2, retired: 9 } as const;
  const pool = hooks.filter((h) => h.status !== "retired")
    .sort((a, z) => rank[a.status] - rank[z.status] || Number(z.source === "radar") - Number(a.source === "radar"))
    .slice(0, 14).map((h) => ({ id: h.id, text: h.text, framework: h.framework }));
  const cfg = {
    folder: b.folder || process.env.AUTOPILOT_DEFAULT_FOLDER,
    budget_minutes: Math.round(Math.min(Math.max(b.hours ?? 8, 0.1), 14) * 60),
    max_videos: Math.min(Math.max(b.maxVideos ?? 60, 1), 400),
    hooks_per_story: Math.min(Math.max(b.hooksPerStory ?? 3, 1), 6),
    styles: styles.length ? styles : undefined, hooks: pool, music: (await soundLibrary()).map((x) => x.path),
    hashtags: [BRAND.niche.replace(/\s+/g, "")].filter(Boolean), endcard: BRAND.name, cta: "",
  };
  try {
    return Response.json({ ...(await e.autopilotStart(cfg)), styles, hooks: pool.length });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
