import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRepo, type ClipRead, type ReelClip, type ReelJobRequest } from "@engine/db";
import { engine, waitingJobs as W } from "./reels";
import { BRAND } from "./brand";

/**
 * Clip read: Claude looks at 8 moments of each clip and says how striking it is, what's in it, which scene it
 * belongs to and which seconds to use. The editor ranks shots by this instead of sharpness alone, spaces out takes
 * of the same scene, and cuts to the moments it picked.
 *
 * Runs on your Claude subscription (Max), not an API key: the desk starts Claude Code headless (`claude -p`) with
 * only this repo's MCP server and only its three clip tools (list_unread_clips → view_clip → save_clip_read).
 */
const ROOT = path.resolve(process.cwd(), "../..");
const SERVER = "marketing-engine";
const TOOLS = ["list_unread_clips", "view_clip", "save_clip_read"].map((t) => `mcp__${SERVER}__${t}`);

const PROMPT = `You are the picture editor for ${BRAND.name}'s short-form video channel (${BRAND.pitch}).
Read every clip that is waiting: call list_unread_clips, then for each clip call view_clip, judge it by the guide that
list_unread_clips returns, and call save_clip_read. Reuse an existing scene name for takes of the same place or subject.
Set skip true (and say why in flaws) for any clip that doesn't fit the ${BRAND.niche} niche (see the shot rules in brand-content.md / brand-voice.md): a workout or
progress photo, a mirror selfie, an off-topic product shot, a personal shot, anything about a body or
an outfit instead of the subject.
When list_unread_clips says clips are left, call it again. Do nothing else, and finish with one line: how many you read.`;

export function valid(x: unknown, duration: number): Omit<ClipRead, "read_at"> | null {
  const o = x as Partial<ClipRead>;
  if (!o || typeof o.rating !== "number" || typeof o.subject !== "string" || typeof o.scene !== "string") return null;
  const moments = (Array.isArray(o.moments) ? o.moments : [])
    .map((m) => ({ t0: Math.max(0, Number(m.t0)), t1: Math.min(duration, Number(m.t1)), why: String(m.why ?? ""),
      ...(Number.isFinite(Number(m.peak)) ? { peak: Number(m.peak) } : {}) }))
    .filter((m) => Number.isFinite(m.t0) && Number.isFinite(m.t1) && m.t1 - m.t0 >= 0.5)
    .map((m) => (m.peak === undefined ? m : { ...m, peak: Math.min(m.t1, Math.max(m.t0, m.peak)) }));
  return {
    rating: Math.min(1, Math.max(0, o.rating)), subject: o.subject.slice(0, 120), scene: o.scene.slice(0, 60).toLowerCase(),
    moments, skip: !!o.skip, flaws: typeof o.flaws === "string" ? o.flaws.slice(0, 200) : "",
    ...(o.best_for && ["hold", "quick", "both"].includes(o.best_for) ? { best_for: o.best_for } : {}),
  };
}

/** CLAUDE_CLI, else the newest Claude Code the desktop app installed, else `claude` on PATH. */
export function claudeCli(): string {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  const base = path.join(process.env.LOCALAPPDATA ?? "", "Claude-Data");
  const found: { p: string; t: number }[] = [];
  try {
    for (const a of fs.readdirSync(base)) {
      const cc = path.join(base, a, "claude-code");
      if (!fs.existsSync(cc)) continue;
      for (const v of fs.readdirSync(cc)) for (const h of fs.readdirSync(path.join(cc, v))) {
        const p = path.join(cc, v, h, process.platform === "win32" ? "claude.exe" : "claude");
        if (fs.existsSync(p)) found.push({ p, t: fs.statSync(p).mtimeMs });
      }
    }
  } catch { /* no desktop install */ }
  return found.sort((a, z) => z.t - a.t)[0]?.p ?? "claude";
}

// One headless session at a time; clips added while it runs are picked up by a follow-up run.
// Lives on globalThis so a dev reload joins the running session instead of starting a second one.
const S = ((globalThis as { __clipReads?: { running: boolean; again: boolean; last?: string } }).__clipReads ??= { running: false, again: false });

function runSession(): Promise<string> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // always the subscription login, never a key that happens to be set
    const p = spawn(claudeCli(), [
      "-p", PROMPT, "--mcp-config", path.join(ROOT, ".mcp.json"), "--strict-mcp-config",
      "--allowedTools", TOOLS.join(","), "--output-format", "text",
    ], { cwd: ROOT, env, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    const kill = setTimeout(() => p.kill(), 60 * 60_000);
    p.on("error", (e) => { clearTimeout(kill); resolve(`could not start Claude Code (${e.message}); set CLAUDE_CLI`); });
    p.on("close", (code) => { clearTimeout(kill); resolve(code === 0 ? out.trim().split("\n").pop() ?? "" : `exit ${code}: ${out.slice(-300)}`); });
  });
}

/** Start reading any unread clips in the background (no-op if a session is already on it). */
export function queueClipReads(clips: ReelClip[]): number {
  const todo = clips.filter((c) => !c.read && c.kind !== "reference").length;
  if (!todo) return 0;
  if (S.running) { S.again = true; return todo; }
  S.running = true;
  void (async () => {
    const unread = async () => (await getRepo().list("reel_clips")).filter((c) => !c.read && c.kind !== "reference").length;
    do {
      S.again = false;
      const before = await unread();
      S.last = await runSession();
      const left = await unread();
      console.log(`[clips] read session: ${S.last} (${before - left} read, ${left} left)`);
      if (left && left < before) S.again = true; // more to do and it's making progress: go again
    } while (S.again);
    S.running = false;
  })();
  return todo;
}

export const clipReadStatus = () => ({ running: S.running, last: S.last ?? null });

/**
 * Send a batch to the engine with every clip's read attached. Clips nobody has looked at yet (e.g. just dropped,
 * with auto-make on) get read first: the batch shows as queued, and goes to the engine when the reads are done
 * (or after 20 minutes, with whatever reads exist), so no batch is ever cut blind.
 */
export async function submitWhenRead(request: ReelJobRequest): Promise<{ job_id: string; status: "queued" | "rendering" | "done" | "error" }> {
  const e = engine();
  const repo = getRepo();
  const ids = new Set(request.clips.map((c) => c.id));
  const unread = (await repo.list("reel_clips")).filter((c) => ids.has(c.id) && !c.read && c.kind !== "reference");
  if (e.stub || !unread.length) return e.createJob(request);
  queueClipReads(unread);
  W.add(request.job_id);
  void (async () => {
    const until = Date.now() + 20 * 60_000;
    let clips = await repo.list("reel_clips");
    while (Date.now() < until && clips.some((c) => ids.has(c.id) && !c.read && c.kind !== "reference") && clipReadStatus().running) {
      await new Promise((r) => setTimeout(r, 5000));
      clips = await repo.list("reel_clips");
    }
    const by = new Map(clips.map((c) => [c.id, c]));
    const ready = { ...request, clips: request.clips.map((c) => ({ ...c, ...(by.get(c.id)?.read ? { read: by.get(c.id)!.read } : {}) })) };
    try {
      const created = await e.createJob(ready);
      await repo.update("reel_jobs", { job_id: request.job_id }, { request: ready, status: created.status, created_at: new Date().toISOString() });
    } catch (x) {
      await repo.update("reel_jobs", { job_id: request.job_id }, { status: "error", error: `Could not start: ${x instanceof Error ? x.message : String(x)}` });
    } finally {
      W.delete(request.job_id);
    }
  })();
  return { job_id: request.job_id, status: "queued" };
}
