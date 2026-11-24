import "server-only";
import { getRepo, type AdCampaign, type Approval } from "@engine/db";
import { buildCampaign, creativesOf, getCampaign, metaAds } from "./ad-campaigns";
import { streamFolders, streamOf } from "./streams";

/**
 * Keep what works, replace what doesn't.
 *
 * A campaign runs its ads in one ad set. Once each ad has had a fair look, rotation ranks them:
 *  - hook rate (3-second views per impression): did the opening stop the scroll;
 *  - cost per link click: did it make people want the app.
 * The bottom ads are paused and the same number of challengers from the Ads column (finished, not launched, not in a
 * campaign; remixes of winners first) take their place in the same ad set, same budget. One approval per swap.
 * An ad Meta barely delivers after 3 days counts as a loser too: Meta is predicting it won't do well.
 */

export const ADS_PER_CAMPAIGN = () => { const n = Number(process.env.DESK_ADS_PER_CAMPAIGN); return Number.isFinite(n) && n >= 2 ? Math.min(10, Math.round(n)) : 6; };
const FAIR_IMPRESSIONS = 1000; // about what an ad needs before its hook rate means much
const STARVED_IMPRESSIONS = 300;
const now = () => new Date().toISOString();
const days = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 86400_000 : 0);

export interface AdRow { key: string; label: string; ad_id: string; impressions: number; spend: number; clicks: number; hook: number; cpc: number | null }

export async function adRows(c: AdCampaign): Promise<AdRow[]> {
  const m = metaAds();
  if (!m) return [];
  const out: AdRow[] = [];
  for (const x of creativesOf(c)) {
    const ids = c.meta.ads?.[x.key];
    if (!ids?.ad_id || ids.paused_at || ids.bench) continue; // waiting on the bench (lib/waves.ts) isn't losing
    const r = await m.campaignResults(ids.ad_id).catch(() => null); // any Graph object's /insights: an ad works the same
    if (!r) continue;
    out.push({ key: x.key, label: x.label ?? x.key, ad_id: ids.ad_id, impressions: r.impressions, spend: r.spend, clicks: r.clicks,
      hook: r.videoViews / Math.max(1, r.impressions), cpc: r.clicks ? r.spend / r.clicks : null });
  }
  return out;
}

/** Ads-column videos that could go in: finished, not launched, not in any campaign already. Remixes of winners first. */
async function challengers(n: number): Promise<{ key: string; job_id: string; variant_id: string; file: string; poster: string | null; label: string }[]> {
  const repo = getRepo();
  const [vs, camps, jobs] = await Promise.all([repo.list("reel_variants"), repo.list("ad_campaigns"), repo.list("reel_jobs", { eq: { status: "done" } })]);
  const used = new Set(camps.flatMap((c) => creativesOf(c).map((x) => x.key)));
  const done = new Map(jobs.map((j) => [j.job_id, j.created_at]));
  const folders = streamFolders();
  return vs.filter((v) => v.file && done.has(v.job_id) && streamOf(v, folders) === "ad" && !(v.tags?.launched && v.tags.launch_status !== "failed") && !used.has(`${v.job_id}|${v.id}`))
    .sort((a, b) => Number(!!b.tags?.partner_of) - Number(!!a.tags?.partner_of) || done.get(b.job_id)!.localeCompare(done.get(a.job_id)!))
    .slice(0, n).map((v) => ({ key: `${v.job_id}|${v.id}`, job_id: v.job_id, variant_id: v.id, file: v.file!, poster: v.poster, label: (v.hook || v.id).slice(0, 140) }));
}

