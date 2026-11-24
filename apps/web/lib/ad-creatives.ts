// Client-safe helpers for ad campaign creatives (no server-only imports): used by the desk pages and lib/ad-campaigns.ts.
import type { AdCampaign, AdCreativePick } from "@engine/db/types";

/** The campaign's ads: the `creatives` list, or the legacy single `creative` as a one-item list. */
export function creativesOf(c: Pick<AdCampaign, "creative" | "creatives">): AdCreativePick[] {
  if (c.creatives?.length) return c.creatives;
  const x = c.creative;
  if (!x) return [];
  return [x.ig_media_id
    ? { key: `ig:${x.ig_media_id}`, ig_media_id: x.ig_media_id, label: `Instagram post ${x.ig_media_id.slice(-6)}` }
    : { key: `${x.job_id}|${x.variant_id}`, job_id: x.job_id, variant_id: x.variant_id, file: x.file, poster: x.poster }];
}
