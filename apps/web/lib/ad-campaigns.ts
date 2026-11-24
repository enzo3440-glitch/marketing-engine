import "server-only";
import { MetaAds, type MetaAccount } from "@engine/connectors";
import { getRepo, type AdCampaign, type AdCreativePick, type AdMetaIds, type AdObjective, type AdTrialPick, type Approval } from "@engine/db";
import { creativesOf } from "./ad-creatives";
import { featureOf, featureName } from "./features";
import { tickCampaign } from "./ad-tick";
import { engine } from "./reels";
import { hstToday } from "./utils";
import { followLaunch, launchStructure, LIVE_PER_SET, waveOrder } from "./waves";
import { BRAND } from "./brand";

/**
 * Ad campaign calendar. A Marketing Map ad concept becomes a planned campaign (dates, budget, copy, a reel from the
 * gallery). "Send for approval" puts it in the approvals queue; approving it builds the whole thing in Meta PAUSED
 * (video, thumbnail, campaign, ad set, creative, ad), and the tick below switches the campaign on on its start date
 * and marks it ended after its end date. Nothing reaches Meta without an approved approval.
 *
 * A campaign holds one or more creatives (desk videos and/or existing Instagram posts): one campaign, one ad set, and
 * one creative + ad per item. Older rows have a single `creative`; creativesOf() reads both shapes.
 */

export const CTAS = ["DOWNLOAD", "INSTALL_MOBILE_APP", "LEARN_MORE", "SIGN_UP", "USE_APP"] as const;
export const OBJECTIVES: AdObjective[] = ["traffic", "app_installs", "awareness"];
export const maxDailyBudget = () => Number(process.env.META_MAX_DAILY_BUDGET) || 100;
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD", "VND"]);

export const metaAds = () => MetaAds.fromEnv(process.env);
/** Meta allows 50 ads per ad set. Past SPLIT_AT ads a campaign gets one ad set per feature (each an even share of the
 * budget), so Meta can't spend it all on two early favourites and every feature gets a fair read. */
export const MAX_ADS = 30;
const SPLIT_AT = 4;
/** An ad set below this much a day barely delivers, so a small budget keeps one ad set instead of splitting. */
export const minPerAdset = () => Number(process.env.META_MIN_ADSET_BUDGET) || 5;
/** Whole units (dollars) to the minor units Meta takes (cents; yen stay as they are). */
export const toMinor = (x: number, currency: string) => Math.round(x * (ZERO_DECIMAL.has(currency) ? 1 : 100));

/** The feature each ad sells (desk videos by their tags and hook, Instagram posts by their caption). */
export async function adFeatures(c: Pick<AdCampaign, "creative" | "creatives">): Promise<Record<string, string>> {
  const vs = await getRepo().list("reel_variants");
  const out: Record<string, string> = {};
  for (const x of creativesOf(c)) {
    const v = x.job_id ? vs.find((y) => y.job_id === x.job_id && y.id === x.variant_id) : undefined;
    out[x.key] = v ? featureOf(v) : featureOf({ hook: x.label ?? "" });
  }
  return out;
}

/** How the daily budget splits: one ad set per feature when there are enough ads and budget, else one ad set. */
export function adsetPlan(c: Pick<AdCampaign, "daily_budget">, features: Record<string, string>): { groups: string[]; daily: number } | null {
  const groups = [...new Set(Object.values(features))];
  if (Object.keys(features).length < SPLIT_AT || groups.length < 2) return null;
  const per = c.daily_budget / groups.length;
  if (per < minPerAdset()) return null;
  return { groups, daily: Math.floor(per * 100) / 100 };
}
export { creativesOf };

/** An ad is an app-install ad when the link is a store listing: Meta optimises for installs and the button opens the
 * store listing. Only a link that isn't a store listing falls back to traffic. */
