import { getRepo, type Repo } from "@engine/db";
import { env } from "./env";

export interface AgentCtx {
  repo: Repo;
  log: (msg: string) => void;
  env: typeof env;
}
export type Agent = (ctx: AgentCtx) => Promise<void>;

const running = new Set<string>();

/** Wrap an agent: one run at a time, every run logged to ops.agent_runs. */
export async function runAgent(name: string, agent: Agent): Promise<void> {
  if (running.has(name)) return;
  running.add(name);
  const repo = getRepo();
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(m);
    console.log(`[${name}] ${m}`);
  };
  const id = crypto.randomUUID();
  const started_at = new Date().toISOString();
  await repo.insert("agent_runs", [{ id, agent: name, started_at, status: "running", finished_at: null, log: null }]);
  try {
    await agent({ repo, log, env });
    await repo.update("agent_runs", { id }, { status: "ok", finished_at: new Date().toISOString(), log: lines.join("\n").slice(-8000) });
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    await repo.update("agent_runs", { id }, { status: "failed", finished_at: new Date().toISOString(), log: lines.join("\n").slice(-8000) });
  } finally {
    running.delete(name);
  }
}

/** Approvals are the only way agents ask for something external to happen. */
export async function propose(repo: Repo, a: { type: "fix_pr" | "post" | "outreach_email" | "ad_change" | "other"; title: string; summary?: string; preview?: Record<string, unknown>; ref_table?: string; ref_id?: string; agent: string }) {
  const [row] = await repo.insert("approvals", [{
    id: crypto.randomUUID(), type: a.type, title: a.title, summary: a.summary ?? null, preview: a.preview ?? {},
    ref_table: a.ref_table ?? null, ref_id: a.ref_id ?? null, status: "pending", created_by_agent: a.agent,
    decided_by: null, decided_at: null, result: null, created_at: new Date().toISOString(),
  }]);
  return row;
}

export async function raise(repo: Repo, i: { source: string; severity: "info" | "warn" | "error" | "critical"; title: string; body?: string; fingerprint: string; payload?: Record<string, unknown> }) {
  const [existing] = await repo.list("incidents", { eq: { fingerprint: i.fingerprint } });
  const now = new Date().toISOString();
  if (existing) {
    await repo.update("incidents", { fingerprint: i.fingerprint }, { occurrences: existing.occurrences + 1, last_seen: now, body: i.body ?? existing.body, severity: i.severity });
    return existing;
  }
  const [row] = await repo.insert("incidents", [{
    id: crypto.randomUUID(), source: i.source, severity: i.severity, title: i.title, body: i.body ?? null, payload: i.payload ?? {},
    fingerprint: i.fingerprint, occurrences: 1, users_affected: 0, status: "open", proposed_fix: null, first_seen: now, last_seen: now, resolved_at: null,
  }]);
  return row;
}
