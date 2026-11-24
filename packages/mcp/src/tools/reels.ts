// Reel Engine: clip bin, style references, hook pool, music, jobs/variants, posts, trends, autopilot.
// Reads come from the repo (and the engine for its own state); writes go through the desk's /api/reels routes.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { REEL_FORMATS, REEL_GRADES, REEL_MUSIC, REF_FORMATS, type ReelJob } from "@engine/db";
import { desk, deskOr, deskUp, engine, readRepo, ToolError } from "../context";
import { define } from "../tool";

const LOOKS = REEL_GRADES as readonly string[];
const limit = (d: number) => z.number().int().min(1).max(500).default(d).describe("Max rows to return");
const oneOf = (list: readonly string[], what: string) => z.string().refine((v) => list.includes(v), { message: `${what} must be one of: ${list.join(", ")}` }).describe(`One of: ${list.join(", ")}`);
const CLIP_KINDS = ["oneshot", "broll", "talking", "podcast", "screen", "reference"] as const;

/** A local file as a streamed request body (clips can be several GB). */
function fileBody(p: string, exts: RegExp, rule: string) {
  const abs = path.resolve(p);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw new ToolError(`No such file: ${abs}`); }
  if (!st.isFile()) throw new ToolError(`Not a file: ${abs}`);
  if (!exts.test(abs)) throw new ToolError(rule);
  return { abs, name: path.basename(abs), bytes: st.size, body: Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream<Uint8Array> };
}

const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const AUDIO = /\.(mp3|m4a|wav|aac|ogg)$/i;
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString();

/** Job without its bulky request/manifest; variants the engine failed to render are listed with their error. */
const jobSummary = (j: ReelJob) => {
  const failed = ((j.manifest?.variants ?? []) as { id: string; error?: string }[]).filter((v) => v.error).map((v) => ({ id: v.id, error: v.error }));
  return {
    job_id: j.job_id, status: j.status, created_at: j.created_at, stub: j.stub, error: j.error,
    clips: j.request.clips?.length ?? 0, formats: j.request.matrix?.formats, hooks: j.request.matrix?.hooks?.map((h) => h.id), max: j.request.matrix?.max,
    ...(failed.length ? { failedVariants: failed } : {}),
  };
};