// a store link runs as clicks to the app unless SKAdNetwork is set up (META_SKAN=on): an install campaign without it
// only reaches iOS 14.4 and older
export const defaultObjective = (): AdObjective => /apps\.apple\.com|play\.google\.com/.test(process.env.META_DEFAULT_LINK || "")
  && (process.env.META_SKAN ?? "").toLowerCase() === "on" ? "app_installs" : "traffic";

export const APP_MISSING = `${BRAND.name}'s app isn't set up for ads in Meta yet, so this can't run as an app-install ad. In Meta for Developers, `
  + "add the iOS platform with the app's App Store ID to the app, then in Business settings → Apps connect it to the ad account (and set META_APP_ID to "
  + "that app's id). Nothing was sent to Meta.";

const isLegacy = (c: AdCampaign) => !c.creatives?.length && !!c.creative;

export type MetaLink =
  | { status: "not_configured"; missing: string[] }
  | { status: "connected"; account: MetaAccount; adsManager: string }
  | { status: "error"; detail: string };

const cache = ((globalThis as { __metaLink?: { at: number; v: MetaLink } }).__metaLink ??= { at: 0, v: { status: "not_configured", missing: [] } });

/** Is the desk connected to the Meta ad account? Cached 5 minutes. */
export async function metaLink(fresh = false): Promise<MetaLink> {
  const m = metaAds();
  if (!m) return { status: "not_configured", missing: MetaAds.missingEnv(process.env) };
  if (!fresh && Date.now() - cache.at < 5 * 60_000 && cache.v.status !== "not_configured") return cache.v;
  try {
    cache.v = { status: "connected", account: await m.account(), adsManager: m.adsManagerUrl() };
  } catch (e) {
    cache.v = { status: "error", detail: (e as Error).message };
  }
  cache.at = Date.now();
  return cache.v;
}

const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const now = () => new Date().toISOString();

/** A planned campaign from a Marketing Map ad concept: starts next Monday for a week, copy from the concept. */
export async function planFromConcept(conceptId: string): Promise<AdCampaign> {
  const repo = getRepo();
  const map = await repo.getMap();
  const n = map.doc.nodes.find((x) => x.id === conceptId);
  if (!n) throw new Error(`No concept ${conceptId} in the Marketing Map`);
  const today = hstToday();
  const dow = new Date(today + "T12:00:00Z").getUTCDay();
  const start = addDays(today, ((8 - dow) % 7) || 7);
  const c: AdCampaign = {
    id: `ad-${Date.now().toString(36)}`, title: n.title, concept_id: n.id, objective: defaultObjective(),
    starts_on: start, ends_on: addDays(start, 6), daily_budget: Math.min(20, maxDailyBudget()),
    countries: (process.env.META_COUNTRIES || "US").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    age_min: 18, age_max: 65, primary_text: [n.hook, n.cta].filter(Boolean).join("\n\n"), headline: n.title.slice(0, 40),
    cta: "DOWNLOAD", link: process.env.META_DEFAULT_LINK || "", creative: null, status: "planned", approval_id: null, meta: {},
    created_at: now(), updated_at: now(),
  };
  await repo.insert("ad_campaigns", [c]);
  return c;
}

/** A blank planned campaign from Launch: starts tomorrow for a week, the brand line as primary text, no videos yet. */
export async function planBlank(title?: string): Promise<AdCampaign> {
  const start = addDays(hstToday(), 1);
  const c: AdCampaign = {
    id: `ad-${Date.now().toString(36)}`, title: (title ?? "").trim().slice(0, 80) || "New campaign", concept_id: null,
    objective: defaultObjective(), starts_on: start, ends_on: addDays(start, 6), daily_budget: Math.min(20, maxDailyBudget()),
    countries: (process.env.META_COUNTRIES || "US").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    age_min: 18, age_max: 65, primary_text: BRAND.pitch, headline: BRAND.name,
    cta: "DOWNLOAD", link: process.env.META_DEFAULT_LINK || "", creative: null, creatives: [], trials: [], status: "planned", approval_id: null, meta: {},
    created_at: now(), updated_at: now(),
  };
  await getRepo().insert("ad_campaigns", [c]);
  return c;
}

