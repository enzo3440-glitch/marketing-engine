import "server-only";
import { ReelEngine, type EngineVariant } from "@engine/connectors";
import { getRepo, type PerfRow, type ReelJob, type ReelJobRequest, type ReelRef, type ReelVariant } from "@engine/db";
import { BRAND } from "./brand";

export const engine = () => ReelEngine.fromEnv(process.env);

const base = (p?: string | null) => (p ? p.split(/[\\/]/).pop()! : null);

export interface BuilderInput {
  pacing?: "fast" | "medium" | "cinematic"; referenceId?: string;
  clipIds: string[]; formats: string[]; hookIds: string[]; grades: string[]; music: string[];
  duration: number; max: number; hashtags: string[]; caption?: string; timingTrack?: string; endcard?: boolean;
  /** quiet, muffled start; the song's drop lands on the reveal (second shot) */
  buildDrop?: boolean;
}

/** Builder selections → contract job.json (references/contract.md §3). A hook test changes only the hook. */
export async function buildJobRequest(b: BuilderInput): Promise<ReelJobRequest> {
  const repo = getRepo();
  const [clips, hooks, refs] = await Promise.all([repo.list("reel_clips"), repo.list("reel_hooks"), repo.list("reel_refs")]);
  const picked = clips.filter((c) => b.clipIds.includes(c.id));
  const stamp = batchStamp();
  return {
    job_id: `reel-${stamp}`,
    clips: picked.map((c) => ({ id: c.id, path: c.file, star: c.star, tags: c.tags, ...(c.read ? { read: c.read } : {}) })),
    defaults: {
      duration: b.duration, music: b.music[0] ?? (await soundLibrary())[0]?.path ?? null, endcard: b.endcard ?? true, hashtags: b.hashtags,
      ...(b.pacing ? { pacing: b.pacing } : {}), ...(b.referenceId ? { reference: b.referenceId } : {}),
      // no reference chosen: each format borrows pacing + look from your best reference of that format
      ...(b.referenceId ? {} : { styles: styleByFormat(refs, b.formats), transitions_style: "clean" }),
      ...(b.buildDrop ? { build_drop: true } : {}),
      ...(b.caption ? { caption: b.caption } : {}), ...(b.timingTrack ? { timing_track: b.timingTrack } : {}),
    },
    matrix: {
      formats: b.formats, hooks: hooks.filter((h) => b.hookIds.includes(h.id)).map((h) => ({ id: h.id, text: h.text })),
      grades: b.grades, music: b.music, max: b.max,
    },
  };
}

type Style = { pacing?: string; grade?: string; reference?: string };

/**
 * What each format should borrow from your references of that format: pacing from the median measured
 * shot length, the look you tagged most often, and the most-viewed reference as the one it's styled after.
 */
export function styleByFormat(refs: ReelRef[], formats: string[]): Record<string, Style> {
  const out: Record<string, Style> = {};
  for (const f of formats) {
    const of = refs.filter((r) => r.format === f);
    if (!of.length) continue;
    const shots = of.map((r) => r.metrics.avg_shot).filter((x): x is number => !!x).sort((a, z) => a - z);
    const med = shots.length ? shots[Math.floor(shots.length / 2)] : undefined;
    const looks = new Map<string, number>();
    for (const r of of) if (r.metrics.look) looks.set(r.metrics.look, (looks.get(r.metrics.look) ?? 0) + 1);
    const top = [...of].sort((a, z) => (z.metrics.views ?? 0) - (a.metrics.views ?? 0))[0];
    out[f] = {
      pacing: med ? (med < 1.2 ? "fast" : med < 2.5 ? "medium" : "cinematic") : undefined,
      grade: [...looks].sort((a, z) => z[1] - a[1])[0]?.[0],
      reference: top.id,
    };
  }
  return out;
}

/**
 * Adopt engine jobs the desk has never seen (rendered from the CLI, another desk, or before a restart),
 * so every render shows up in the gallery. Their variants arrive through syncJob like any other job.
 */
