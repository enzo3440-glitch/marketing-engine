# @engine/mcp — drive the Ops Desk from Claude

An MCP server (official TypeScript SDK, stdio) that exposes the whole command center as tools: every dashboard,
the approvals queue, the Reel Engine (clips, references, hooks, music, jobs, variants, posts, trends, autopilot)
and the worker agents.

```bash
pnpm mcp          # from the repo root (stdio; normally your MCP client starts it for you)
pnpm --filter @engine/mcp inspect   # MCP Inspector UI
```

## How it talks to the desk

| | Path | Why |
|---|---|---|
| **Reads** | `@engine/db` `getRepo()` (Supabase, or mock) | In mock mode the generated dataset is re-overlaid with the desk's latest `packages/db/data/private/mock-state.json` on every call, so desk edits show up immediately. |
| **Writes** | The desk's HTTP API (`OPS_DESK_URL`, default `http://localhost:3000`) | The routes hold the business rules (dedupe, hook pool, job building, engine upload). In mock mode the desk process is the only writer of `mock-state.json`, so this server runs with `OPS_MOCK_PERSIST=0` and never writes it. |
| **Engine state** | `@engine/connectors` `ReelEngine.fromEnv` | Engine health, music and autopilot status. `REEL_TOKEN` stays in this process and is never put in tool output. |
| **Agents** | Child `apps/worker` process (`run <agent>`) | Same as `pnpm --filter @engine/worker run-agent`. In mock mode its writes stay in that process. |

So writes need the desk running (`pnpm dev`). Secrets come from the repo's `.env` (loaded at start, never
overriding what the client passes in) and are never returned by any tool.

## Safety

- Every tool description starts with `[read-only]`, `[write]` or `[write, destructive: needs confirm=true]`, and
  carries the matching MCP annotations (`readOnlyHint`, `destructiveHint`).
- Destructive tools need `confirm: true`: `approve_approval`, `reject_approval`, `remove_reel_clip`,
  `clear_reel_clips`, `remove_reel_reference`, `remove_reel_job`. `run_agent` needs it for `executor`, which
  carries out approved items (PRs, posts, email).
- **Roles** use the same map as the desk (`apps/web/lib/auth.ts`): `ceo` sees all, `marketing` gets
  growth/content/calendar, `eng` gets build/ops/settings. The role is `OPS_MCP_ROLE`, else `MOCK_ROLE`, else `ceo`.
  The desk also enforces its own role on every write.
- Writes stop with an error when Supabase auth is on (the desk API needs a browser session); for now that means
  writes only work in local mock mode.

## Tools

| Area | Read-only | Write |
|---|---|---|
| Command | `get_command_overview`, `list_approvals`, `get_approval`, `list_agent_runs` | `approve_approval`\*, `reject_approval`\*, `run_agent` |
| Growth / Ops / Build | `get_growth_dashboard`, `get_ops_dashboard`, `get_build_board` | |
| Finance / Capital / Calendar | `get_finance_dashboard`, `get_capital_pipeline`, `get_calendar` | |
| CMO | `list_cmo_recommendations`, `get_cmo_watchlist`, `list_content_items` | `set_cmo_recommendation_status` |
| Reel Engine | `get_reel_engine_status`, `get_reel_options`, `list_reel_clips`, `list_reel_references`, `list_reel_hooks`, `list_reel_music`, `list_reel_templates`, `list_reel_jobs`, `get_reel_job`, `list_trending_sounds`, `get_autopilot_status` | `upload_reel_clip`, `update_reel_clip`, `remove_reel_clip`\*, `clear_reel_clips`\*, `add_reel_reference`, `upload_reel_reference`, `update_reel_reference`, `remove_reel_reference`\*, `add_reel_hook`, `set_reel_hook_status`, `upload_reel_music`, `create_reel_job`, `retry_reel_job`, `remove_reel_job`\*, `pick_reel_variant`, `propose_reel_post`, `log_reel_post`, `update_reel_post_metrics`, `run_reel_learning`, `refresh_reel_trends`, `start_autopilot`, `stop_autopilot` |

\* needs `confirm: true`

`create_reel_job` takes the batch builder's input (`BuilderInput` in `apps/web/lib/reels.ts`): `clipIds`,
`formats`, `hookIds`, `grades`, `music`, `duration`, `max`, `hashtags`, and optionally `pacing`, `referenceId`,
`caption`, `timingTrack`, `endcard`, `buildDrop`.

## Register it

**Claude Code**: the repo's `.mcp.json` registers it for this project (approve it when Claude Code asks). Or:

```bash
claude mcp add marketing-engine -- node /path/to/marketing-engine/packages/mcp/node_modules/tsx/dist/cli.mjs /path/to/marketing-engine/packages/mcp/src/index.ts
```

**Claude Desktop**: Settings → Developer → Edit Config (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "marketing-engine": {
      "command": "node",
      "args": [
        "/path/to/marketing-engine/packages/mcp/node_modules/tsx/dist/cli.mjs",
        "/path/to/marketing-engine/packages/mcp/src/index.ts"
      ],
      "env": { "OPS_DESK_URL": "http://localhost:3000", "OPS_MCP_ROLE": "ceo" }
    }
  }
}
```

It runs `node` on tsx directly rather than through `pnpm` so nothing but JSON-RPC reaches stdout.

## Env

| Var | Default | |
|---|---|---|
| `OPS_DESK_URL` | `http://localhost:3000` | Desk base URL for writes |
| `OPS_MCP_ROLE` | `MOCK_ROLE` or `ceo` | `ceo` \| `marketing` \| `eng` |
| `VIDEO_ENGINE_URL`, `REEL_TOKEN` | from `.env` | Reel Engine (unset = stub) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | from `.env` | Supabase reads instead of mock |