const EDITABLE = ["title", "objective", "starts_on", "ends_on", "daily_budget", "countries", "age_min", "age_max",
  "primary_text", "headline", "cta", "link", "creatives", "trials"] as const;

async function deskVideo(job_id: unknown, variant_id: unknown) {
  if (typeof job_id !== "string" || typeof variant_id !== "string" || !job_id || !variant_id) throw new Error("A picked video is missing its id");
  const [v] = await getRepo().list("reel_variants", { eq: { job_id, id: variant_id } });
  if (!v?.file) throw new Error(`Video ${variant_id} isn't in the gallery any more`);
  return v;
}

/** Re-read every picked desk video from the gallery (file and poster come from there, never the browser). */
async function cleanCreatives(list: unknown): Promise<AdCreativePick[]> {
  if (!Array.isArray(list)) throw new Error("creatives must be a list");
  const out: AdCreativePick[] = [];
  for (const x of list as Partial<AdCreativePick>[]) {
    let pick: AdCreativePick;
    if (x.ig_media_id) {
      const ig = String(x.ig_media_id);
      if (!/^\d+$/.test(ig)) throw new Error("That Instagram post id doesn't look right");
      pick = { key: `ig:${ig}`, ig_media_id: ig, label: String(x.label ?? "").slice(0, 140) || `Instagram post ${ig.slice(-6)}`,
        thumb: typeof x.thumb === "string" ? x.thumb : null, permalink: typeof x.permalink === "string" ? x.permalink : null };
    } else {
      const v = await deskVideo(x.job_id, x.variant_id);
      pick = { key: `${v.job_id}|${v.id}`, job_id: v.job_id, variant_id: v.id, file: v.file!, poster: v.poster, label: (v.hook || v.id).slice(0, 140) };
    }
    if (!out.some((y) => y.key === pick.key)) out.push(pick);
  }
  if (out.length > MAX_ADS) throw new Error(`Up to ${MAX_ADS} videos per campaign`);
  return out;
}

/** Desk videos sent to trial with the campaign; a video is either in the campaign or sent to trial, not both. */
async function cleanTrials(list: unknown, ads: AdCreativePick[]): Promise<AdTrialPick[]> {
  if (!Array.isArray(list)) throw new Error("trials must be a list");
  const out: AdTrialPick[] = [];
  for (const x of list as Partial<AdTrialPick>[]) {
    const v = await deskVideo(x.job_id, x.variant_id);
    const key = `${v.job_id}|${v.id}`;
    if (!ads.some((a) => a.key === key) && !out.some((y) => y.key === key)) out.push({ key, job_id: v.job_id, variant_id: v.id, label: (v.hook || v.id).slice(0, 140), poster: v.poster });
  }
  return out.slice(0, 15);
}

export async function getCampaign(id: string): Promise<AdCampaign> {
  const [c] = await getRepo().list("ad_campaigns", { eq: { id } });
  if (!c) throw new Error("campaign not found");
  return c;
}