export async function importEngineJobs(): Promise<number> {
  const e = engine();
  if (e.stub) return 0;
  const [remote, known] = await Promise.all([e.listJobs().catch(() => []), getRepo().list("reel_jobs")]);
  const have = new Set(known.map((j) => j.job_id));
  const fresh = remote.filter((j) => !have.has(j.job_id));
  if (!fresh.length) return 0;
  await getRepo().insert("reel_jobs", fresh.map((j) => ({
    job_id: j.job_id, status: j.status === "done" ? "rendering" : j.status, // "rendering" so syncJob pulls the manifest
    created_at: new Date((j.queued ?? Date.now() / 1000) * 1000).toISOString(),
    request: { job_id: j.job_id, clips: [], defaults: { imported: true } }, manifest: null, error: null, stub: false,
  })));
  return fresh.length;
}

/**
 * Delete videos from a batch, files included (null = the whole batch). Posted videos are never deleted: their
 * results feed learning. A batch with nothing left goes entirely. Returns what was deleted and what was kept.
 */
export async function deleteVideos(jobId: string, variantIds: string[] | null, keepStarred = false): Promise<{ deleted: number; kept: number; job_deleted: boolean }> {
  const repo = getRepo();
  const e = engine();
  const [variants, posts] = await Promise.all([repo.list("reel_variants", { eq: { job_id: jobId } }), repo.list("reel_posts", { eq: { job_id: jobId } })]);
  const posted = new Set(posts.map((p) => p.variant_id));
  const keep = (v: ReelVariant) => posted.has(v.id) || (keepStarred && v.picked);
  const targets = variants.filter((v) => (variantIds ? variantIds.includes(v.id) : true) && !keep(v));
  const left = variants.filter((v) => !targets.includes(v));
  if (!left.length) {
    await e.deleteJob(jobId);
    await repo.remove("reel_variants", { job_id: jobId });
    await repo.remove("reel_jobs", { job_id: jobId });
    return { deleted: targets.length, kept: 0, job_deleted: true };
  }
  for (const v of targets) {
    await e.deleteJob(jobId, v.id);
    await repo.remove("reel_variants", { job_id: jobId, id: v.id });
  }
  return { deleted: targets.length, kept: left.length, job_deleted: false };
}

/** Poll the engine for an unfinished job and persist its manifest + variants when done. */
/** Batch id stamp: Honolulu time to the second plus a short random tail, so two batches started in the same
 * minute (auto-make fires several at once) never share an id and overwrite each other on the engine. */
export const batchStamp = () =>
  `${new Date(Date.now() - 10 * 3600_000).toISOString().slice(0, 19).replace(/[-:T]/g, "")}${Math.random().toString(36).slice(2, 5)}`;

/** Batches waiting for their clips to be read before they go to the engine (lib/clip-reader.ts submitWhenRead). */
export const waitingJobs = ((globalThis as { __waitingJobs?: Set<string> }).__waitingJobs ??= new Set<string>());

export async function syncJob(job: ReelJob): Promise<ReelJob> {
  if (job.status === "done" || job.status === "error" || waitingJobs.has(job.job_id)) return job;
  const repo = getRepo();
  const e = engine();
  let r: Awaited<ReturnType<typeof e.getJob>>;
  try {
    r = await e.getJob(job.job_id, job.request, job.created_at);
  } catch (x) {
    // the engine restarted mid-render (it only remembers finished batches): mark it so Retry can redo it
    if (!/404/.test(String(x))) return job;
    r = { job_id: job.job_id, status: "error", error: "Interrupted: the engine restarted before this finished. Retry to render it again." };
  }
  const patch: Partial<ReelJob> = { status: r.status, error: r.error ?? null };
  if (r.status === "done" && r.manifest) {
    patch.manifest = r.manifest as unknown as Record<string, unknown>;
    const hashtags = ((job.request.defaults.hashtags as string[]) ?? []).map((t) => `#${t.replace(/^#/, "")}`).join(" ");
    const rows: ReelVariant[] = [];
    for (const v of r.manifest.variants.filter((x: EngineVariant) => !x.error)) {
      let caption = `${v.hook ?? ""}${hashtags ? `\n\n${hashtags}` : ""}`.trim();
      if (!e.stub && v.caption_file) {
        const res = await e.fetchFile(job.job_id, base(v.caption_file)!);
        if (res?.ok) caption = (await res.text()).trim();
      }
      rows.push({
        id: v.id, job_id: job.job_id, format: v.format ?? null, hook_id: v.tags?.hook_id ?? null, hook: v.hook ?? null,
        grade: v.grade ?? null, music: v.music ?? null, file: base(v.file), bare: base(v.bare), poster: base(v.poster),
        caption, duration: v.duration ?? null, warnings: v.warnings ?? [], tags: v.tags ?? {}, picked: false,
      });
    }
    if (rows.length) await repo.upsert("reel_variants", rows, "job_id,id");
    // Hooks under test move to "testing".
    for (const id of new Set(rows.map((x) => x.hook_id).filter(Boolean) as string[])) {
      const [h] = await repo.list("reel_hooks", { eq: { id } });
      if (h?.status === "new") await repo.update("reel_hooks", { id }, { status: "testing" });
    }
  }
  await repo.update("reel_jobs", { job_id: job.job_id }, patch);
  return { ...job, ...patch };
}

