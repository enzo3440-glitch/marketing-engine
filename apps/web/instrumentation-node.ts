// Every 5 minutes: switch on ad campaigns whose start date came and close ones that ended (lib/ad-tick.ts).
// Every 30 minutes: the autopilot (lib/autopilot.ts) reads results and makes the next versions. It's server-only code,
// so the clock calls its route with a key only this process knows.
import { randomUUID } from "node:crypto";
import { tickAdCampaigns } from "./lib/ad-tick";

const g = globalThis as { __adTicker?: ReturnType<typeof setInterval>; __autopilotTicker?: ReturnType<typeof setInterval>; __autopilotKey?: string };
if (!g.__adTicker) {
  const tick = () => tickAdCampaigns().catch((e) => console.error("[ads] tick failed:", (e as Error).message));
  g.__adTicker = setInterval(tick, 5 * 60_000);
  setTimeout(tick, 30_000);
}
if (!g.__autopilotTicker && (process.env.DESK_AUTOPILOT ?? "on").toLowerCase() !== "off") {
  g.__autopilotKey = randomUUID();
  const port = process.env.PORT || "3000";
  const tick = () => fetch(`http://127.0.0.1:${port}/api/autopilot`, { method: "POST", headers: { "x-autopilot-key": g.__autopilotKey! } })
    .then((r) => (r.ok ? null : r.text().then((t) => console.error("[autopilot]", r.status, t.slice(0, 200)))))
    .catch((e) => console.error("[autopilot] tick failed:", (e as Error).message));
  g.__autopilotTicker = setInterval(tick, 30 * 60_000);
  setTimeout(tick, 2 * 60_000);
}