/** Edits are only allowed before anything exists in Meta, and send a rejected or failed campaign back to planned. */
export async function editCampaign(id: string, patch: Partial<AdCampaign>): Promise<AdCampaign> {
  const c = await getCampaign(id);
  if (!["planned", "rejected", "failed"].includes(c.status) || c.meta.campaign_id) throw new Error(`Can't edit a campaign that is ${c.status}`);
  const clean: Partial<AdCampaign> = {};
  for (const k of EDITABLE) if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];
  // the old single-reel shape (still accepted from older clients) becomes a one-item list
  if (!("creatives" in patch) && "creative" in patch) clean.creatives = patch.creative ? creativesOf({ creative: patch.creative }) : [];
  if ("creatives" in clean) {
    clean.creatives = await cleanCreatives(clean.creatives);
    clean.creative = null; // the list is the source of truth from here on
  }
  if ("trials" in clean || "creatives" in clean) clean.trials = await cleanTrials(clean.trials ?? c.trials ?? [], clean.creatives ?? creativesOf(c));
  // any edit after a decision needs a fresh approval: the approved version is the only one that may be built
  const next = { ...c, ...clean, status: "planned", approval_id: c.status === "planned" ? c.approval_id : null, updated_at: now() } as AdCampaign;
  await getRepo().update("ad_campaigns", { id }, { ...clean, status: next.status, approval_id: next.approval_id, updated_at: next.updated_at });
  return next;
}

/** Everything Meta will need, checked before the campaign goes to approval. */
export function problems(c: AdCampaign, today = hstToday()): string[] {
  const p: string[] = [];
  if (!c.title.trim()) p.push("Give it a name");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.starts_on) || !/^\d{4}-\d{2}-\d{2}$/.test(c.ends_on) || c.ends_on < c.starts_on) p.push("Pick a start and an end date (end on or after start)");
  else if (c.ends_on < today) p.push("The end date is in the past");
  if (!(c.daily_budget > 0)) p.push("Set a daily budget");
  else if (c.daily_budget > maxDailyBudget()) p.push(`Daily budget is over the desk's cap of ${maxDailyBudget()} (META_MAX_DAILY_BUDGET)`);
  if (!c.countries.length || c.countries.some((x) => !/^[A-Z]{2}$/.test(x))) p.push("Countries must be 2-letter codes, e.g. US, CA");
  if (c.age_min < 13 || c.age_max > 65 || c.age_min > c.age_max) p.push("Ages must be within 13–65");
  if (!c.primary_text.trim()) p.push("Write the primary text");
  if (!c.headline.trim()) p.push("Write a headline");
  if (!(CTAS as readonly string[]).includes(c.cta)) p.push("Pick a call to action");
  if (!/^https:\/\/\S+$/.test(c.link)) p.push("Add the https link people land on (App Store / website)");
  if (c.objective === "app_installs" && !/apps\.apple\.com|play\.google\.com/.test(c.link)) p.push("App install campaigns need an App Store or Google Play link");
  const ads = creativesOf(c);
  if (!ads.length) p.push("Pick at least one video for the campaign");
  if (ads.length > MAX_ADS) p.push(`Up to ${MAX_ADS} videos per campaign`);
  for (const a of ads) {
    if (a.ig_media_id) continue;
    if (!a.job_id || !a.file) p.push(`${a.label ?? a.key} has no video file`);
    else if (!a.poster) p.push(`${a.label ?? a.key} has no poster frame for a thumbnail`);
  }
  return p;
}