/** Propose a swap for one live campaign, if its ads have had a fair look and some are clearly behind. */
export async function proposeRotation(id: string, by: string): Promise<Approval | null> {
  const c = await getCampaign(id);
  if (!["live", "ready"].includes(c.status) || !c.meta.adset_id) return null;
  const waiting = (await getRepo().list("approvals", { eq: { ref_id: c.id, status: "pending" } })).length;
  if (waiting) return null;
  const rows = await adRows(c);
  if (rows.length < 2) return null;
  const age = days(c.meta.built_at);
  const judged = rows.filter((r) => r.impressions >= FAIR_IMPRESSIONS);
  if (judged.length < 2 && age < 3) return null;
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const hookMed = med(judged.map((r) => r.hook));
  const cpcs = judged.map((r) => r.cpc).filter((x): x is number => x != null);
  const cpcMed = cpcs.length ? med(cpcs) : null;
  const losers = rows.filter((r) =>
    (age >= 3 && r.impressions < STARVED_IMPRESSIONS)
    || (r.impressions >= FAIR_IMPRESSIONS && (r.hook < hookMed * 0.7 || (cpcMed != null && (r.cpc == null ? r.spend > cpcMed * 2 : r.cpc > cpcMed * 1.5)))));
  // never empty the ad set: the best ad always stays
  const best = [...judged].sort((a, b) => (a.cpc ?? Infinity) - (b.cpc ?? Infinity) || b.hook - a.hook)[0];
  const out = losers.filter((r) => r.key !== best?.key).slice(0, Math.max(1, Math.floor(rows.length / 2)));
  if (!out.length) return null;
  const ins = await challengers(out.length);
  const line = (r: AdRow) => `${r.label.slice(0, 60)}: hook ${(r.hook * 100).toFixed(0)}%, ${r.cpc != null ? `${r.cpc.toFixed(2)}/click` : "no clicks"}, ${r.impressions} impressions`;
  const [a] = await getRepo().insert("approvals", [{
    id: crypto.randomUUID(), type: "optimize", ref_table: "ad_campaigns", ref_id: c.id,
    title: ins.length ? `"${c.title}": swap ${out.length} weak ad${out.length > 1 ? "s" : ""} for ${ins.length} new one${ins.length > 1 ? "s" : ""}` : `"${c.title}": pause ${out.length} weak ad${out.length > 1 ? "s" : ""}`,
    summary: `Same ad set, same budget: the spend moves to the ads that work.${ins.length < out.length ? " The Ads column has no more unused videos; make more to keep rotating." : ""}`,
    preview: { bullets: [...out.map((r) => `Out: ${line(r)}`), ...ins.map((x) => `In: ${x.label.slice(0, 80)}`), `Kept: ${rows.filter((r) => !out.includes(r)).map(line).join("; ")}`],
      action: { kind: "rotate_ads", ad_campaign_id: c.id, pause: out.map((r) => r.key), add: ins } },
    status: "pending", created_by_agent: by, decided_by: null, decided_at: null, result: null, created_at: now(),
  }]);
  return a;
}

/** After approval: pause the losers in Meta and build the challengers into the same ad set. */
export async function runRotation(o: { ad_campaign_id: string; pause: string[]; add: { key: string; job_id: string; variant_id: string; file: string; poster: string | null; label: string }[] }) {
  const m = metaAds();
  if (!m) throw new Error("Meta isn't connected");
  let c = await getCampaign(o.ad_campaign_id);
  const ads = { ...(c.meta.ads ?? {}) };
  for (const k of o.pause) {
    const ids = ads[k];
    if (ids?.ad_id) { await m.setCampaignStatus(ids.ad_id, "PAUSED"); ads[k] = { ...ids, paused_at: now() }; }
  }
  await getRepo().update("ad_campaigns", { id: c.id }, { meta: { ...c.meta, ads }, creatives: [...(c.creatives ?? []), ...o.add], updated_at: now() });
  if (o.add.length) c = await buildCampaign(c.id); // builds only the ads without ids yet; the others are untouched
  if (c.status === "failed") throw new Error(c.meta.error ?? "building the new ads failed");
  return { paused: o.pause.length, added: o.add.length };
}
