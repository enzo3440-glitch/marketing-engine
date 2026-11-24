// Worker agents (apps/worker): recent runs, and run-now in a child worker process.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENTS } from "@engine/db";
import { readRepo, requireArea, ROOT, ToolError, type Area } from "../context";
import { define } from "../tool";

/** Which desk area owns each agent's output; run-now needs access to it. */
const OWNER: Record<(typeof AGENTS)[number], Area> = {
  spendWatcher: "ops", infraWatcher: "ops", crashTriage: "build", growthAnalyst: "growth", cmo: "content",
  financeModeler: "finance", inboxScout: "calendar", executor: "command",
};

const tsxCli = () => createRequire(import.meta.url).resolve("tsx/cli");

function runWorker(agent: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli(), "src/index.ts", "run", agent], {
      cwd: path.join(ROOT, "apps", "worker"), env: { ...process.env, OPS_MOCK_PERSIST: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "", timedOut = false;
    const take = (b: Buffer) => { output = (output + b.toString()).slice(-20_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const t = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, output, timedOut }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, output: e.message, timedOut }); });
  });
}

export function registerAgents(server: McpServer) {
  define(server, "list_agent_runs", {
    title: "Agent runs", kind: "read", areas: ["command", "ops"],
    description: `Recent worker agent runs with status and log tail. Agents: ${AGENTS.join(", ")}.`,
    input: { agent: z.enum(AGENTS).optional(), limit: z.number().int().min(1).max(100).default(10), withLogs: z.boolean().default(false) },
  }, async ({ agent, limit, withLogs }) => {
    const runs = await readRepo().list("agent_runs", { ...(agent ? { eq: { agent } } : {}), order: { col: "started_at", asc: false }, limit: 400 });
    return runs.slice(0, limit).map((r) => ({ ...r, log: withLogs ? r.log?.slice(-3000) ?? null : undefined }));
  });

  define(server, "run_agent", {
    title: "Run a worker agent now", kind: "write", areas: ["command", "build", "ops", "growth", "content", "finance", "calendar"],
    description: "Run one worker agent immediately (same as `pnpm --filter @engine/worker run-agent <name>`) and return its log. executor carries out approved approvals (PRs, posts, emails), so it needs confirm=true. In mock mode the worker can't write to the desk's data, so its output only shows in the returned log.",
    input: {
      agent: z.enum(AGENTS), confirm: z.boolean().optional().describe("Required for executor"),
      timeoutSec: z.number().int().min(10).max(900).default(300),
    },
  }, async ({ agent, confirm, timeoutSec }) => {
    requireArea(OWNER[agent]);
    if (agent === "executor" && confirm !== true) throw new ToolError("executor acts on approved items outside the desk (opens PRs, posts, sends email): call again with confirm=true once the user has agreed.");
    const r = await runWorker(agent, timeoutSec * 1000);
    const mock = readRepo().mode === "mock";
    return {
      agent, exitCode: r.code, timedOut: r.timedOut, log: r.output.trim(),
      ...(mock ? { note: "Mock mode: this run's writes (agent_runs, approvals, recommendations) stayed in the worker process and won't appear in the desk." } : {}),
    };
  });
}