/** Into the approvals queue; the preview lists exactly what will be created and spent. */
export async function submitCampaign(id: string, by: string): Promise<Approval> {
  const c = await getCampaign(id);
  if (!["planned", "rejected"].includes(c.status)) throw new Error(`Already ${c.status}`);
  const p = problems(c);
  if (p.length) throw new Error(p.join(". "));
  const days = Math.round((Date.parse(c.ends_on) - Date.parse(c.starts_on)) / 86400_000) + 1;
  const repo = getRepo();
  const ads = creativesOf(c);
  const waves = await launchStructure(c);
  const adLine = (x: AdCreativePick, i: number) => x.ig_media_id
    ? `Ad ${i + 1}: Instagram post, promoted as-is · ${(x.label ?? "").split("\n")[0].slice(0, 80)} (${x.ig_media_id})`
    : `Ad ${i + 1}: desk video · ${(x.label ?? x.variant_id ?? "").slice(0, 80)} (${x.file})`;
  const [a] = await repo.insert("approvals", [{
    id: crypto.randomUUID(), type: "ad_launch", ref_table: "ad_campaigns", ref_id: c.id, title: `Meta ad: ${c.title}`,
    summary: `${c.starts_on} → ${c.ends_on} (${days} days) · ${c.daily_budget}/day, up to ${c.daily_budget * days} total · ${c.objective} · ${c.countries.join(", ")}`,
    preview: {
      bullets: [
        ...(waves ? [
          `On approve: builds the feature test campaign in Meta, paused: one ad set per feature at ${waves.sets[0].daily}/day each, ${ads.length} ads in all`,
          ...waves.sets.map((g) => `${g.name}: ${g.live.length} live first${g.bench.length ? `, ${g.bench.length} waiting their turn (built paused)` : ""}`),
          `Waves (with live optimize on): when an ad is killed the next one for its feature switches on. Ads that prove themselves (${"2,000+"} impressions over 2+ days, clicks 25%+ above the test's median) move to a second campaign, Winners, where Meta spreads the budget; it opens with two and gets 50-70% of the daily budget. A feature that runs out of ads is paused and its share goes to the rest.`,
          `The launch never spends more than ${c.daily_budget}/day in all: the desk only moves it between the test and Winners. Raising it still comes here.`,
        ] : [`On approve: builds 1 campaign and 1 ad set in Meta, paused, with ${ads.length} ad${ads.length > 1 ? "s" : ""} (desk videos are uploaded with their thumbnail; Instagram posts are promoted as they are)`]),
        `Switches on ${c.starts_on} and stops after ${c.ends_on} (Honolulu)`,
        `Instagram Reels, Stories and Feed · ages ${c.age_min}–${c.age_max} · ${c.countries.join(", ")}`,
        `Headline: ${c.headline} · CTA ${c.cta} → ${c.link}`,
        ...ads.map(adLine),
        ...(c.trials?.length ? [`Also sent to trial (free, non-followers only, not part of the ads): ${c.trials.map((t) => t.label ?? t.variant_id).join(" · ")}`] : []),
      ],
      caption: c.primary_text,
    },
    status: "pending", created_by_agent: by, decided_by: null, decided_at: null, result: null, created_at: now(),
  }]);
  await repo.update("ad_campaigns", { id }, { status: "pending_approval", approval_id: a.id, updated_at: now() });
  return a;
}

/** Called by the approvals route after a decision on an ad_launch approval. */
export async function onAdDecision(a: Approval, decision: "approve" | "reject"): Promise<void> {
  if (!a.ref_id) return;
  if (decision === "reject") {
    await getRepo().update("ad_campaigns", { id: a.ref_id }, { status: "rejected", updated_at: now() });
    return;
  }
  void buildCampaign(a.ref_id).catch(() => {}); // records its own failure
}

const running = ((globalThis as { __adBuilds?: Set<string> }).__adBuilds ??= new Set<string>());

export async function media(jobId: string, file: string): Promise<Blob> {
  const r = await engine().fetchFile(jobId, file);
  if (!r || !r.ok) throw new Error(`The reel engine has no ${file} (is it running?)`);
  return new Blob([await r.arrayBuffer()], { type: r.headers.get("Content-Type") ?? "application/octet-stream" });
}

/**
 * Build the approved campaign in Meta, paused. Resumable: ids are saved after every step, so a retry after a
 * failure continues where it stopped instead of creating duplicates.
 */
