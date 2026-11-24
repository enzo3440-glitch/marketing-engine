// Client for the Reel Engine worker API (services/reel-engine, engine/server.py).
// With VIDEO_ENGINE_URL unset it runs as a stub: jobs move queued → rendering → done on a timer and the
// manifest is expanded from the request exactly like engine/batch.py:expand(), without media files.
import type { ReelJobRequest, RefTextLook } from "@engine/db";
import { leaderboard, nextMatrix, type PerfRow } from "@engine/db";
import { httpJson, type Connector, type ConnectorContext, type Status } from "./types";

export interface EngineVariant {
  id: string; format?: string; file?: string; bare?: string; poster?: string; caption_file?: string;
  duration?: number; size_mb?: number; warnings?: string[]; hook?: string; grade?: string; music?: string;
  tags?: Record<string, string>; error?: string;
}
export interface RefLine { shot: number; t: number; t1: number; text: string; pos: "top" | "center" | "bottom"; size: number; look?: RefTextLook }
export interface EngineManifest { job_id: string; clips?: Record<string, unknown>; variants: EngineVariant[]; stub?: boolean }
/** One thing a request can build from (engine/library.py): real footage, a ready phone shot, or an app screen. */
export interface LibraryItem { id: string; kind: "footage" | "phone" | "screen"; desc: string; place?: string | null; taken?: string | null; duration?: number | null }
export interface Library { items: LibraryItem[]; sheet: string | null; knowledge: { name: string; text: string }[] }
export interface ReviseInfo {
  brief: Record<string, unknown>; clips: { id: string; kind: string; duration: number; subject?: string }[]; music: string[];
  cuts?: number[]; duration?: number; warnings: string[]; sheet: { jpg: string; times: number[] } | null; clip_sheet: string; editable: string[];
}
export interface EngineJob {
  job_id: string; status: "queued" | "rendering" | "done" | "error"; manifest?: EngineManifest; error?: string; progress?: number;
}

