// Fill a Supabase project (after migrations) with the 90-day mock dataset plus the migrated CMO data.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm seed [--reset]
import { buildMockDataset, SupabaseRepo, type TableName } from "../src/index";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Mock mode needs no seed.");
  process.exit(1);
}
const repo = new SupabaseRepo(url, key);
const ds = buildMockDataset();

// Insert order respects foreign keys.
const order: [TableName, string][] = [
  ["integrations", "provider"], ["metrics_daily", "date,metric,source"], ["api_spend", "date,provider,model"],
  ["incidents", "id"], ["approvals", "id"], ["campaigns", "id"], ["campaign_daily", "campaign_id,date"],
  ["content_items", "id"], ["build_items", "id"], ["capital_contacts", "id"], ["fin_actuals", "month"],
  ["fin_scenarios", "id"], ["calendar_events", "id"], ["inbox_items", "id"], ["agent_runs", "id"], ["deploys", "id"],
  ["reel_clips", "id"], ["reel_hooks", "id"], ["reel_jobs", "job_id"], ["reel_variants", "job_id,id"], ["reel_refs", "id"],
  ["cmo_recommendations", "id"],
];

async function main() {
  for (const [table, conflict] of order) {
    const rows = ds[table] as unknown as Record<string, unknown>[];
    for (let i = 0; i < rows.length; i += 500) await repo.upsert(table, rows.slice(i, i + 500), conflict);
    console.log(`${table}: ${rows.length}`);
  }
  // reel_posts has a serial id; drop it so Postgres assigns one.
  await repo.insert("reel_posts", ds.reel_posts.map(({ id: _id, ...p }) => p));
  if (ds.cmo_snapshot) {
    await repo.insert("cmo_snapshots" as TableName, [ds.cmo_snapshot as never]);
    console.log("cmo_snapshots: 1");
  }
  await repo.saveMap(ds.marketing_map.doc, (await repo.getMap()).revision);
  console.log("marketing_maps: 1\nSeed complete.");
}
main().catch((e) => { console.error(e); process.exit(1); });