export async function buildCampaign(id: string): Promise<AdCampaign> {
  if (running.has(id)) return getCampaign(id);
  running.add(id);
  const repo = getRepo();
  let c = await getCampaign(id);
  const save = async (patch: Partial<AdCampaign>) => {
    c = { ...c, ...patch, meta: { ...c.meta, ...patch.meta }, updated_at: now() };
    await repo.update("ad_campaigns", { id }, { ...patch, meta: c.meta, updated_at: c.updated_at });
  };
  const approval = c.approval_id ? (await repo.list("approvals", { eq: { id: c.approval_id } }))[0] : undefined;
  try {
    if (!approval || !["approved", "failed", "executed"].includes(approval.status) || !approval.decided_at) throw new Error("This campaign hasn't been approved");
    const m = metaAds();
    if (!m) throw new Error(`Meta isn't connected: set ${MetaAds.missingEnv(process.env).join(", ")} in .env`);
    const ads = creativesOf(c);
    if (!ads.length) throw new Error("No videos in the campaign");
    await save({ status: "building", meta: { error: null } });
    const acct = await m.account();
    const name = `${BRAND.name} · ${c.title} · ${c.starts_on}`;
    const app = c.objective === "app_installs" || /apps\.apple\.com|play\.google\.com/.test(c.link) ? await m.appFor(c.link) : null;
    if (c.objective === "app_installs" && !app) throw new Error(APP_MISSING);
    const ios = /apps\.apple\.com/.test(c.link);
    if (!c.meta.campaign_id) await save({ meta: { campaign_id: await m.createCampaign(name, c.objective, { ios }) } });
    const today = hstToday();
    const startTime = c.starts_on <= today ? new Date(Date.now() + 10 * 60_000).toISOString() : `${c.starts_on}T00:00:00-10:00`;
    const minor = (x: number) => toMinor(x, acct.currency);
    const newSet = (setName: string, daily: number) => m.createAdSet({
      name: setName, campaignId: c.meta.campaign_id!, goal: c.objective, startTime, endTime: `${c.ends_on}T23:59:00-10:00`,
      dailyBudgetMinor: minor(daily), countries: c.countries, ageMin: c.age_min, ageMax: c.age_max, link: c.link, appId: app?.id,
    });
    const features = await adFeatures(c);
    // a campaign built before the split keeps its one ad set; a new one splits by feature when it can
    const plan = c.meta.adset_id && !c.meta.adsets ? null : adsetPlan(c, features);
    if (plan && !c.meta.waves && !c.meta.ads) {
      // waves: a few ads per feature run first, the rest are built paused and wait their turn (lib/waves.ts)
      const per = LIVE_PER_SET();
      const bench = plan.groups.flatMap((g) => waveOrder(ads.filter((x) => features[x.key] === g).map((x) => x.key), per).bench);
      await save({ meta: { waves: { live_per_set: per, log: [] }, ads: Object.fromEntries(bench.map((k) => [k, { bench: true, feature: features[k] }])) } });
    }
    if (plan) {
      for (const g of plan.groups) {
        if (c.meta.adsets?.[g]) continue;
        const id = await newSet(`${name} · ${featureName(g)}`, plan.daily);
        await save({ meta: { adsets: { ...(c.meta.adsets ?? {}), [g]: id }, adset_id: c.meta.adset_id ?? id } });
      }
    } else if (!c.meta.adset_id) {
      await save({ meta: { adset_id: await newSet(name, c.daily_budget) } });
    }
    // an ad whose feature has no ad set (added later by rotation) goes in the first one
    const setFor = (k: string) => c.meta.adsets?.[features[k]] ?? c.meta.adset_id!;
    // one creative + ad per item; ids are saved per item, so a retry picks up at the first missing step.
    // A legacy single-creative row resumes from the ids it saved at the top level of meta.
    const legacy = isLegacy(c);
    const idsOf = (k: string): AdMetaIds => c.meta.ads?.[k]
      ?? (legacy ? { video_id: c.meta.video_id, image_hash: c.meta.image_hash, creative_id: c.meta.creative_id, ad_id: c.meta.ad_id } : {});
    const saveAd = (k: string, patch: AdMetaIds) => save({ meta: { ads: { ...c.meta.ads, [k]: { ...idsOf(k), ...patch } } } });
    for (const [i, x] of ads.entries()) {
      const adName = ads.length > 1 ? `${name} · ${i + 1}` : name;
      if (!x.ig_media_id) { // a desk video: upload it and its poster frame
        if (!x.job_id || !x.file) throw new Error(`${x.label ?? x.key} has no video file`);
        if (!idsOf(x.key).video_id) await saveAd(x.key, { video_id: await m.uploadVideo(adName, await media(x.job_id, x.file)) });
        if (!idsOf(x.key).image_hash) {
          if (!x.poster) throw new Error(`${x.label ?? x.key} has no poster frame for a thumbnail`);
          await saveAd(x.key, { image_hash: await m.uploadImage(x.poster, await media(x.job_id, x.poster)) });
        }
      }
      if (!idsOf(x.key).creative_id) {
        const ids = idsOf(x.key);
        await saveAd(x.key, { creative_id: x.ig_media_id
          ? await m.createCreativeFromInstagram({ name: adName, igMediaId: x.ig_media_id, cta: c.cta, link: c.link })
          : await m.createCreative({ name: adName, videoId: ids.video_id!, imageHash: ids.image_hash!, message: c.primary_text, headline: c.headline, cta: c.cta, link: c.link }) });
      }
      if (!idsOf(x.key).ad_id) {
        const set = idsOf(x.key).adset_id ?? setFor(x.key);
        const wait = !!idsOf(x.key).bench;
        await saveAd(x.key, { adset_id: set, feature: idsOf(x.key).feature ?? features[x.key], ad_id: await m.createAd(adName, set, idsOf(x.key).creative_id!, wait ? "PAUSED" : "ACTIVE") });
      }
    }
    await save({ status: "ready", meta: { built_at: now() } });
    await repo.update("approvals", { id: approval.id }, { status: "executed", result: { ...c.meta, ads_manager: m.adsManagerUrl(c.meta.campaign_id) } });
    await tickCampaign(c, m); // starts today → on now
  } catch (e) {
    const msg = (e as Error).message;
    await save({ status: "failed", meta: { error: msg } });
    if (approval) await repo.update("approvals", { id: approval.id }, { status: "failed", result: { error: msg } });
  } finally {
    running.delete(id);
  }
  return getCampaign(id);
}

