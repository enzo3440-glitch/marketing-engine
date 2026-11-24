// Worker entry. `tsx src/index.ts` schedules every agent; `tsx src/index.ts run <agent>` runs one now.
import cron from "node-cron";
import { getRepo } from "@engine/db";
import { cmo } from "./agents/cmo";
import { crashTriage } from "./agents/crashTriage";
import { financeModeler } from "./agents/financeModeler";
import { growthAnalyst } from "./agents/growthAnalyst";
import { inboxScout } from "./agents/inboxScout";
import { infraWatcher } from "./agents/infraWatcher";
import { spendWatcher } from "./agents/spendWatcher";
import { TZ } from "./env";
import { executor } from "./executor";
import { runAgent, type Agent } from "./run";

const schedule: Record<string, [string, Agent]> = {
  spendWatcher: ["0 * * * *", spendWatcher],
  infraWatcher: ["*/5 * * * *", infraWatcher],
  crashTriage: ["* * * * *", crashTriage],
  growthAnalyst: ["0 6 * * *", growthAnalyst],
  cmo: ["0 7 * * *", cmo],
  financeModeler: ["30 5 * * *", financeModeler],
  inboxScout: ["*/15 * * * *", inboxScout],
  executor: ["* * * * *", executor],
};

// Mock mode: the desk owns data/private/mock-state.json. The worker reads it but never writes it back,
// otherwise its stale in-memory copy would overwrite edits made in the desk.
process.env.OPS_MOCK_PERSIST ??= "0";

const [cmd, name] = process.argv.slice(2);
if (cmd === "run") {
  const entry = schedule[name];
  if (!entry) {
    console.error(`Unknown agent. One of: ${Object.keys(schedule).join(", ")}`);
    process.exit(1);
  }
  await runAgent(name, entry[1]);
  process.exit(0);
}

console.log(`engine-worker: ${getRepo().mode} mode, tz ${TZ}`);
if (getRepo().mode === "mock") console.log("No SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY: agent output is in-memory only and not visible to the web app.");
for (const [n, [expr, agent]] of Object.entries(schedule)) {
  cron.schedule(expr, () => void runAgent(n, agent), { timezone: TZ });
  console.log(`  ${n.padEnd(15)} ${expr}`);
}
