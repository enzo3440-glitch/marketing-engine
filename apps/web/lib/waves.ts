import { tzSuffix } from "./tz";
import "server-only";
import { getRepo, type AdCampaign, type AdWaves } from "@engine/db";
import { adFeatures, adsetPlan, creativesOf, metaAds, minPerAdset, toMinor } from "./ad-campaigns";
import { featureName } from "./features";
import { hstToday } from "./utils";
import { BRAND } from "./brand";

/**
 * Waves.
 *
 * One launch (the desk's ad campaign, one approval) runs as two Meta campaigns:
 *
 *  1. Feature test: one ad set per feature, an even share of the budget each, so every feature gets a fair read.
 *     Only LIVE_PER_SET ads run in an ad set at a time (at ~$10/day an ad set can't give more than ~3 ads a fair look);
 *     the rest are built paused, already reviewed by Meta, and wait their turn. When the optimizer kills an ad, the
 *     next one for that feature switches on in the same pass. A feature whose ads have all run out is retired and its
 *     share goes to the rest.
 *  2. Winners: an ad that has proven itself in the test (WIN_IMPRESSIONS+ impressions over WIN_HOURS+, clicks well
 *     above the test's median, an opening that holds) moves here, same creative (likes and comments carry over), and its
 *     test slot goes to the next ad on the bench. This campaign holds its own budget, so Meta spreads it across the
 *     winners itself; it opens with two winners and gets 50-70% of the daily budget as more prove themselves.
 *     A winner that wears out (click-through down 40% in the last 3 days) is dropped.
 *
 * The total daily budget never goes above what the launch approval said; this only moves it between the two.
 * Waves run with live optimize on (lib/optimize.ts calls wavesPass after reading the ads). Off, the launch holds as built.
 */

export const LIVE_PER_SET = () => { const n = Number(process.env.DESK_LIVE_PER_ADSET); return process.env.DESK_LIVE_PER_ADSET && Number.isFinite(n) && n >= 1 ? Math.round(n) : 3; };
const WIN_IMPRESSIONS = 2000, WIN_HOURS = 48, WIN_CLICKS = 8, MAX_WINNERS = 6, FAIR = 1000, FATIGUE = 3000;
const now = () => new Date().toISOString();
const hoursSince = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : 0);
const cents = (x: number) => Math.floor(x * 100) / 100;
const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** How a launch's daily budget splits between the winners campaign and the feature ad sets still running. */
export function budgetSplit(total: number, winners: number, sets: number): { winners: number; per_set: number } {
  const min = minPerAdset();
  if (!sets) return { winners: winners ? total : 0, per_set: 0 };
  if (!winners) return { winners: 0, per_set: cents(total / sets) };
  const share = winners >= 5 ? 0.7 : winners >= 3 ? 0.6 : 0.5;
  let w = total * share, per = (total - w) / sets;
  if (per < min) { per = min; w = total - per * sets; }
  if (w < min) return { winners: 0, per_set: cents(total / sets) }; // too small to run both: the test keeps it all
  return { winners: cents(w), per_set: cents(per) };
}

/** Which ads run first in each feature ad set and which wait: picked order, one per video before a second cut of it. */
export function waveOrder(keys: string[], live: number): { live: string[]; bench: string[] } {
  const seen = new Set<string>(), first: string[] = [], rest: string[] = [];
  for (const k of keys) { const job = k.split("|")[0]; (seen.has(job) ? rest : first).push(k); seen.add(job); }
  const order = [...first, ...rest];
  return { live: order.slice(0, live), bench: order.slice(live) };
}

export interface LaunchSet { feature: string; name: string; daily: number; live: string[]; bench: string[]; out: string[]; won: string[]; retired?: boolean }
export interface LaunchStructure {
  mode: "waves" | "single";
  total: number; live_per_set: number;
  sets: LaunchSet[];
  winners: { key: string; label: string; ctr: number; hook: number; at: string; dropped?: boolean }[];
  winners_daily: number; winners_open: boolean;
  labels: Record<string, string>;
  rule: string; log: { at: string; text: string }[];
  // what each sub-campaign is teaching us, once it's live (withReads)
  currency?: string; reads?: Record<string, AdNumbers>; set_reads?: Record<string, SetRead>; winners_read?: SetRead; insights?: string[];
}
export interface AdNumbers { impressions: number; clicks: number; spend: number; installs: number; hook: number | null; ctr: number | null; status: string; next?: string }
export interface SetRead { impressions: number; clicks: number; spend: number; installs: number; hook: number | null; ctr: number | null; cpi: number | null;
  verdict: "leading" | "behind" | "even" | "early"; why: string }