/** Manual stop / restart from the calendar. Restarting only turns it on inside its dates. */
export async function setPaused(id: string, paused: boolean): Promise<AdCampaign> {
  const c = await getCampaign(id);
  const m = metaAds();
  if (!m || !c.meta.campaign_id) throw new Error("Not built in Meta yet");
  const today = hstToday();
  if (paused) {
    if (!["ready", "live"].includes(c.status)) throw new Error(`Can't pause a campaign that is ${c.status}`);
    await m.setCampaignStatus(c.meta.campaign_id, "PAUSED");
    await followLaunch(c, "PAUSED");
    await getRepo().update("ad_campaigns", { id }, { status: "paused", updated_at: now() });
  } else {
    if (c.status !== "paused") throw new Error("Only a paused campaign can be resumed");
    const status = c.ends_on < today ? "ended" : c.starts_on > today ? "ready" : "live";
    if (status === "live") { await m.setCampaignStatus(c.meta.campaign_id, "ACTIVE"); await followLaunch(c, "ACTIVE"); }
    await getRepo().update("ad_campaigns", { id }, { status, updated_at: now() });
  }
  return getCampaign(id);
}

/** Only campaigns with nothing in Meta can be deleted; a pending approval goes with it. */
export async function deleteCampaign(id: string): Promise<void> {
  const c = await getCampaign(id);
  if (c.meta.campaign_id) throw new Error("It exists in Meta: pause it instead");
  const repo = getRepo();
  if (c.approval_id && c.status === "pending_approval") await repo.update("approvals", { id: c.approval_id }, { status: "rejected", result: { note: "campaign deleted" } });
  await repo.remove("ad_campaigns", { id });
}
