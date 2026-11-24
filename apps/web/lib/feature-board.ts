import "server-only";
import { getRepo } from "@engine/db";
import { creativesOf, metaAds } from "./ad-campaigns";
import { FEATURES, featureOf } from "./features";
import { optimizeStatus } from "./optimize";

/**
 * Which feature brings people to the app. Every ad and trial reel rolls up by the feature it
 * sells (lib/features.ts), as a funnel: seen → stopped (3-s view) → watched half → clicked to the App Store →
 * installed → did something in the app (app events, once the app's SDK sends them to Meta). Instagram reels add
 * reach, watch and saves + shares. One account-level Meta call per 10 minutes covers every ad.
 */

export interface FeatureVideo { key: string; label: string; kind: "ad" | "trial" | "post"; campaign: string | null; feature: string; manual: boolean;
  status: string; impressions: number; clicks: number; spend: number; installs: number; hook: number | null; reach: number | null; act: number | null; watch: number | null }
export interface FeatureRow {
  id: string; name: string; color: string; ads: number; trials: number;
  spend: number; impressions: number; views3s: number; p50: number; clicks: number; installs: number; events: Record<string, number>;
  reach: number; saves_shares: number; watch_s: number; watch_n: number; watch_len: number;
}
export interface FeatureBoard { currency: string; rows: FeatureRow[]; videos: FeatureVideo[]; campaigns: { id: string; title: string }[]; eventNames: string[]; live: boolean; error?: string }

type Act = { action_type: string; value: string };
type AdRow = { ad_id: string; spend: string; impressions: string; inline_link_clicks?: string; actions?: Act[]; video_p50_watched_actions?: Act[] };
const cache = ((globalThis as { __featureAds?: { at: number; v: { currency: string; rows: AdRow[] } | null } }).__featureAds ??= { at: 0, v: null });

async function adInsights() {
  const m = metaAds();
  if (!m) return null;
  if (cache.v && Date.now() - cache.at < 10 * 60_000) return cache.v;
  const [acct, r] = await Promise.all([m.account(), m.get<{ data: AdRow[] }>("act/insights", {
    level: "ad", date_preset: "maximum", limit: 500, fields: "ad_id,spend,impressions,inline_link_clicks,actions,video_p50_watched_actions" })]);
  cache.v = { currency: acct.currency, rows: r.data };
  cache.at = Date.now();
  return cache.v;
}

const EVENT = /^(app_custom_event\.|mobile_app_|omni_activate|omni_complete_registration|omni_purchase)/;

/** Two insight rows of one video (its test ad and its winners ad) as one. */
function merge(a?: AdRow, b?: AdRow): AdRow | undefined {
  if (!a || !b) return a ?? b;
  const n = (x?: string) => Number(x ?? 0);
  const acts = new Map<string, number>();
  for (const x of [...(a.actions ?? []), ...(b.actions ?? [])]) acts.set(x.action_type, (acts.get(x.action_type) ?? 0) + Number(x.value));
  return { ad_id: a.ad_id, spend: String(n(a.spend) + n(b.spend)), impressions: String(n(a.impressions) + n(b.impressions)),
    inline_link_clicks: String(n(a.inline_link_clicks) + n(b.inline_link_clicks)), actions: [...acts].map(([action_type, v]) => ({ action_type, value: String(v) })),
    video_p50_watched_actions: [{ action_type: "video_view", value: String(n(a.video_p50_watched_actions?.[0]?.value) + n(b.video_p50_watched_actions?.[0]?.value)) }] };
}