export function registerReels(server: McpServer) {
  // Reads -----------------------------------------------------------------------------------------

  define(server, "get_reel_engine_status", {
    title: "Reel Engine status", kind: "read", areas: ["content"],
    description: "Whether the Python engine is reachable (or running as a stub with no media), its queue, and the jobs it knows about.",
    input: {},
  }, async () => {
    const e = engine();
    const health = await e.health().catch((err: Error) => ({ status: "error", detail: err.message }));
    const jobs = await e.listJobs().catch(() => []);
    return { stub: e.stub, health, engineJobs: jobs.slice(-20), deskReachable: await deskUp() };
  });

  define(server, "get_reel_options", {
    title: "Reel builder options", kind: "read", areas: ["content"],
    description: "Valid values for building jobs and tagging references: edit formats, reference formats (incl. ad), looks/grades, clip kinds, bundled music.",
    input: {},
  }, async () => ({ formats: REEL_FORMATS, referenceFormats: REF_FORMATS, looks: LOOKS, clipKinds: CLIP_KINDS, music: REEL_MUSIC, pacing: ["fast", "medium", "cinematic"] }));

  define(server, "list_reel_clips", {
    title: "Clip bin", kind: "read", areas: ["content"],
    description: "Footage in the clip bin (newest first): id, engine file, kind, star, tags, duration.",
    input: { kind: z.enum(CLIP_KINDS).optional(), starred: z.boolean().optional(), limit: limit(100) },
  }, async ({ kind, starred, limit }) => {
    const rows = await readRepo().list("reel_clips", { order: { col: "added_at", asc: false } });
    return rows.filter((c) => (!kind || c.kind === kind) && (starred === undefined || c.star === starred)).slice(0, limit);
  });

  define(server, "list_reel_references", {
    title: "Style references", kind: "read", areas: ["content"],
    description: "Style references (links and analyzed files): format (edit structure, incl. ad), look (grade), hook, measured pacing.",
    input: { format: z.string().optional(), limit: limit(100) },
  }, async ({ format, limit }) => {
    const rows = await readRepo().list("reel_refs", { order: { col: "added_at", asc: false } });
    return rows.filter((r) => !format || r.format === format).slice(0, limit);
  });

  define(server, "list_reel_hooks", {
    title: "Hook pool", kind: "read", areas: ["content"],
    description: "Hooks available to the batch builder with status (new/testing/winner/retired), source and framework. Hooks with [blanks] are templates to fill in first.",
    input: { status: z.enum(["new", "testing", "winner", "retired"]).optional(), search: z.string().optional(), limit: limit(200) },
  }, async ({ status, search, limit }) => {
    const rank = { winner: 0, testing: 1, new: 2, retired: 3 };
    const rows = await readRepo().list("reel_hooks", status ? { eq: { status } } : {});
    return rows.filter((h) => !search || h.text.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => rank[a.status] - rank[b.status]).slice(0, limit)
      .map((h) => ({ ...h, template: /\[[^\]]+\]/.test(h.text) }));
  });

  define(server, "list_reel_music", {
    title: "Music", kind: "read", areas: ["content"],
    description: "Tracks usable as `music` in a job: synth beds, bundled tracks, and songs you uploaded (source \"yours\").",
    input: {},
  }, async () => {
    const e = engine();
    const tracks = await e.listMusic().catch((err: Error) => ({ error: err.message }));
    return { synth: REEL_MUSIC.filter((m) => m.startsWith("synth:")), bundled: REEL_MUSIC.filter((m) => !m.startsWith("synth:")), engine: tracks, stub: e.stub };
  });

  define(server, "list_reel_templates", {
    title: "Reel templates", kind: "read", areas: ["content"],
    description: "Builder templates derived from your references (served by the desk at /api/reels/templates).",
    input: {},
  }, async () => {
    try {
      return await desk("GET", "/api/reels/templates");
    } catch (e) {
      if (/→ 404/.test((e as Error).message)) return { templates: [], note: "This desk build has no /api/reels/templates yet." };
      throw e;
    }
  });

  define(server, "list_reel_jobs", {
    title: "Render jobs", kind: "read", areas: ["content"],
    description: "Recent render jobs, newest first. Through the desk when it's up (also syncs unfinished jobs and adopts engine-side renders).",
    input: { limit: z.number().int().min(1).max(30).default(15) },
  }, async ({ limit }) => {
    const jobs = await deskOr(
      () => desk<ReelJob[]>("GET", "/api/reels/jobs", undefined, { timeoutMs: 120_000 }),
      () => readRepo().list("reel_jobs", { order: { col: "created_at", asc: false }, limit: 30 }),
    );
    return jobs.slice(0, limit).map(jobSummary);
  });

  define(server, "get_reel_job", {
    title: "Job status & variants", kind: "read", areas: ["content"],
    description: "One job's status, its rendered variants (format, hook, grade, music, caption, files) and any posts logged for them.",
    input: { job_id: z.string() },
  }, async ({ job_id }) => {
    const live = await deskOr(
      () => desk<{ job: ReelJob; variants: unknown[]; posts: unknown[] }>("GET", `/api/reels/jobs/${encodeURIComponent(job_id)}`, undefined, { timeoutMs: 120_000 }),
      async () => null,
    );
    if (live) return { job: jobSummary(live.job), variants: live.variants, posts: live.posts };
    const repo = readRepo();
    const [job] = await repo.list("reel_jobs", { eq: { job_id } });
    if (!job) throw new ToolError(`No job ${job_id}`);
    const eng = job.status === "done" || job.status === "error" ? null : await engine().getJob(job_id, job.request, job.created_at).catch(() => null);
    const [variants, posts] = await Promise.all([repo.list("reel_variants", { eq: { job_id }, order: { col: "id" } }), repo.list("reel_posts", { eq: { job_id } })]);
    return { job: jobSummary(job), engine: eng ? { status: eng.status, progress: eng.progress, variants: eng.manifest?.variants.length } : null, variants, posts, note: "Desk offline: variants appear once the desk syncs the job." };
  });

  define(server, "list_trending_sounds", {
    title: "Trending sounds", kind: "read", areas: ["content"],
    description: "Sounds flagged by trend research (trend refresh results and the CMO watchlist's audio picks). Add them in-app on the _bare cut.",
    input: {},
  }, async () => {
    const repo = readRepo();
    const [snap, recs] = await Promise.all([repo.cmoSnapshot(), repo.list("cmo_recommendations")]);
    const out: { id: string; title: string; why: string | null; seen: string | null; url: string | null; source: string }[] = recs.filter((r) => r.signal === "trending_sound").map((r) => ({ id: r.id, title: r.title, why: r.body, seen: r.evidence, url: r.sources[0]?.url ?? null, source: "trend refresh" }));
    const wl = (snap?.snapshot as { externalWatchlist?: { lastSuccessfulAt?: string; items?: { id: string; title: string; audio?: { title?: string; url?: string; status?: string } }[] } } | undefined)?.externalWatchlist;
    for (const it of wl?.items ?? []) {
      if (!it.audio?.title || out.some((o) => o.title === it.audio!.title)) continue;
      out.push({ id: `wl-${it.id}`, title: it.audio.title, why: `${it.title}. ${it.audio.status ?? ""}`.trim(), seen: wl?.lastSuccessfulAt ? `Watchlist ${wl.lastSuccessfulAt.slice(0, 10)}` : null, url: it.audio.url ?? null, source: "CMO watchlist" });
    }
    return out;
  });

  // Clip bin --------------------------------------------------------------------------------------

  define(server, "upload_reel_clip", {
    title: "Add a clip from a local file", kind: "write", areas: ["content"],
    description: "Upload a video file (.mp4/.mov/.m4v/.webm) from this machine into the clip bin: streamed to the engine, analyzed, recorded. Re-uploading the same name returns the existing clip.",
    input: { path: z.string().describe("Absolute path to the video file"), kind: z.enum(CLIP_KINDS).optional().describe("Override the auto-detected kind") },
  }, async ({ path: p, kind }) => {
    const f = fileBody(p, VIDEO, "Clips must be .mp4, .mov, .m4v or .webm");
    const row = await desk("POST", `/api/reels/clips?${qs({ name: f.name, kind })}`, undefined, { raw: f.body, timeoutMs: 15 * 60_000 });
    return { uploaded: f.abs, bytes: f.bytes, clip: row };
  });

  define(server, "update_reel_clip", {
    title: "Star / tag a clip", kind: "write", areas: ["content"],
    description: "Change a clip's star, kind or tags (reversible).",
    input: { id: z.string(), star: z.boolean().optional(), kind: z.enum(CLIP_KINDS).nullable().optional(), tags: z.array(z.string()).max(12).optional() },
  }, async ({ id, ...patch }) => desk("PATCH", `/api/reels/clips/${encodeURIComponent(id)}`, patch));

  define(server, "remove_reel_clip", {
    title: "Remove a clip", kind: "write", destructive: true, areas: ["content"],
    description: "Remove one clip from the clip bin (the uploaded file stays on the engine).",
    input: { id: z.string(), confirm: z.boolean() },
  }, async ({ id }) => desk("DELETE", `/api/reels/clips/${encodeURIComponent(id)}`));

  define(server, "clear_reel_clips", {
    title: "Clear the clip bin", kind: "write", destructive: true, areas: ["content"],
    description: "Remove every clip from the clip bin (engine files stay). Use before loading a fresh shoot.",
    input: { confirm: z.boolean().describe("Must be true; confirm with the user first") },
  }, async () => {
    const before = (await readRepo().list("reel_clips")).length;
    try {
      return { ...(await desk<object>("DELETE", "/api/reels/clips")), removed: before };
    } catch (e) {
      if (!/→ 40[45]/.test((e as Error).message)) throw e;
      // Desk without the bulk route yet: remove one by one.
      const clips = await desk<{ id: string }[]>("GET", "/api/reels/clips");
      for (const c of clips) await desk("DELETE", `/api/reels/clips/${encodeURIComponent(c.id)}`);
      return { ok: true, removed: clips.length };
    }
  });

  // References ------------------------------------------------------------------------------------

  define(server, "add_reel_reference", {
    title: "Add a style reference (link)", kind: "write", areas: ["content"],
    description: "Add a link reference (Instagram/TikTok/YouTube/any URL; never downloaded). Format = edit structure (incl. ad), look = colour grade, hook = its opening line (joins the hook pool). Deduped on URL.",
    input: {
      url: z.string().url(), format: oneOf(REF_FORMATS, "format"), look: oneOf(LOOKS, "look").optional(),
      hook: z.string().max(120).optional(), title: z.string().optional(), notes: z.string().optional(),
    },
  }, async (b) => desk("POST", "/api/reels/refs", b));

  define(server, "upload_reel_reference", {
    title: "Add a style reference (local video)", kind: "write", areas: ["content"],
    description: "Upload a reference video from this machine; the engine measures shots, cut rate, opening hold and pacing.",
    input: { path: z.string(), format: oneOf(REF_FORMATS, "format").optional(), title: z.string().optional(), notes: z.string().optional() },
  }, async ({ path: p, format, title, notes }) => {
    const f = fileBody(p, VIDEO, "References must be .mp4, .mov, .m4v or .webm");
    return desk("POST", `/api/reels/refs?${qs({ name: f.name, format, title, notes })}`, undefined, { raw: f.body, timeoutMs: 15 * 60_000 });
  });

  define(server, "update_reel_reference", {
    title: "Retag a reference", kind: "write", areas: ["content"],
    description: "Fix a reference's format, look (null clears it), hook, title or notes.",
    input: {
      id: z.string(), format: oneOf(REF_FORMATS, "format").optional(), look: oneOf(LOOKS, "look").nullable().optional(),
      hook: z.string().max(120).optional(), title: z.string().optional(), notes: z.string().optional(),
    },
  }, async (b) => desk("PATCH", "/api/reels/refs", b));

  define(server, "remove_reel_reference", {
    title: "Remove a reference", kind: "write", destructive: true, areas: ["content"],
    description: "Delete a style reference (its hook stays in the pool).",
    input: { id: z.string(), confirm: z.boolean() },
  }, async ({ id }) => desk("DELETE", `/api/reels/refs?${qs({ id })}`));

  // Hooks -----------------------------------------------------------------------------------------

  define(server, "add_reel_hook", {
    title: "Add a hook", kind: "write", areas: ["content"],
    description: "Add a hook line to the pool (deduped on text; returns existed=true if already there).",
    input: { text: z.string().min(2).max(160), framework: z.string().optional(), source: z.enum(["claude", "radar", "owner", "map"]).default("claude") },
  }, async (b) => desk("POST", "/api/reels/hooks", b));

  define(server, "set_reel_hook_status", {
    title: "Mark a hook winner / retire it", kind: "write", areas: ["content"],
    description: "Set a hook's status: winner (ranked first in builds and autopilot), retired (dropped from the pool), testing or new. Reversible.",
    input: { id: z.string(), status: z.enum(["new", "testing", "winner", "retired"]) },
  }, async (b) => desk("PATCH", "/api/reels/hooks", b));

  // Music -----------------------------------------------------------------------------------------

  define(server, "upload_reel_music", {
    title: "Upload a song", kind: "write", areas: ["content"],
    description: "Upload a song of yours (.mp3/.m4a/.wav/.aac/.ogg) from this machine; it becomes selectable as music/<name>.",
    input: { path: z.string() },
  }, async ({ path: p }) => {
    const f = fileBody(p, AUDIO, "Songs must be .mp3, .m4a, .wav, .aac or .ogg");
    return desk("POST", `/api/reels/music?${qs({ name: f.name })}`, undefined, { raw: f.body, timeoutMs: 10 * 60_000 });
  });

  // Jobs ------------------------------------------------------------------------------------------

  define(server, "create_reel_job", {
    title: "Render a batch", kind: "write", areas: ["content"],
    description: "Submit a render batch exactly like the desk's batch builder: clips × formats × hooks (× grades × music), capped at max variants. Without referenceId each format borrows pacing + look from your best reference of that format. Check get_reel_job for progress.",
    input: {
      clipIds: z.array(z.string()).min(1), formats: z.array(oneOf(REEL_FORMATS, "format")).min(1), hookIds: z.array(z.string()).min(1),
      grades: z.array(oneOf(LOOKS, "grade")).default([]), music: z.array(z.string()).default([]).describe("Track paths from list_reel_music; first is the default"),
      duration: z.number().min(5).max(60).default(12), max: z.number().int().min(1).max(48).default(4).describe("Variant cap"),
      hashtags: z.array(z.string()).default([]), pacing: z.enum(["fast", "medium", "cinematic"]).optional(), referenceId: z.string().optional(),
      caption: z.string().optional(), timingTrack: z.string().optional(), endcard: z.boolean().optional(), buildDrop: z.boolean().optional().describe("Quiet start; the drop lands on the reveal"),
    },
  }, async (b) => {
    const job = await desk<ReelJob>("POST", "/api/reels/jobs", b, { timeoutMs: 120_000 });
    return { ...jobSummary(job), next: `get_reel_job { job_id: "${job.job_id}" }` };
  });

  define(server, "retry_reel_job", {
    title: "Retry a job", kind: "write", areas: ["content"],
    description: "Resubmit a failed or stuck job with its original request (same id, fresh render).",
    input: { job_id: z.string() },
  }, async ({ job_id }) => desk("POST", `/api/reels/jobs/${encodeURIComponent(job_id)}/retry`));

  define(server, "remove_reel_job", {
    title: "Remove a job from the gallery", kind: "write", destructive: true, areas: ["content"],
    description: "Delete a job and its variants/posts from the desk gallery (rendered files on the engine are untouched).",
    input: { job_id: z.string(), confirm: z.boolean() },
  }, async ({ job_id }) => desk("DELETE", `/api/reels/jobs/${encodeURIComponent(job_id)}`));

  define(server, "pick_reel_variant", {
    title: "Star a keeper", kind: "write", areas: ["content"],
    description: "Mark (or unmark) a rendered variant as a keeper.",
    input: { job_id: z.string(), id: z.string().describe("Variant id"), picked: z.boolean().default(true) },
  }, async (b) => desk("POST", "/api/reels/variants", { ...b, action: "pick" }));

  define(server, "propose_reel_post", {
    title: "Send a variant to approvals", kind: "write", areas: ["content"],
    description: "Draft a content item from a variant and queue a post approval (nothing is published until someone approves it).",
    input: { job_id: z.string(), id: z.string().describe("Variant id"), platform: z.enum(["instagram", "tiktok"]).default("instagram") },
  }, async (b) => desk("POST", "/api/reels/variants", { ...b, action: "approve" }));

  define(server, "log_reel_post", {
    title: "Log a posted reel", kind: "write", areas: ["content"],
    description: "Record that a variant was posted (platform, URL, in-app sound) so its metrics can be tracked.",
    input: { job_id: z.string(), variant_id: z.string(), platform: z.enum(["ig", "tiktok"]), url: z.string().url().optional(), sound: z.string().optional() },
  }, async (b) => desk("POST", "/api/reels/posts", b));

  define(server, "update_reel_post_metrics", {
    title: "Log post metrics", kind: "write", areas: ["content"],
    description: "Log 48-72h metrics for a logged post (feeds the learning loop).",
    input: {
      id: z.number().int(), views: z.number().optional(), avg_watch_s: z.number().optional(), likes: z.number().optional(), comments: z.number().optional(),
      shares: z.number().optional(), saves: z.number().optional(), follows: z.number().optional(),
    },
  }, async (b) => desk("PATCH", "/api/reels/posts", b));

  define(server, "run_reel_learning", {
    title: "Learn from posted results", kind: "write", areas: ["content"],
    description: "Leaderboard + next suggested matrix from logged post metrics; also promotes hooks to winner / retires losers per the desk's rules.",
    input: {},
  }, async () => desk("POST", "/api/reels/learn", undefined, { timeoutMs: 120_000 }));

  define(server, "refresh_reel_trends", {
    title: "Refresh trending sounds & hooks", kind: "write", areas: ["content"],
    description: "Have the desk research sounds and hooks trending now (Claude web search; optional, off unless the desk has an API key) and add them to the pools. Or pass sounds you found to add them directly.",
    input: {
      sounds: z.array(z.object({ title: z.string(), url: z.string().url(), artist: z.string().optional(), platform: z.string().optional(), why: z.string().optional(), seen: z.string().optional() })).optional(),
    },
  }, async ({ sounds }) => desk("POST", "/api/reels/trends", sounds?.length ? { sounds } : {}, { timeoutMs: 5 * 60_000 }));

  // Autopilot -------------------------------------------------------------------------------------

  define(server, "get_autopilot_status", {
    title: "Autopilot status", kind: "read", areas: ["content"],
    description: "The engine's overnight autopilot run: status, progress, stories rendered.",
    input: {},
  }, async () => deskOr(() => desk("GET", "/api/reels/autopilot"), () => engine().autopilotStatus()));

  define(server, "start_autopilot", {
    title: "Start autopilot", kind: "write", areas: ["content"],
    description: "Start an overnight run on a footage folder: the engine cuts stories, styled from your references with hooks from the pool (winners first). Long-running; uses the engine machine.",
    input: {
      folder: z.string().optional().describe("Footage folder on the engine machine (must be under AUTOPILOT_ROOTS); omit for AUTOPILOT_DEFAULT_FOLDER"),
      hours: z.number().min(0.1).max(14).describe("Time budget"), maxVideos: z.number().int().min(1).max(400).describe("Stop after this many videos"),
      hooksPerStory: z.number().int().min(1).max(6).default(3),
    },
  }, async (b) => desk("POST", "/api/reels/autopilot", b, { timeoutMs: 120_000 }));

  define(server, "stop_autopilot", {
    title: "Stop autopilot", kind: "write", areas: ["content"],
    description: "Stop the running autopilot (finished videos are kept).",
    input: {},
  }, async () => desk("POST", "/api/reels/autopilot", { action: "stop" }));
}
