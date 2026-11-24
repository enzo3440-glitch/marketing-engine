// Mock mode keeps data in memory; without this, every desk restart wiped what people entered (references,
// hooks, approvals, posts...). User-editable tables are saved to data/private/mock-state.json (gitignored)
// and laid over the freshly generated dataset on start. Generated series (metrics, spend, ads) stay fresh.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./cmo";
import type { Dataset } from "./mock";

export const PERSISTED_TABLES = [
  "approvals", "incidents", "content_items", "build_items", "capital_contacts", "fin_actuals", "fin_scenarios",
  "reel_clips", "reel_hooks", "reel_jobs", "reel_variants", "reel_posts", "reel_refs", "cmo_recommendations",
  "advisor_events", "integrations", "marketing_map", "ad_campaigns", "growth_tests",
] as const satisfies readonly (keyof Dataset)[];

export const mockStatePath = () => process.env.OPS_MOCK_STATE ?? path.join(dataDir(), "private", "mock-state.json");

export function loadMockState(ds: Dataset): Dataset {
  try {
    const saved = JSON.parse(fs.readFileSync(mockStatePath(), "utf8")) as Partial<Dataset>;
    for (const t of PERSISTED_TABLES) if (saved[t] != null) (ds as unknown as Record<string, unknown>)[t] = saved[t];
  } catch {
    // first run, or unreadable file: keep the generated dataset
  }
  return ds;
}

export function saveMockState(ds: Dataset): void {
  const out: Record<string, unknown> = { savedAt: new Date().toISOString() };
  for (const t of PERSISTED_TABLES) out[t] = ds[t];
  const p = mockStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, p); // atomic replace
}