const sumUp = (xs: AdNumbers[], v3: number) => {
  const t = xs.reduce((a, x) => ({ impressions: a.impressions + x.impressions, clicks: a.clicks + x.clicks, spend: a.spend + x.spend, installs: a.installs + x.installs }),
    { impressions: 0, clicks: 0, spend: 0, installs: 0 });
  return { ...t, hook: t.impressions ? v3 / t.impressions : null, ctr: t.impressions ? t.clicks / t.impressions : null, cpi: t.installs ? t.spend / t.installs : null };
};

/**
 * A live launch's numbers by sub-campaign: every ad's read, each feature ad set's totals against the others, and the plain-English
 * takeaways. Installs decide once the launch has INSTALLS_TO_JUDGE of them; before that, clicks to the App Store do.
 */
export async function withReads(c: AdCampaign, st: LaunchStructure): Promise<LaunchStructure> {
  if (!c.meta.campaign_id) return st;
  const [{ featureBoard }, { optimizeStatus }] = await Promise.all([import("./feature-board"), import("./optimize")]);
  const b = await featureBoard(c.id);
  const opt = optimizeStatus().items;
  const reads: Record<string, AdNumbers> = {}, v3: Record<string, number> = {};
  for (const v of b.videos.filter((x) => x.kind === "ad")) {
    const it = opt.find((x) => x.key === v.key || x.key === v.key.replace("|", "/"));
    reads[v.key] = { impressions: v.impressions, clicks: v.clicks, spend: v.spend, installs: v.installs, hook: v.hook, ctr: v.impressions ? v.clicks / v.impressions : null,
      status: v.status, next: it?.next ?? it?.why };
    v3[v.key] = (v.hook ?? 0) * v.impressions;
  }
  const INSTALLS_TO_JUDGE = 10;
  const totalInstalls = Object.values(reads).reduce((n, x) => n + x.installs, 0);
  const byInstalls = totalInstalls >= INSTALLS_TO_JUDGE;
  const pctf = (x: number | null, d = 1) => (x == null ? "—" : pct(x, d));
  const money = (x: number) => `${x.toFixed(2)} ${b.currency}`;
  const set_reads: Record<string, SetRead> = {};
  for (const g of st.sets) {
    const keys = [...g.live, ...g.out, ...g.won].filter((k) => reads[k]);
    const t = sumUp(keys.map((k) => reads[k]), keys.reduce((n, k) => n + v3[k], 0));
    set_reads[g.feature] = { ...t, verdict: "early", why: `${t.impressions.toLocaleString()} of ${FAIR.toLocaleString()} impressions before it's compared.` };
  }
  const read = st.sets.filter((g) => set_reads[g.feature].impressions >= FAIR);
  const score = (r: SetRead) => (byInstalls ? (r.impressions ? r.installs / r.impressions : 0) : r.ctr ?? 0);
  const mid = median(read.map((g) => score(set_reads[g.feature]))), midHook = median(read.map((g) => set_reads[g.feature].hook ?? 0));
  const metric = byInstalls ? "installs per 1,000 seen" : "click-through to the App Store";
  const show = (r: SetRead) => (byInstalls ? `${((r.installs / Math.max(1, r.impressions)) * 1000).toFixed(2)} per 1k${r.cpi != null ? `, ${money(r.cpi)} each` : ""}` : pctf(r.ctr, 2));
  if (read.length >= 2 && mid) {
    for (const g of read) {
      const r = set_reads[g.feature], x = score(r) / mid;
      const hold = midHook && r.hook != null ? r.hook / midHook : 1;
      r.verdict = x >= 1.25 ? "leading" : x < 0.75 ? "behind" : "even";
      r.why = `${metric}: ${show(r)} vs ${byInstalls ? `${(mid * 1000).toFixed(2)} per 1k` : pctf(mid, 2)} median; opening ${pctf(r.hook, 0)}${hold < 0.8 ? " (weaker than the rest)" : hold > 1.2 ? " (stronger than the rest)" : ""}.`;
    }
  } else if (read.length === 1) set_reads[read[0].feature].why = `Read (${show(set_reads[read[0].feature])}); waiting on the other features to compare.`;
  const wkeys = st.winners.filter((w) => !w.dropped).map((w) => w.key).filter((k) => reads[k]);
  const winners_read = wkeys.length ? { ...sumUp(wkeys.map((k) => reads[k]), wkeys.reduce((n, k) => n + v3[k], 0)), verdict: "even" as const, why: "" } : undefined;

  // the takeaways
  const insights: string[] = [];
  const named = (f: string) => st.sets.find((g) => g.feature === f)?.name ?? featureName(f);
  const lead = read.filter((g) => set_reads[g.feature].verdict === "leading"), behind = read.filter((g) => set_reads[g.feature].verdict === "behind");
  if (read.length < 2) insights.push(`Too early to compare features: ${read.length} of ${st.sets.filter((g) => !g.retired).length} have ${FAIR.toLocaleString()}+ impressions. Judged on ${metric}.`);
  for (const g of lead) insights.push(`Working: ${g.name}. ${set_reads[g.feature].why}`);
  for (const g of behind) insights.push(`Not working yet: ${g.name}. ${set_reads[g.feature].why}`);
  if (read.length >= 2 && !lead.length && !behind.length) insights.push(`No feature stands out yet on ${metric}; all within 25% of the median.`);
  const ads = Object.entries(reads).filter(([, r]) => r.impressions >= FAIR);
  if (ads.length >= 3) {
    const hk = median(ads.map(([, r]) => r.hook ?? 0)) ?? 0, ck = median(ads.map(([, r]) => r.ctr ?? 0)) ?? 0;
    const best = [...ads].sort((a, b) => (b[1].ctr ?? 0) - (a[1].ctr ?? 0))[0];
    insights.push(`Best ad so far: "${st.labels[best[0]] ?? best[0]}" (${pctf(best[1].ctr, 2)} click-through, opening ${pctf(best[1].hook, 0)}).`);
    const sticky = ads.filter(([, r]) => (r.hook ?? 0) < hk * 0.8 && (r.ctr ?? 0) >= ck * 1.1);
    if (sticky.length) insights.push(`Good payoff, weak opening (worth a new first shot, not a kill): ${sticky.slice(0, 3).map(([k]) => `"${(st.labels[k] ?? k).slice(0, 50)}"`).join(", ")}.`);
    const lure = ads.filter(([, r]) => (r.hook ?? 0) >= hk * 1.2 && (r.ctr ?? 0) < ck * 0.7);
    if (lure.length) insights.push(`Stops people but doesn't send them to the App Store (the payoff gets the re-cut): ${lure.slice(0, 3).map(([k]) => `"${(st.labels[k] ?? k).slice(0, 50)}"`).join(", ")}.`);
  }
  if (winners_read && winners_read.impressions >= FAIR) insights.push(`Winners campaign: ${pctf(winners_read.ctr, 2)} click-through over ${winners_read.impressions.toLocaleString()} impressions, ${winners_read.installs} installs, ${money(winners_read.spend)} spent.`);
  return { ...st, currency: b.currency, reads, set_reads, winners_read, insights };
}

