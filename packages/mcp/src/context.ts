// Shared plumbing for the tools: env, roles, fresh repo reads, desk HTTP writes, the Reel Engine client.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReelEngine } from "@engine/connectors";
import { buildMockDataset, getRepo, loadMockState, MockRepo, type Dataset, type Repo, type Role } from "@engine/db";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Load <repo>/.env without overriding anything the MCP client already set. */
export function loadEnv() {
  // Mock mode: the desk owns data/private/mock-state.json. We read it fresh per call and never write it.
  process.env.OPS_MOCK_PERSIST ??= "0";
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const v = m[2].replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
    if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// Roles -------------------------------------------------------------------------------------------

export type Area = "command" | "build" | "ops" | "growth" | "content" | "capital" | "finance" | "calendar" | "settings";

/** Same map as apps/web/lib/auth.ts ACCESS. */
export const ACCESS: Record<Role, Area[]> = {
  ceo: ["command", "build", "ops", "growth", "content", "capital", "finance", "calendar", "settings"],
  marketing: ["growth", "content", "calendar"],
  eng: ["build", "ops", "settings"],
};

/** OPS_MCP_ROLE, else the desk's MOCK_ROLE, else ceo. */
export function role(): Role {
  const r = (process.env.OPS_MCP_ROLE ?? process.env.MOCK_ROLE ?? "ceo") as Role;
  return ACCESS[r] ? r : "eng";
}

export class ToolError extends Error {}

export function requireArea(...areas: Area[]) {
  const r = role();
  if (!areas.some((a) => ACCESS[r].includes(a))) throw new ToolError(`forbidden: role "${r}" has no access to ${areas.join("/")}`);
}

// Reads -------------------------------------------------------------------------------------------

let mockDs: Dataset | null = null;

/**
 * A repo for reads. Supabase: the shared client. Mock: the generated dataset with the desk's latest
 * mock-state.json laid over it on every call, so desk edits show up without restarting this server.
 */
export function readRepo(): Repo {
  const repo = getRepo();
  if (repo.mode !== "mock") return repo;
  mockDs ??= buildMockDataset();
  loadMockState(mockDs);
  return new MockRepo(mockDs, false);
}

// Writes ------------------------------------------------------------------------------------------

export const deskUrl = () => (process.env.OPS_DESK_URL ?? "http://localhost:3000").replace(/\/$/, "");

/**
 * Every write goes through the desk's own API routes: they hold the business rules (dedupe, hook pool,
 * job building, engine upload) and, in mock mode, the desk process is the only writer of mock-state.json.
 */
export async function desk<T = unknown>(method: string, route: string, body?: unknown, init: { raw?: BodyInit; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (init.raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    payload = init.raw;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${deskUrl()}${route}`, {
      method, headers, body: payload, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
      // @ts-expect-error Node fetch needs duplex for streamed bodies
      duplex: init.raw ? "half" : undefined,
    });
  } catch (e) {
    throw new DeskDown(`Ops Desk not reachable at ${deskUrl()} (${(e as Error).message}). Start it with \`pnpm dev\`; writes go through the desk.`);
  }
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (res.status === 401) throw new ToolError("The desk requires a signed-in session (Supabase auth is on); the MCP server can only write in local mock mode for now.");
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? (typeof data === "string" ? data.slice(0, 300) : res.statusText);
    throw new ToolError(`${method} ${route} → ${res.status}: ${msg}`);
  }
  return data as T;
}

export class DeskDown extends ToolError {}

/** Reads that prefer the desk's live view (it also syncs jobs) but can answer from the repo/engine when it's down. */
export async function deskOr<T>(read: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof DeskDown) return fallback();
    throw e;
  }
}

/** True when the desk answers. `next dev` can take seconds to answer while it recompiles. */
export async function deskUp(): Promise<boolean> {
  try {
    const r = await fetch(`${deskUrl()}/api/health`, { signal: AbortSignal.timeout(15_000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

// Engine ------------------------------------------------------------------------------------------

/** Reel Engine client; REEL_TOKEN stays in this process, never in tool output. */
export const engine = () => ReelEngine.fromEnv(process.env);

// Dates (Honolulu, like the desk) -----------------------------------------------------------------

export const hstToday = () => new Date(Date.now() - 10 * 3600_000).toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() - 10 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);