export async function featureBoard(campaignId?: string | null): Promise<FeatureBoard> {
  const repo = getRepo();
  const [camps, variants, posts] = await Promise.all([repo.list("ad_campaigns"), repo.list("reel_variants"), repo.list("reel_posts")]);
  let ins: Awaited<ReturnType<typeof adInsights>> = null, error: string | undefined;
  try { ins = await adInsights(); } catch (e) { error = (e as Error).message; }
  const byAd = new Map((ins?.rows ?? []).map((r) => [r.ad_id, r]));
  const blank = (f: { id: string; name: string; color: string }): FeatureRow => ({ ...f, ads: 0, trials: 0, spend: 0, impressions: 0, views3s: 0, p50: 0, clicks: 0, installs: 0,
    events: {}, reach: 0, saves_shares: 0, watch_s: 0, watch_n: 0, watch_len: 0 });
  const rows = new Map<string, FeatureRow>([...FEATURES.map((f) => [f.id, blank(f)] as const), ["other", blank({ id: "other", name: "Unsorted", color: "#64748b" })]]);
  const videos: FeatureVideo[] = [];
  const opt = optimizeStatus().items;
  const optStatus = (k: string) => opt.find((x) => x.key === k || x.key === k.replace("|", "/"))?.status;
  const events = new Set<string>();

  for (const c of camps.filter((x) => x.meta.campaign_id && (!campaignId || x.id === campaignId))) {
    for (const x of creativesOf(c)) {
      const ids = c.meta.ads?.[x.key];
      if (!ids?.ad_id) continue;
      const v = x.job_id ? variants.find((y) => y.job_id === x.job_id && y.id === x.variant_id) : undefined;
      const f = ids.feature && !v?.tags?.feature ? ids.feature : v ? featureOf(v) : featureOf({ hook: x.label ?? "" });
      const row = rows.get(f) ?? rows.get("other")!;
      // a proven ad that moved to the launch's Winners campaign keeps counting there (same video, same feature)
      const won = c.meta.waves?.winners?.[x.key];
      const r = merge(byAd.get(ids.ad_id), won ? byAd.get(won.ad_id) : undefined);
      const act = (t: string) => Number(r?.actions?.find((a) => a.action_type === t)?.value ?? 0);
      const imp = Number(r?.impressions ?? 0), clicks = Number(r?.inline_link_clicks ?? 0), spend = Number(r?.spend ?? 0);
      const installs = act("mobile_app_install") || act("omni_app_install"), v3 = act("video_view");
      row.ads++; row.spend += spend; row.impressions += imp; row.clicks += clicks; row.installs += installs; row.views3s += v3;
      row.p50 += Number(r?.video_p50_watched_actions?.[0]?.value ?? 0);
      for (const a of r?.actions ?? []) if (EVENT.test(a.action_type)) { row.events[a.action_type] = (row.events[a.action_type] ?? 0) + Number(a.value); events.add(a.action_type); }
      videos.push({ key: x.key, label: x.label ?? x.key, kind: "ad", campaign: c.title, feature: f, manual: !!v?.tags?.feature,
        status: won ? (won.dropped_at ? "winner, worn out" : "winner") : ids.bench && !ids.paused_at ? "waiting" : ids.killed ? "killed" : ids.paused_at ? "paused" : optStatus(x.key) ?? c.status, impressions: imp, clicks, spend, installs,
        hook: imp ? v3 / imp : null, reach: null, act: null, watch: null });
    }
  }
  if (!campaignId) {
    for (const v of variants.filter((x) => ["trial", "post"].includes(x.tags?.launched ?? "") && x.tags?.ig_media_id)) {
      const f = featureOf(v);
      const row = rows.get(f) ?? rows.get("other")!;
      const p = posts.find((y) => y.job_id === v.job_id && y.variant_id === v.id);
      const last = opt.find((x) => x.key === `${v.job_id}/${v.id}`)?.last;
      const reach = last?.reach ?? (v.tags.ap_reach ? Number(v.tags.ap_reach) : p?.views ?? 0);
      const ss = (p?.saves ?? 0) + (p?.shares ?? 0);
      row.trials++; row.reach += reach; row.saves_shares += ss;
      if (p?.avg_watch_s != null && v.duration) { row.watch_s += p.avg_watch_s; row.watch_len += v.duration; row.watch_n++; }
      videos.push({ key: `${v.job_id}/${v.id}`, label: (v.hook || v.id).slice(0, 140), kind: v.tags.launched as "trial" | "post", campaign: null, feature: f, manual: !!v.tags.feature,
        status: v.tags.opt_killed ? "killed" : optStatus(`${v.job_id}/${v.id}`) ?? "live", impressions: 0, clicks: 0, spend: 0, installs: 0, hook: null,
        reach, act: reach ? ss / reach : null, watch: p?.avg_watch_s != null && v.duration ? p.avg_watch_s / v.duration : null });
    }
  }
  return {
    currency: ins?.currency ?? "USD", live: !!ins, error,
    rows: [...rows.values()].filter((r) => r.ads || r.trials || r.id !== "other"),
    videos: videos.sort((a, b) => b.impressions + (b.reach ?? 0) - (a.impressions + (a.reach ?? 0))),
    campaigns: camps.filter((c) => c.meta.campaign_id).map((c) => ({ id: c.id, title: c.title })),
    eventNames: [...events].sort(),
  };
}