const RULE = `${LIVE_PER_SET()} ads live per feature at a time; the rest wait and switch on as ads are killed. An ad moves to Winners after `
  + `${WIN_IMPRESSIONS.toLocaleString()}+ impressions over ${WIN_HOURS} h with clicks 25%+ above the test's median; Winners opens with two and gets 50-70% of the budget.`;

/** What a launch is (planned: what it will be), for Launch and the approval. Null when it runs as one ad set. */
export async function launchStructure(c: AdCampaign): Promise<LaunchStructure | null> {
  const ads = creativesOf(c);
  const labels = Object.fromEntries(ads.map((x) => [x.key, (x.label ?? x.key).split("\n")[0].slice(0, 90)]));
  const w = c.meta.waves;
  if (c.meta.campaign_id) {
    if (!c.meta.adsets) return null;
    const winners = Object.entries(w?.winners ?? {}).map(([key, x]) => ({ key, label: labels[key] ?? key, ctr: x.ctr, hook: x.hook, at: x.at, dropped: !!x.dropped_at }));
    const sets = Object.keys(c.meta.adsets).map((g): LaunchSet => {
      const mine = ads.filter((x) => c.meta.ads?.[x.key]?.feature === g);
      const ids = (k: string) => c.meta.ads?.[k] ?? {};
      return {
        feature: g, name: featureName(g), daily: w?.retired?.[g] ? 0 : w?.split?.per_set ?? cents(c.daily_budget / Object.keys(c.meta.adsets!).length),
        live: mine.filter((x) => ids(x.key).ad_id && !ids(x.key).paused_at && !ids(x.key).bench).map((x) => x.key),
        bench: mine.filter((x) => ids(x.key).bench && !ids(x.key).paused_at).map((x) => x.key),
        won: mine.filter((x) => ids(x.key).graduated_at).map((x) => x.key),
        out: mine.filter((x) => ids(x.key).paused_at && !ids(x.key).graduated_at).map((x) => x.key),
        retired: !!w?.retired?.[g],
      };
    });
    return { mode: "waves", total: c.daily_budget, live_per_set: w?.live_per_set ?? ads.length, sets, winners, winners_daily: w?.split?.winners ?? 0,
      winners_open: !!w?.winners_campaign_id && (w?.split?.winners ?? 0) > 0, labels, rule: w ? RULE : "Built before waves: every ad runs at once.", log: (w?.log ?? []).slice(0, 20) };
  }
  const feats = await adFeatures(c);
  const plan = adsetPlan(c, feats);
  if (!plan) return null;
  const sets = plan.groups.map((g): LaunchSet => {
    const o = waveOrder(ads.filter((x) => feats[x.key] === g).map((x) => x.key), LIVE_PER_SET());
    return { feature: g, name: featureName(g), daily: plan.daily, live: o.live, bench: o.bench, out: [], won: [] };
  });
  return { mode: "waves", total: c.daily_budget, live_per_set: LIVE_PER_SET(), sets, winners: [], winners_daily: 0, winners_open: false, labels, rule: RULE, log: [] };
}

