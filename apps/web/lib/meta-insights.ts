import "server-only";
import { getRepo, PILLARS, type ContentItem } from "@engine/db";
import { metaAds } from "./ad-campaigns";

/**
 * Live Meta numbers for the Pulse page: ad insights from the ad account and Instagram media insights, read with the
 * desk's own Meta token (the same one that launches campaigns). Cached in memory for 10 minutes; null when Meta isn't
 * connected, so the page can fall back to what the desk already knows.
 */

const TTL = 10 * 60_000;
const cache = ((globalThis as { __metaInsights?: Map<string, { at: number; v: unknown }> }).__metaInsights ??= new Map());
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

export interface AdDay { date: string; spend: number; impressions: number; clicks: number; installs: number }
export interface AdCampaignRow { id: string; name: string; spend: number; impressions: number; clicks: number; installs: number; ctr: number; cpi: number | null; today: number }
export interface AdPulse { days: AdDay[]; campaigns: AdCampaignRow[]; currency: string }
export interface IgAccount { username: string; followers_count: number; media_count: number; profile_picture_url?: string }
export interface IgPost {
  id: string; caption: string; kind: string; at: string; permalink: string; thumb: string | null;
  likes: number; comments: number; reach: number | null; saves: number | null; shares: number | null; views: number | null; pillar: string | null;
}

type Action = { action_type: string; value: string };
const installs = (a?: Action[]) => Number(a?.find((x) => x.action_type === "mobile_app_install" || x.action_type === "omni_app_install")?.value ?? 0);

/** Daily account totals + per-campaign totals for the last `days` days. */
export async function adPulse(days = 30): Promise<AdPulse | null> {
  const m = metaAds();
  if (!m) return null;
  return cached(`ads:${days}`, async () => {
    const preset = days <= 7 ? "last_7d" : days <= 30 ? "last_30d" : "last_90d";
    type Row = { campaign_id: string; campaign_name: string; date_start: string; spend: string; impressions: string; clicks: string; actions?: Action[] };
    const [acct, daily, camps, today] = await Promise.all([
      m.account(),
      m.get<{ data: Row[] }>("act/insights", { level: "account", time_increment: 1, date_preset: preset, fields: "spend,impressions,clicks,actions", limit: 100 }),
      m.get<{ data: Row[] }>("act/insights", { level: "campaign", date_preset: preset, fields: "campaign_id,campaign_name,spend,impressions,clicks,actions", limit: 100 }),
      m.get<{ data: Row[] }>("act/insights", { level: "campaign", date_preset: "today", fields: "campaign_id,spend", limit: 100 }),
    ]);
    const todayBy = new Map(today.data.map((r) => [r.campaign_id, Number(r.spend)]));
    return {
      currency: acct.currency,
      days: daily.data.map((r) => ({ date: r.date_start, spend: Number(r.spend), impressions: Number(r.impressions), clicks: Number(r.clicks), installs: installs(r.actions) })),
      campaigns: camps.data.map((r) => {
        const spend = Number(r.spend), imp = Number(r.impressions), clicks = Number(r.clicks), inst = installs(r.actions);
        return { id: r.campaign_id, name: r.campaign_name, spend, impressions: imp, clicks, installs: inst, ctr: imp ? clicks / imp : 0, cpi: inst ? spend / inst : null, today: todayBy.get(r.campaign_id) ?? 0 };
      }).sort((a, b) => b.spend - a.spend),
    };
  });
}

export async function igAccount(): Promise<IgAccount | null> {
  const m = metaAds();
  if (!m) return null;
  return cached("ig:account", () => m.get<IgAccount>("ig", { fields: "username,followers_count,media_count,profile_picture_url" }));
}

/** Recent posts with reach / saves / shares / views, each tagged with the plan pillar whose hook it uses. */
export async function igPosts(limit = 24): Promise<IgPost[] | null> {
  const m = metaAds();
  if (!m) return null;
  const plan = await planHooks();
  return cached(`ig:media:${limit}`, async () => {
    const media = await m.get<{ data: { id: string; caption?: string; media_type: string; media_product_type?: string; timestamp: string; permalink: string; thumbnail_url?: string; media_url?: string; like_count?: number; comments_count?: number }[] }>("ig/media", {
      fields: "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count", limit,
    });
    return Promise.all(media.data.map(async (p) => {
      let ins: Record<string, number> = {};
      for (const metric of ["reach,saved,shares,views", "reach,saved,shares"]) { // "views" isn't available on every media type
        try {
          const r = await m.get<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(`${p.id}/insights`, { metric });
          ins = Object.fromEntries(r.data.map((d) => [d.name, d.total_value?.value ?? d.values?.[0]?.value ?? 0]));
          break;
        } catch { /* try the smaller metric set */ }
      }
      return {
        id: p.id, caption: p.caption ?? "", kind: p.media_product_type ?? p.media_type, at: p.timestamp, permalink: p.permalink,
        thumb: p.thumbnail_url ?? (p.media_type !== "VIDEO" ? p.media_url ?? null : null), likes: p.like_count ?? 0, comments: p.comments_count ?? 0,
        reach: ins.reach ?? null, saves: ins.saved ?? null, shares: ins.shares ?? null, views: ins.views ?? null, pillar: matchPillar(p.caption ?? "", plan),
      };
    }));
  });
}

/** Plan hooks by pillar (content pipeline items from the marketing plan), for matching a post to its pillar. */
async function planHooks(): Promise<{ hook: string; pillar: string }[]> {
  return (await getRepo().list("content_items")).filter((c) => c.id.startsWith("plan-"))
    .map((c) => ({ hook: String((c.meta as { hook?: string }).hook ?? c.caption ?? "").toLowerCase().slice(0, 28), pillar: String((c.meta as { pillar?: string }).pillar ?? "") }))
    .filter((x) => x.hook.length >= 12 && x.pillar);
}
const matchPillar = (caption: string, plan: { hook: string; pillar: string }[]) => plan.find((p) => caption.toLowerCase().includes(p.hook))?.pillar ?? null;

/**
 * Pillar scoreboard: (saves + shares) per reach for posts in each pillar. Live Instagram posts when connected,
 * otherwise plan items already marked posted in the desk (their logged saves/shares/views).
 */
export function pillarScores(posts: IgPost[] | null, items: ContentItem[]) {
  const rows = PILLARS.map((p) => {
    const live = (posts ?? []).filter((x) => x.pillar === p.id && x.reach);
    const logged = items.filter((c) => (c.meta as { pillar?: string }).pillar === p.id && c.status === "posted" && c.views);
    const n = posts ? live.length : logged.length;
    const eng = posts ? live.reduce((a, x) => a + (x.saves ?? 0) + (x.shares ?? 0), 0) : logged.reduce((a, c) => a + (c.saves ?? 0) + (c.shares ?? 0), 0);
    const base = posts ? live.reduce((a, x) => a + (x.reach ?? 0), 0) : logged.reduce((a, c) => a + (c.views ?? 0), 0);
    const planned = items.filter((c) => (c.meta as { pillar?: string }).pillar === p.id).length;
    return { id: p.id, name: p.name, color: p.color, posts: n, planned, rate: base ? eng / base : null, reach: base };
  });
  return rows;
}