export interface HookInfo { rank: number; tag: "winner" | "trending" | "your ref" | "evidence" | "testing" | "" }
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

/**
 * Order the hook pool for the batch builder: proven winners, then hooks from the outside watchlist with
 * observed growth (what's trending in the latest research), then hooks from your style references,
 * then the evidence-ranked library, then everything else.
 */
export async function hookRanking(): Promise<Record<string, HookInfo>> {
  const repo = getRepo();
  const [hooks, recs, refs] = await Promise.all([repo.list("reel_hooks"), repo.list("cmo_recommendations"), repo.list("reel_refs")]);
  const trending = new Set(recs.filter((r) => r.kind === "watchlist" && r.signal === "observed_growth" && r.hook).map((r) => norm(r.hook!)));
  const fromRefs = new Set(refs.map((r) => r.metrics.hook).filter(Boolean).map((t) => norm(t!)));
  const out: Record<string, HookInfo> = {};
  for (const h of hooks) {
    const n = norm(h.text);
    out[h.id] = h.status === "winner" ? { rank: 0, tag: "winner" }
      : trending.has(n) || h.framework === "trend" ? { rank: 1, tag: "trending" }
      : fromRefs.has(n) || h.framework === "ref" ? { rank: 2, tag: "your ref" }
      : /^F\d+/.test(h.framework ?? "") ? { rank: 3, tag: "evidence" }
      : h.status === "testing" ? { rank: 4, tag: "testing" }
      : { rank: 5, tag: "" };
  }
  return out;
}

export interface Sound { path: string; label: string; source: "song" | "reel"; refId?: string }

/**
 * Trending audio only: songs you dropped in (engine music/) and the audio of reference reels you dropped
 * (their screen recordings carry the sound the reel was cut to). No stock tracks.
 */
export async function soundLibrary(): Promise<Sound[]> {
  const [songs, refs] = await Promise.all([engine().listMusic().catch(() => []), getRepo().list("reel_refs")]);
  return [
    ...songs.filter((t) => t.source === "yours").map((t) => ({ path: t.path, label: t.name.replace(/\.\w+$/, ""), source: "song" as const })),
    // our own ads were cut to stock music: their sound never counts as trending
    ...refs.filter((r) => r.file && !/\bour ad\b/i.test(r.title ?? "")).map((r) => ({
      path: `input/${r.file}`, label: r.metrics.song ? `${r.metrics.song} (from ${r.title ?? "reel"})` : `${r.title ?? r.file} · its sound`,
      source: "reel" as const, refId: r.id,
    })),
  ];
}

/**
 * Director job: the engine judges the clips and casts them into trend templates, a test set per template
 * (A baseline, B other opening shot, C other hook). Audio comes only from the sound library.
 */