export interface AdRead { impressions: number; clicks: number; hook: number; ctr: number; spend: number }

/**
 * One waves pass for a live launch, right after the optimizer read and judged its ads (`reads`: lifetime numbers of the
 * test ads that are running). Graduates proven ads, drops worn-out winners, switches on the next ads where a slot is free,
 * retires features that ran out, and re-splits the budget when any of that changed it.
 */
export async function wavesPass(id: string, reads: Map<string, AdRead>, note: (title: string, text: string) => Promise<void>): Promise<void> {
  const m = metaAds();
  const repo = getRepo();
  let c = (await repo.list("ad_campaigns", { eq: { id } }))[0];
  if (!m || !c?.meta.waves || !c.meta.adsets || !["live", "ready"].includes(c.status)) return;
  const live = c.status === "live";
  const save = async (fn: (x: AdCampaign) => void) => {
    const fresh = (await repo.list("ad_campaigns", { eq: { id } }))[0] ?? c;
    fn(fresh);
    await repo.update("ad_campaigns", { id }, { meta: fresh.meta, updated_at: now() });
    c = fresh;
  };
  const log = async (title: string, text: string) => {
    await save((x) => { const w = x.meta.waves!; w.log = [{ at: now(), text }, ...(w.log ?? [])].slice(0, 60); });
    await note(title, text);
  };
  const ids = (k: string) => c.meta.ads?.[k] ?? {};
  const running = (k: string) => !!ids(k).ad_id && !ids(k).paused_at && !ids(k).bench;
  const activeSets = () => Object.keys(c.meta.adsets!).filter((g) => !c.meta.waves!.retired?.[g]);
  const activeWinners = () => Object.values(c.meta.waves!.winners ?? {}).filter((x) => !x.dropped_at).length;
  let resplit = false;

  // 1. graduate: proven test ads move to the winners campaign (it opens with two)
  const rows = [...reads].filter(([k]) => running(k));
  const fair = rows.filter(([, r]) => r.impressions >= FAIR);
  const medCtr = fair.length >= 3 ? median(fair.map(([, r]) => r.ctr)) : null, medHook = fair.length >= 3 ? median(fair.map(([, r]) => r.hook)) : null;
  if (medCtr && medHook != null && activeWinners() < MAX_WINNERS) {
    const proven = rows.filter(([k, r]) => r.impressions >= WIN_IMPRESSIONS && r.clicks >= WIN_CLICKS && hoursSince(ids(k).live_at ?? c.meta.built_at) >= WIN_HOURS
      && r.ctr >= medCtr * 1.25 && r.hook >= medHook * 0.9).sort((a, b) => b[1].ctr - a[1].ctr).slice(0, MAX_WINNERS - activeWinners());
    const enough = activeWinners() ? proven.length >= 1 : proven.length >= 2;
    const split = budgetSplit(c.daily_budget, activeWinners() + proven.length, activeSets().length);
    if (enough && split.winners > 0) {
      const ios = /apps\.apple\.com/.test(c.link);
      const name = `${BRAND.name} · ${c.title} · ${c.starts_on} · Winners`;
      const cur = (await m.account()).currency;
      const minor = (x: number) => toMinor(x, cur);
      if (!c.meta.waves.winners_campaign_id) {
        const cid = await m.createCampaign(name, c.objective, { ios, dailyBudgetMinor: minor(split.winners) });
        await save((x) => { x.meta.waves!.winners_campaign_id = cid; });
      }
      if (!c.meta.waves.winners_adset_id) {
        const app = c.objective === "app_installs" || /apps\.apple\.com|play\.google\.com/.test(c.link) ? await m.appFor(c.link) : null;
        const sid = await m.createAdSet({ name, campaignId: c.meta.waves.winners_campaign_id!, goal: c.objective, startTime: new Date(Date.now() + 5 * 60_000).toISOString(),
          endTime: `${c.ends_on}T23:59:00${tzSuffix()}`, countries: c.countries, ageMin: c.age_min, ageMax: c.age_max, link: c.link, appId: app?.id });
        await save((x) => { x.meta.waves!.winners_adset_id = sid; });
      }
      for (const [k, r] of proven) {
        const creative = ids(k).creative_id;
        if (!creative || c.meta.waves.winners?.[k]) continue;
        const ad = await m.createAd(`${name} · ${(c.meta.ads?.[k]?.feature ?? "ad")}`, c.meta.waves.winners_adset_id!, creative, "ACTIVE");
        await m.setStatus(ids(k).ad_id!, "PAUSED");
        await save((x) => {
          x.meta.waves!.winners = { ...(x.meta.waves!.winners ?? {}), [k]: { ad_id: ad, at: now(), ctr: r.ctr, hook: r.hook } };
          x.meta.ads![k] = { ...x.meta.ads![k], paused_at: now(), graduated_at: now() };
        });
        await log(`Moved a proven ad to Winners in "${c.title}"`, `${featureName(ids(k).feature ?? "")}: "${(creativesOf(c).find((x) => x.key === k)?.label ?? k).slice(0, 60)}" moved to the winners campaign: `
          + `click-through ${pct(r.ctr, 2)} vs the test's ${pct(medCtr, 2)}, ${r.impressions.toLocaleString()} impressions. Its test slot goes to the next ad.`);
      }
      if (live) await m.setStatus(c.meta.waves.winners_campaign_id!, "ACTIVE");
      resplit = true;
    }
  }

  // 2. drop winners that wore out
  for (const [k, w] of Object.entries(c.meta.waves.winners ?? {}).filter(([, x]) => !x.dropped_at)) {
    const life = await m.adResults(w.ad_id).catch(() => null);
    if (!life || life.impressions < FATIGUE) continue;
    const recent = await m.adResults(w.ad_id, "last_3d").catch(() => null);
    if (!recent || recent.impressions < 800) continue;
    const ctr = recent.clicks / recent.impressions;
    if (ctr >= w.ctr * 0.6) continue;
    await m.setStatus(w.ad_id, "PAUSED");
    const why = `click-through fell to ${pct(ctr, 2)} in the last 3 days (it won at ${pct(w.ctr, 2)})`;
    await save((x) => { x.meta.waves!.winners![k] = { ...x.meta.waves!.winners![k], dropped_at: now(), why }; });
    await log(`Dropped a worn-out winner in "${c.title}"`, `"${(creativesOf(c).find((x) => x.key === k)?.label ?? k).slice(0, 60)}": ${why}. Paused.`);
    resplit = true;
  }

  // 3. next wave: fill free slots in each feature ad set from its bench; retire a feature that ran out
  const perSet = c.meta.waves.live_per_set;
  for (const g of activeSets()) {
    const mine = creativesOf(c).filter((x) => ids(x.key).feature === g);
    const on = mine.filter((x) => running(x.key));
    const bench = mine.filter((x) => ids(x.key).bench && ids(x.key).ad_id && !ids(x.key).paused_at);
    const take = bench.slice(0, Math.max(0, perSet - on.length));
    for (const x of take) {
      await m.setStatus(ids(x.key).ad_id!, "ACTIVE");
      await save((y) => { y.meta.ads![x.key] = { ...y.meta.ads![x.key], bench: false, live_at: now() }; });
    }
    if (take.length) await log(`Next wave in "${c.title}" · ${featureName(g)}`, `Switched on ${take.map((x) => `"${(x.label ?? x.key).slice(0, 50)}"`).join(", ")} in the ${featureName(g)} ad set (${bench.length - take.length} still waiting).`);
    if (!on.length && !take.length && !bench.length && activeSets().length > 1) {
      await m.setStatus(c.meta.adsets![g], "PAUSED");
      await save((y) => { y.meta.waves!.retired = { ...(y.meta.waves!.retired ?? {}), [g]: now() }; });
      await log(`Retired ${featureName(g)} in "${c.title}"`, `Every ${featureName(g)} ad has run (killed or moved to Winners), so its ad set is paused and its share of the budget goes to the rest.`);
      resplit = true;
    }
  }

  // 4. re-split the budget (total unchanged) when the shape changed
  if (resplit || !c.meta.waves.split) await applySplit(c, activeWinners(), activeSets(), log);
}

