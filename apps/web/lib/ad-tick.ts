// The ad campaign calendar's clock, kept free of server-only imports so instrumentation.ts can load it.
import { MetaAds } from "@engine/connectors";
import { getRepo, type AdCampaign } from "@engine/db";

const now = () => new Date().toISOString();
const hstToday = () => new Date(Date.now() - 10 * 3600_000).toISOString().slice(0, 10);

export async function tickCampaign(c: AdCampaign, m: MetaAds, today = hstToday()): Promise<void> {
  const repo = getRepo();
  if (c.status === "ready" && c.starts_on <= today && c.ends_on >= today && c.meta.campaign_id) {
    await m.setCampaignStatus(c.meta.campaign_id, "ACTIVE");
    await repo.update("ad_campaigns", { id: c.id }, { status: "live", meta: { ...c.meta, activated_at: now() }, updated_at: now() });
  } else if (["ready", "live", "paused"].includes(c.status) && c.ends_on < today) {
    if (c.meta.campaign_id) await m.setCampaignStatus(c.meta.campaign_id, "PAUSED"); // the ad set's end time already stopped it
    if (c.meta.waves?.winners_campaign_id) await m.setCampaignStatus(c.meta.waves.winners_campaign_id, "PAUSED");
    await repo.update("ad_campaigns", { id: c.id }, { status: "ended", updated_at: now() });
  }
}

/** Every few minutes (instrumentation.ts): switch on campaigns whose start date came, close ones that ended. */
export async function tickAdCampaigns(): Promise<void> {
  const m = MetaAds.fromEnv(process.env);
  if (!m) return;
  for (const c of await getRepo().list("ad_campaigns")) {
    try {
      await tickCampaign(c, m);
    } catch (e) {
      await getRepo().update("ad_campaigns", { id: c.id }, { meta: { ...c.meta, error: (e as Error).message }, updated_at: now() });
    }
  }
}