export class ReelEngine {
  readonly stub: boolean;
  constructor(private base?: string, private token?: string) {
    this.stub = !base;
  }
  static fromEnv(env: Record<string, string | undefined>) {
    return new ReelEngine(env.VIDEO_ENGINE_URL?.replace(/\/$/, ""), env.REEL_TOKEN);
  }
  private h(extra: Record<string, string> = {}) {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async health(): Promise<Status> {
    if (this.stub) return { status: "not_configured", detail: "VIDEO_ENGINE_URL unset: stub renders (no media)" };
    const r = await httpJson<{ ok: boolean; queued: number }>(`${this.base}/health`, { headers: this.h(), timeoutMs: 5000 });
    return { status: r.ok ? "connected" : "error", detail: `${r.queued} queued` };
  }

  async upload(name: string, body: ArrayBuffer | ReadableStream<Uint8Array>): Promise<{ path: string; bytes: number }> {
    if (this.stub) return { path: name, bytes: body instanceof ArrayBuffer ? body.byteLength : 0 };
    return httpJson(`${this.base}/upload?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: this.h({ "Content-Type": "application/octet-stream" }), body: body as BodyInit,
      // @ts-expect-error Node fetch needs duplex for streamed bodies
      duplex: "half", timeoutMs: 10 * 60_000,
    });
  }

  async createJob(job: ReelJobRequest): Promise<EngineJob> {
    if (this.stub) return { job_id: job.job_id, status: "queued" };
    return httpJson(`${this.base}/jobs`, { method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify(job) });
  }

  /** Load batches written straight into the engine's output folder (manifest.json per batch). */
  async rehydrate(): Promise<number> {
    if (this.stub) return 0;
    return (await httpJson<{ added: number }>(`${this.base}/rehydrate`, { method: "POST", headers: this.h() })).added;
  }

  /** Jobs the engine knows (incl. finished jobs it reloaded from disk and CLI batches). Empty in stub mode. */
  async listJobs(): Promise<{ job_id: string; status: EngineJob["status"]; queued?: number }[]> {
    if (this.stub) return [];
    return httpJson(`${this.base}/jobs`, { headers: this.h() });
  }

  /** Delete a finished batch from disk, or just one video of it. A 404 (already gone) counts as done. */
  async deleteJob(jobId: string, variantId?: string): Promise<void> {
    if (this.stub) return;
    const path = `/jobs/${encodeURIComponent(jobId)}${variantId ? `/${encodeURIComponent(variantId)}` : ""}`;
    const r = await fetch(`${this.base}${path}`, { method: "DELETE", headers: this.h() });
    if (!r.ok && r.status !== 404) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `engine ${r.status}`);
  }

  /** `request` and `createdAt` drive the stub; the real engine ignores them. */
  async getJob(jobId: string, request?: ReelJobRequest, createdAt?: string): Promise<EngineJob> {
    if (!this.stub) return httpJson(`${this.base}/jobs/${encodeURIComponent(jobId)}`, { headers: this.h() });
    const age = Date.now() - Date.parse(createdAt ?? new Date().toISOString());
    if (age < 4000) return { job_id: jobId, status: "queued" };
    if (age < 12000) return { job_id: jobId, status: "rendering", progress: (age - 4000) / 8000 };
    return { job_id: jobId, status: "done", manifest: stubManifest(request ?? { job_id: jobId, clips: [], defaults: {} }) };
  }

  /** Measure a style reference already uploaded to input/: shots, cut rate, opening hold, suggested pacing. */
  async analyzeRef(path: string, opts: { text?: boolean } = {}): Promise<Record<string, unknown> | null> {
    if (this.stub) return null;
    return httpJson(`${this.base}/refs/analyze`, {
      method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify({ path, text: !!opts.text }), timeoutMs: 8 * 60_000,
    });
  }

  /** On-screen text of a reel read from its link: frames sampled in memory → captions with when they show. */
  async ocrFrames(frames: { t: number; jpg: string }[], shots: number[], turn?: "cw" | "ccw" | null): Promise<RefLine[]> {
    if (this.stub || !frames.length) return [];
    const r = await httpJson<{ lines: RefLine[] }>(`${this.base}/refs/ocr`, {
      method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify({ frames, shots, turn: turn ?? null }), timeoutMs: 15 * 60_000,
    });
    return r.lines ?? [];
  }

  /** Is this sound (input/<file>) a song one of the others already uses? Where it starts in theirs, in seconds. */
  async songMatch(audio: string, others: { id: string; audio: string }[]): Promise<{ id: string; score: number; at: number } | null> {
    if (this.stub || !others.length) return null;
    const r = await httpJson<{ match: { id: string; score: number; at: number } | null }>(`${this.base}/refs/song`, {
      method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify({ audio, others }), timeoutMs: 5 * 60_000,
    });
    return r.match ?? null;
  }

  /** A clip as 8 numbered moments on one JPEG (base64) with their times, for a clip read. Null in stub mode. */
  async clipSheet(path: string): Promise<{ jpg: string; times: number[]; duration: number } | null> {
    if (this.stub) return null;
    return httpJson(`${this.base}/clips/sheet`, {
      method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify({ path }), timeoutMs: 2 * 60_000,
    });
  }

  /** What a revision of one finished video can change (engine/revise.py): its brief, the batch's clips and music, contact sheets. */
  async reviseInfo(jobId: string, variantId: string): Promise<ReviseInfo | null> {
    if (this.stub) return null;
    const r = await fetch(`${this.base}/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(variantId)}/revise`, { cache: "no-store", headers: this.h(), signal: AbortSignal.timeout(10 * 60_000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `engine ${r.status}`);
    return (await r.json()) as ReviseInfo;
  }

  /** Render a changed copy of one video into its batch as <variant>-r<N>. */
  async revise(jobId: string, variantId: string, change: Record<string, unknown>): Promise<{ rev: string; id: string; status: string }> {
    if (this.stub) throw new Error("Revisions need the engine running (VIDEO_ENGINE_URL)");
    return httpJson(`${this.base}/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(variantId)}/revise`, {
      method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify({ change }),
    });
  }

  async revision(rev: string): Promise<{ status: "queued" | "rendering" | "done" | "error"; id: string; variant?: EngineVariant; error?: string }> {
    return httpJson(`${this.base}/revisions/${encodeURIComponent(rev)}`, { headers: this.h() });
  }

  /** Overnight autopilot (engine/autopilot.py). */
  async autopilotStart(cfg: Record<string, unknown>): Promise<{ run_id: string; status: string }> {
    if (this.stub) throw new Error("Autopilot needs the engine running (VIDEO_ENGINE_URL)");
    return httpJson(`${this.base}/autopilot`, { method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify(cfg) });
  }
  async autopilotStatus(): Promise<Record<string, unknown>> {
    if (this.stub) return { status: "unavailable" };
    return httpJson(`${this.base}/autopilot`, { headers: this.h() });
  }
  async autopilotStop(): Promise<void> {
    if (!this.stub) await httpJson(`${this.base}/autopilot/stop`, { method: "POST", headers: this.h() });
  }

  /** Bundled tracks + songs you uploaded (engine <root>/music). Empty in stub mode. */
  async listMusic(): Promise<{ name: string; path: string; source: "yours" | "bundled" }[]> {
    if (this.stub) return [];
    return httpJson(`${this.base}/music`, { headers: this.h() });
  }

  /** Upload a song of your own; it becomes selectable as music/<name>. */
  async uploadMusic(name: string, body: ArrayBuffer | ReadableStream<Uint8Array>): Promise<{ path: string; bytes: number }> {
    if (this.stub) throw new Error("Uploading music needs the engine running (VIDEO_ENGINE_URL)");
    return httpJson(`${this.base}/upload?name=${encodeURIComponent(name)}&kind=music`, {
      method: "POST", headers: this.h({ "Content-Type": "application/octet-stream" }), body: body as BodyInit,
      // @ts-expect-error Node fetch needs duplex for streamed bodies
      duplex: "half", timeoutMs: 5 * 60_000,
    });
  }

  /** The asset library (footage, phone shots, app screens), a labelled sheet of it, and what we've learned (knowledge/*.md). */
  async library(): Promise<Library> {
    if (this.stub) return { items: [], sheet: null, knowledge: [] };
    return httpJson(`${this.base}/library`, { headers: this.h(), timeoutMs: 5 * 60_000 });
  }

  /** The director's trend template library + editing rules (engine/edit_rules.py). */
  async getTemplates(): Promise<{ templates: Record<string, unknown>[]; rules: Record<string, string[]> }> {
    if (this.stub) return { templates: [], rules: {} };
    return httpJson(`${this.base}/templates`, { headers: this.h() });
  }

  /** A reference video you dropped (input/ref_*), for template previews; null in stub mode. */
  async fetchRefVideo(name: string): Promise<Response | null> {
    return this.stub ? null : fetch(`${this.base}/input/${encodeURIComponent(name)}`, { headers: this.h() });
  }

  /** A music track (bundled or yours) for previews; null in stub mode. */
  async fetchMusic(name: string): Promise<Response | null> {
    return this.stub ? null : fetch(`${this.base}/music/${encodeURIComponent(name)}`, { headers: this.h() });
  }

  /** Proxy target for rendered media; null in stub mode. */
  fileUrl(jobId: string, name: string): string | null {
    return this.stub ? null : `${this.base}/files/${encodeURIComponent(jobId)}/${name.split("/").map(encodeURIComponent).join("/")}`;
  }
  async fetchFile(jobId: string, name: string): Promise<Response | null> {
    const u = this.fileUrl(jobId, name);
    return u ? fetch(u, { headers: this.h() }) : null;
  }

  async learn(rows: PerfRow[], hooks: { id: string; text: string }[], formats: string[]) {
    if (this.stub) return { leaderboard: leaderboard(rows), next: nextMatrix(rows, hooks, formats), source: "local" as const };
    const r = await httpJson<{ leaderboard: ReturnType<typeof leaderboard>; next: ReturnType<typeof nextMatrix> }>(`${this.base}/learn`, {
      method: "POST", headers: this.h({ "Content-Type": "application/json" }), body: JSON.stringify({ rows, hooks, formats }),
    });
    return { ...r, source: "engine" as const };
  }
}

/** Port of engine/batch.py:expand() for the stub manifest. */
export function stubManifest(job: ReelJobRequest): EngineManifest {
  const base = job.defaults ?? {};
  const out: EngineVariant[] = (job.variants ?? []).map((v, i) => ({ id: String(v.id ?? `v${String(i + 1).padStart(2, "0")}`), format: String(v.format ?? "montage"), hook: v.hook as string }));
  const mx = job.matrix;
  if (mx) {
    const hooks = mx.hooks?.length ? mx.hooks : [{ id: "h0", text: String(base.hook ?? "") }];
    const grades = mx.grades?.length ? mx.grades : [String(base.grade ?? "clean")];
    const musics = mx.music?.length ? mx.music : [String(base.music ?? "synth:cinematic")];
    let k = 0;
    for (const fmt of mx.formats?.length ? mx.formats : ["montage"]) {
      for (const h of hooks) {
        for (let r = 0; r < (mx.per_combo ?? 1); r++) {
          const grade = grades[(k + r) % grades.length], music = musics[(k + r) % musics.length];
          out.push({
            id: `${fmt}-${h.id}-${r + 1}`, format: fmt, hook: h.text, grade, music,
            duration: fmt === "oneshot" ? 8 : Number(base.duration ?? 12), warnings: [],
            tags: { format: fmt, hook_id: h.id, grade, music, pacing: String(base.pacing ?? "fast") },
          });
        }
        k++;
      }
    }
  }
  return { job_id: job.job_id, variants: mx?.max ? out.slice(0, mx.max) : out, stub: true };
}

export function reelEngineConnector(ctx: ConnectorContext): Connector {
  const engine = ReelEngine.fromEnv(ctx.env);
  return {
    id: "reel_engine", label: "Reel Engine", requiredEnv: ["VIDEO_ENGINE_URL", "REEL_TOKEN"], implemented: true,
    docs: "services/reel-engine/references/contract.md",
    test: () => engine.health(),
    async sync() {},
  };
}
