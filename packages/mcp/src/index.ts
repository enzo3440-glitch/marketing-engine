#!/usr/bin/env node
// Marketing Engine Desk MCP server (stdio). `pnpm mcp` from the repo root; see packages/mcp/README.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { deskUrl, engine, loadEnv, readRepo, role } from "./context";
import { registerAgents } from "./tools/agents";
import { registerClips } from "./tools/clips";
import { registerDashboards } from "./tools/dashboards";
import { registerReels } from "./tools/reels";

// stdout carries JSON-RPC; anything a dependency logs goes to stderr instead.
console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);

loadEnv();

const server = new McpServer(
  { name: "marketing-engine", version: "0.1.0" },
  {
    instructions: [
      "Drives the Marketing Engine Desk: dashboards (command, growth, ops, build, finance, capital, calendar, CMO), approvals, the Reel Engine and worker agents.",
      "Tools marked [read-only] never change anything. [write] tools change desk or engine state through the desk's own API.",
      "Tools marked destructive (approvals, removals, clearing the clip bin, running the executor) need confirm=true: ask the user first.",
      "For a render: get_reel_options → list_reel_clips / list_reel_hooks / list_reel_music → create_reel_job → get_reel_job until done.",
    ].join(" "),
  },
);

registerDashboards(server);
registerReels(server);
registerClips(server);
registerAgents(server);

await server.connect(new StdioServerTransport());
console.error(`engine-mcp: role ${role()}, ${readRepo().mode} data, desk ${deskUrl()}, engine ${engine().stub ? "stub" : "live"}`);