export async function directJob(b: { clipIds: string[]; templateIds: (string | Record<string, unknown>)[]; perTemplate: number; hook?: string; place?: string }): Promise<ReelJobRequest> {
  const repo = getRepo();
  const [clips, hooks, rank, sounds, refs] = await Promise.all([repo.list("reel_clips"), repo.list("reel_hooks"), hookRanking(), soundLibrary(), repo.list("reel_refs")]);
  const picked = clips.filter((c) => b.clipIds.includes(c.id));
  const pool = hooks.filter((h) => h.status !== "retired" && !/\[[^\]]+\]/.test(h.text))
    .sort((a, z) => (rank[a.id]?.rank ?? 9) - (rank[z.id]?.rank ?? 9)).slice(0, 12).map((h) => h.text);
  // what references teach (marked learn, or template + learn): their opening text joins the hook pool, their color the looks
  const teach = refs.filter((r) => r.metrics.learn?.length);
  const learnedHooks = teach.filter((r) => r.metrics.learn!.includes("text")).map((r) => r.metrics.hook ?? r.metrics.lines?.[0]?.text).filter((h): h is string => !!h && h.split(" ").length >= 3);
  const learnedLooks = [...new Set(teach.filter((r) => r.metrics.learn!.includes("color") && r.metrics.look).map((r) => r.metrics.look!))];
  const stamp = batchStamp();
  return {
    job_id: `dir-${stamp}`,
    clips: picked.map((c) => ({ id: c.id, path: c.file, star: c.star, tags: c.tags, ...(c.read ? { read: c.read } : {}) })),
    defaults: { endcard: true, cta: process.env.BRAND_CTA || "Learn more", hashtags: [BRAND.niche, BRAND.name].map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean) },
    direct: {
      templates: b.templateIds, per_template: Math.min(Math.max(1, b.perTemplate || 3), 6),
      hook: b.hook?.trim() || undefined, place: b.place?.trim() || undefined, hooks: [...new Set([...pool, ...learnedHooks])].slice(0, 20), looks: learnedLooks,
      sounds: sounds.map((s) => ({ path: s.path, label: s.label })), seed: Date.now() % 10_000,
    },
  } as ReelJobRequest;
}

export interface TrendingSound { id: string; title: string; why: string | null; seen: string | null; url: string | null; source: string }

/** Sounds flagged by trend research: the CMO watchlist's audio picks plus anything a trend refresh found. */
export async function trendingSounds(): Promise<TrendingSound[]> {
  const repo = getRepo();
  const [snap, recs] = await Promise.all([repo.cmoSnapshot(), repo.list("cmo_recommendations")]);
  const out: TrendingSound[] = recs.filter((r) => r.signal === "trending_sound").map((r) => ({
    id: r.id, title: r.title, why: r.body, seen: r.evidence, url: r.sources[0]?.url ?? null, source: "trend refresh",
  }));
  const wl = (snap?.snapshot as { externalWatchlist?: { lastSuccessfulAt?: string; items?: { id: string; title: string; audio?: { title?: string; url?: string; status?: string } }[] } } | undefined)?.externalWatchlist;
  for (const it of wl?.items ?? []) {
    if (!it.audio?.title || out.some((o) => o.title === it.audio!.title)) continue;
    out.push({ id: `wl-${it.id}`, title: it.audio.title, why: `${it.title}. ${it.audio.status ?? ""}`.trim(), seen: wl?.lastSuccessfulAt ? `Watchlist ${wl.lastSuccessfulAt.slice(0, 10)}` : null, url: it.audio.url ?? null, source: "CMO watchlist" });
  }
  return out;
}

/** reel_posts ⨝ reel_variants → engine/learn.py rows. */
export async function perfRows(): Promise<PerfRow[]> {
  const repo = getRepo();
  const [posts, variants] = await Promise.all([repo.list("reel_posts"), repo.list("reel_variants")]);
  return posts.filter((p) => p.views != null).map((p) => {
    const v = variants.find((x) => x.job_id === p.job_id && x.id === p.variant_id);
    return {
      variant_id: p.variant_id, platform: p.platform, views: p.views ?? 0, avg_watch_s: Number(p.avg_watch_s ?? 0), duration_s: Number(v?.duration ?? 12),
      likes: p.likes ?? 0, shares: p.shares ?? 0, saves: p.saves ?? 0, comments: p.comments ?? 0, follows: p.follows ?? 0, tags: v?.tags,
    };
  });
}