async function applySplit(c: AdCampaign, winners: number, sets: string[], log: (t: string, x: string) => Promise<void>) {
  const m = metaAds()!;
  const s = budgetSplit(c.daily_budget, winners, sets.length);
  const was = c.meta.waves!.split;
  if (was && Math.abs(was.winners - s.winners) < 0.5 && Math.abs(was.per_set - s.per_set) < 0.25) return;
  const cur = (await m.account()).currency;
  const minor = (x: number) => toMinor(x, cur);
  for (const g of sets) await m.updateAdSet(c.meta.adsets![g], { dailyBudgetMinor: minor(s.per_set) });
  const wc = c.meta.waves!.winners_campaign_id;
  if (wc && s.winners > 0) await m.updateCampaignBudget(wc, minor(s.winners));
  if (wc && s.winners === 0) await m.setStatus(wc, "PAUSED");
  c.meta.waves!.split = { ...s, at: now() };
  await getRepo().update("ad_campaigns", { id: c.id }, { meta: c.meta, updated_at: now() });
  if (was) await log(`Re-split the budget in "${c.title}"`, `${c.daily_budget}/day in all: Winners ${s.winners}/day, ${sets.length} feature ad set${sets.length > 1 ? "s" : ""} at ${s.per_set}/day each.`);
}

/** A new approved daily total (Live's "put more money on it"): re-split it between Winners and the feature ad sets. */
export async function rebudget(c: AdCampaign): Promise<void> {
  const w = c.meta.waves;
  if (!w || !c.meta.adsets) return;
  const winners = Object.values(w.winners ?? {}).filter((x) => !x.dropped_at).length;
  const sets = Object.keys(c.meta.adsets).filter((g) => !w.retired?.[g]);
  w.split = undefined; // force the re-split
  await applySplit(c, winners, sets, async () => {});
}

/** The winners campaign follows the launch: off with it (pause, end) and on with it (resume inside its dates). */
export async function followLaunch(c: AdCampaign, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const w = c.meta.waves;
  const m = metaAds();
  if (!m || !w?.winners_campaign_id) return;
  if (status === "ACTIVE" && (!(w.split?.winners) || c.ends_on < hstToday())) return;
  await m.setStatus(w.winners_campaign_id, status).catch(() => null);
}

export type { AdWaves };
