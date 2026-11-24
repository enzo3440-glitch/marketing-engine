// Import only the real migrated data (no mock rows): CMO Desk snapshot + watchlist research +
// Marketing Whiteboard map. Reads packages/db/data/private/*.json (gitignored).
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm import:cmo
import { cmoCampaigns, cmoContentItems, cmoHooks, cmoRecommendations, cmoRefs, loadCmoExport, loadMarketingMapSeed } from "../src/cmo";
import { SupabaseRepo, type TableName } from "../src/index";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  const cmo = loadCmoExport();
  const map = loadMarketingMapSeed();
  if (!cmo) throw new Error("packages/db/data/private/radar-snapshot.json not found");
  const s = cmo.snapshot;
  const content = cmoContentItems(s), recs = cmoRecommendations(s), hooks = cmoHooks(s, map), paid = cmoCampaigns(s);
  console.log(`snapshot observed ${cmo.observedAt}: ${content.length} posts, ${recs.length} recommendations, ${hooks.length} hooks, ${paid.campaigns.length} paid report rows, ${map.nodes.length} map ideas`);
  if (!url || !key) {
    console.log("Dry run (no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Mock mode already serves this data.");
    return;
  }
  const repo = new SupabaseRepo(url, key);
  await repo.insert("cmo_snapshots" as TableName, [{ observed_at: cmo.observedAt, exported_at: cmo.exportedAt, snapshot: s } as never]);
  await repo.upsert("content_items", content, "id");
  await repo.upsert("cmo_recommendations", recs, "id");
  await repo.upsert("reel_hooks", hooks, "id");
  await repo.upsert("campaigns", paid.campaigns, "id");
  await repo.upsert("reel_refs", cmoRefs(s), "id");
  const cur = await repo.getMap();
  if (cur.revision === 0) await repo.saveMap(map, 0);
  console.log("Import complete.");
}
main().catch((e) => { console.error(e); process.exit(1); });
