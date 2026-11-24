import { tzSuffix } from "./tz";
import "server-only";
import { getRepo, type AdCampaign, type Approval, type CandidateMetrics, type GrowthTest, type TestCandidate } from "@engine/db";
import { buildCampaign, creativesOf, defaultObjective, getCampaign, media, metaAds, setPaused } from "./ad-campaigns";
import { hstToday } from "./utils";
import { BRAND } from "./brand";

/**
 * Continuous improvement. "Improve" on a test, an ad campaign or an Instagram post reads the latest results and turns
 * them into proposals in the Decide queue (approval type "optimize"). Nothing posts, spends or changes a budget until
 * you approve the proposal; then runProposal() carries it out and logs what it learned.
 *
 * Test Lab flow (the plan you chose): trial reels first (free, non-followers only, off the grid) → the best ones
 * screened as ads-only campaigns on a small budget → the winners scaled, the rest paused.
 */

const now = () => new Date().toISOString();
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hoursSince = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : 0);
export const TRIAL_HOURS = () => { const h = Number(process.env.TEST_TRIAL_HOURS); return process.env.TEST_TRIAL_HOURS && Number.isFinite(h) ? h : 48; };
const MIN_TRIAL_REACH = 150;

export type ProposalAction =
  | { kind: "opt_apply"; key: string }
  | { kind: "post_trials"; test_id: string; candidate_ids: string[] }
  | { kind: "advance_screen"; test_id: string; candidate_ids: string[]; daily_budget: number; days: number }
  | { kind: "advance_scale"; test_id: string; winners: { candidate_id: string; daily_budget: number }[]; losers: string[]; days: number }
  | { kind: "set_budget"; ad_campaign_id: string; daily_budget: number; extend_days: number }
  | { kind: "pause"; ad_campaign_ids: string[] }
  | { kind: "promote_post"; ig_media_id: string; caption: string; daily_budget: number; days: number }
  | { kind: "post_trial_video"; job_id: string; variant_id: string; caption: string } // the autopilot's new version
  | { kind: "post_trials_batch"; items: { job_id: string; variant_id: string; caption: string }[] } // the day's Instagram reels
  | { kind: "rotate_ads"; ad_campaign_id: string; pause: string[]; add: { key: string; job_id: string; variant_id: string; file: string; poster: string | null; label: string }[] };

// ---------------------------------------------------------------- money

const fundsCache = ((globalThis as { __funds?: { at: number; v: Awaited<ReturnType<typeof readFunds>> } }).__funds ??= { at: 0, v: null as never });
async function readFunds() {
  const m = metaAds();
  return m ? m.funds() : null;
}

/** Spend already promised to campaigns that are built and not ended: daily budget × days left. */
export async function committedSpend(today = hstToday()): Promise<number> {
  const live = (await getRepo().list("ad_campaigns")).filter((c) => ["building", "ready", "live"].includes(c.status));
  return live.reduce((sum, c) => {
    const from = c.starts_on > today ? c.starts_on : today;
    const days = Math.max(0, Math.round((Date.parse(c.ends_on) - Date.parse(from)) / 86_400_000) + 1);
    return sum + c.daily_budget * days;
  }, 0);
}

/** What Meta says you can spend, minus what live campaigns will still spend. Cached 10 minutes. */
export async function spendable(fresh = false) {
  if (fresh || !fundsCache.v || Date.now() - fundsCache.at > 10 * 60_000) {
    fundsCache.v = await readFunds();
    fundsCache.at = Date.now();
  }
  const f = fundsCache.v;
  const committed = await committedSpend();
  return { funds: f, committed, free: f?.usable != null ? Math.max(0, f.usable - committed) : null };
}

/**
 * Budget plan for a test, from the money you can actually spend: ~20% to screen the trial winners (4 days each),
 * ~55% to scale the 2 best for 7 days, ~25% kept in reserve. Never below Meta's minimum daily budget.
 */
export async function planFor(trialCount: number): Promise<GrowthTest["plan"]> {
  const { funds, free } = await spendable();
  const usable = free ?? Number(process.env.TEST_BUDGET_FALLBACK || 500);
  const advanceTrial = Math.min(5, Math.max(2, Math.ceil(trialCount / 2)));
  const min = funds?.minDailyBudget ?? 1;
  const screenDays = 4, scaleDays = 7;
  const screenDaily = Math.max(min, Math.floor((usable * 0.2) / (advanceTrial * screenDays)));
  const scaleTotal = Math.floor(usable * 0.55);
  return {
    usable: free, currency: funds?.currency ?? "USD", screen_daily: screenDaily, screen_days: screenDays,
    scale_total: scaleTotal, scale_days: scaleDays, reserve: Math.max(0, Math.floor(usable - screenDaily * advanceTrial * screenDays - scaleTotal)),
    advance_trial: advanceTrial, advance_screen: 2,
  };
}

/** Refuse a proposal that would promise more than the account can pay for. */
async function assertAffordable(extra: number) {
  const { free, funds } = await spendable(true);
  if (free != null && extra > free) {
    throw new Error(`Not enough funds: this needs ${extra.toFixed(2)} ${funds?.currency ?? ""} but only ${free.toFixed(2)} is free (balance/spend cap minus live campaigns). Add funds or lower the budget.`);
  }
}

// ---------------------------------------------------------------- tests

export async function createTest(input: { name: string; picks: { job_id: string; variant_id: string; caption?: string; content_id?: string | null }[] }): Promise<GrowthTest> {
  if (!input.name.trim()) throw new Error("Name the test");
  if (input.picks.length < 2 || input.picks.length > 15) throw new Error("Pick 2–15 reels from the gallery");
  const repo = getRepo();
  const variants = await repo.list("reel_variants");
  const items = await repo.list("content_items");
  const candidates: TestCandidate[] = input.picks.map((p, i) => {
    const v = variants.find((x) => x.job_id === p.job_id && x.id === p.variant_id);
    if (!v?.file) throw new Error(`Reel ${p.variant_id} isn't in the gallery any more`);
    const item = p.content_id ? items.find((c) => c.id === p.content_id) : null;
    const hook = String((item?.meta as { hook?: string } | undefined)?.hook ?? v.hook ?? v.id);
    return {
      id: `cand-${i + 1}`, label: v.hook ?? v.id, hook, caption: (p.caption ?? v.caption ?? hook).slice(0, 2000),
      pillar: (item?.meta as { pillar?: string } | undefined)?.pillar ?? null, content_id: item?.id ?? null,
      creative: { job_id: v.job_id, variant_id: v.id, file: v.file, poster: v.poster }, status: "active", trial: null, screen: null, scale: null,
    };
  });
  const t: GrowthTest = {
    id: `test-${Date.now().toString(36)}`, name: input.name.trim(), stage: "trial", plan: await planFor(candidates.length),
    candidates, log: [{ at: now(), text: `Created with ${candidates.length} reels.` }], created_at: now(), updated_at: now(),
  };
  await repo.insert("growth_tests", [t]);
  return t;
}

export async function getTest(id: string): Promise<GrowthTest> {
  const [t] = await getRepo().list("growth_tests", { eq: { id } });
  if (!t) throw new Error("Test not found");
  return t;
}
async function saveTest(t: GrowthTest, line?: string) {
  if (line) t.log = [...t.log, { at: now(), text: line }].slice(-200);
  t.updated_at = now();
  await getRepo().update("growth_tests", { id: t.id }, { stage: t.stage, plan: t.plan, candidates: t.candidates, log: t.log, updated_at: t.updated_at });
}

// ---------------------------------------------------------------- scoring

/** Trial score: (saves + shares) ÷ reach. Needs some reach before it means anything. */
export const trialScore = (m?: CandidateMetrics) => (m?.reach && m.reach >= MIN_TRIAL_REACH ? ((m.saves ?? 0) + (m.shares ?? 0)) / m.reach : null);
/** Screen score: link clicks per unit of spend (no install tracking yet), hook rate (3-s views ÷ impressions) as tiebreak. */
export const screenScore = (m?: CandidateMetrics) => (m?.spend && m.spend > 0 ? (m.clicks ?? 0) / m.spend + 0.01 * ((m.video_views ?? 0) / Math.max(1, m.impressions ?? 0)) : null);

/** Pull fresh results for every live candidate and record what was learned (also feeds the reel learn loop). */
export async function measureTest(t: GrowthTest): Promise<GrowthTest> {
  const m = metaAds();
  if (!m) throw new Error("Meta isn't connected");
  const repo = getRepo();
  for (const c of t.candidates) {
    if (c.trial?.media_id) {
      try {
        const r = await m.reelResults(c.trial.media_id);
        c.trial.metrics = { reach: r.reach, saves: r.saves, shares: r.shares, views: r.views, avg_watch_ms: r.avgWatchMs, measured_at: now() };
        c.trial.score = trialScore(c.trial.metrics);
        await recordPost(c, r);
      } catch (e) { c.trial.error = (e as Error).message; }
    }
    for (const stage of ["screen", "scale"] as const) {
      const s = c[stage];
      if (!s?.ad_campaign_id) continue;
      const camp = await getCampaign(s.ad_campaign_id).catch(() => null);
      if (!camp?.meta.campaign_id) continue;
      const r = await m.campaignResults(camp.meta.campaign_id);
      s.metrics = { spend: r.spend, impressions: r.impressions, clicks: r.clicks, video_views: r.videoViews, landing_views: r.landingViews, installs: r.installs, measured_at: now() };
      if (stage === "screen") t.candidates.find((x) => x.id === c.id)!.screen!.score = screenScore(s.metrics);
    }
  }
  // a trial run counts as "tested" on the linked plan idea (Content → Pipeline gates)
  for (const c of t.candidates.filter((x) => x.content_id && x.trial?.metrics)) {
    const [item] = await repo.list("content_items", { eq: { id: c.content_id! } });
    const g = (item?.meta as { gates?: Record<string, unknown> } | undefined)?.gates;
    if (item && g && !g.tested) await repo.update("content_items", { id: item.id }, { meta: { ...item.meta, gates: { ...g, tested: true, tested_by: "Test Lab" } } });
  }
  await saveTest(t, "Measured results.");
  return t;
}

/** Trial reel results into reel_posts, so the hook learn loop sees them like any posted reel. */
async function recordPost(c: TestCandidate, r: { reach: number; saves: number; shares: number; views: number; avgWatchMs: number | null }) {
  const repo = getRepo();
  const [row] = await repo.list("reel_posts", { eq: { job_id: c.creative.job_id, variant_id: c.creative.variant_id } });
  const patch = { views: r.views || r.reach, saves: r.saves, shares: r.shares, avg_watch_s: r.avgWatchMs != null ? r.avgWatchMs / 1000 : null, updated_at: now() };
  if (row) await repo.update("reel_posts", { id: row.id }, patch);
  else await repo.insert("reel_posts", [{ id: Date.now() + Math.floor(Math.random() * 1000), job_id: c.creative.job_id, variant_id: c.creative.variant_id, platform: "ig",
    url: c.trial?.permalink ?? null, sound: null, posted_at: c.trial?.posted_at ?? now(), likes: null, comments: null, follows: null, ...patch }]);
}

// ---------------------------------------------------------------- proposals

async function propose(by: string, title: string, summary: string, bullets: string[], action: ProposalAction, ref: { table: string | null; id: string | null }): Promise<Approval> {
  const [a] = await getRepo().insert("approvals", [{
    id: crypto.randomUUID(), type: "optimize", ref_table: ref.table, ref_id: ref.id, title, summary, preview: { bullets, action },
    status: "pending", created_by_agent: by, decided_by: null, decided_at: null, result: null, created_at: now(),
  }]);
  return a;
}
const pending = async (refId: string) => (await getRepo().list("approvals", { eq: { ref_id: refId, status: "pending" } })).filter((a) => a.type === "optimize");

export interface ImproveResult { proposals: Approval[]; notes: string[] }

/** The Improve button on a test: measure, then propose the next step for its stage. */
export async function improveTest(id: string, by: string): Promise<ImproveResult> {
  let t = await getTest(id);
  const notes: string[] = [];
  if ((await pending(t.id)).length) return { proposals: [], notes: ["A proposal for this test is already waiting in Decide."] };
  if (t.candidates.some((c) => c.trial?.media_id || c.screen?.ad_campaign_id)) t = await measureTest(t);
  const active = t.candidates.filter((c) => c.status !== "dropped");
  const cur = t.plan.currency;

  if (t.stage === "trial") {
    const unposted = active.filter((c) => !c.trial?.media_id);
    if (unposted.length) {
      return { notes, proposals: [await propose(by, `Test "${t.name}": post ${unposted.length} trial reels`,
        `Free. Shown only to non-followers; nothing appears on your grid unless you graduate it in the Instagram app.`,
        [...unposted.map((c) => `Trial reel: ${c.label}`), `After ${TRIAL_HOURS()} h, Improve compares (saves + shares) ÷ reach and proposes the ad screen.`],
        { kind: "post_trials", test_id: t.id, candidate_ids: unposted.map((c) => c.id) }, { table: "growth_tests", id: t.id })] };
    }
    const youngest = Math.min(...active.map((c) => hoursSince(c.trial?.posted_at)));
    if (youngest < TRIAL_HOURS()) return { proposals: [], notes: [`Trial reels need ${TRIAL_HOURS()} h of reach; check back in about ${Math.ceil(TRIAL_HOURS() - youngest)} h.`] };
    const scored = active.filter((c) => c.trial?.score != null).sort((a, b) => (b.trial!.score! - a.trial!.score!) || ((b.trial!.metrics?.avg_watch_ms ?? 0) - (a.trial!.metrics?.avg_watch_ms ?? 0)));
    if (scored.length < 2) return { proposals: [], notes: [`Not enough reach yet (each trial reel needs ${MIN_TRIAL_REACH}+). Give it more time.`] };
    t.plan = { ...(await planFor(active.length)), advance_screen: t.plan.advance_screen };
    const pick = scored.slice(0, t.plan.advance_trial);
    const total = t.plan.screen_daily * t.plan.screen_days * pick.length;
    await saveTest(t);
    return { notes, proposals: [await propose(by, `Test "${t.name}": screen the top ${pick.length} as ads`,
      `${pick.length} ads-only campaigns × ${t.plan.screen_daily} ${cur}/day × ${t.plan.screen_days} days = ${total} ${cur}. Not posted to your profile.`,
      [...pick.map((c, i) => `#${i + 1} ${c.label}: ${(c.trial!.score! * 100).toFixed(2)}% saves+shares/reach, ${c.trial!.metrics?.reach} reach`),
        `Dropped: ${active.filter((c) => !pick.includes(c)).map((c) => c.label).join(", ") || "none"}`,
        `Free to spend now: ${t.plan.usable?.toFixed(2) ?? "unknown"} ${cur}. Scale budget reserved: ${t.plan.scale_total} ${cur}.`],
      { kind: "advance_screen", test_id: t.id, candidate_ids: pick.map((c) => c.id), daily_budget: t.plan.screen_daily, days: t.plan.screen_days },
      { table: "growth_tests", id: t.id })] };
  }

  if (t.stage === "screen") {
    const inScreen = active.filter((c) => c.screen?.ad_campaign_id);
    const spent = inScreen.reduce((s, c) => s + (c.screen?.metrics?.spend ?? 0), 0);
    const planned = t.plan.screen_daily * t.plan.screen_days * inScreen.length;
    if (spent < planned * 0.6) return { proposals: [], notes: [`Screen has spent ${spent.toFixed(2)} of ${planned} ${cur}; judge at 60%+ so the result isn't luck.`] };
    const ranked = inScreen.filter((c) => c.screen?.score != null).sort((a, b) => b.screen!.score! - a.screen!.score!);
    const winners = ranked.slice(0, t.plan.advance_screen);
    const daily = Math.max(1, Math.floor(t.plan.scale_total / t.plan.scale_days / Math.max(1, winners.length)));
    return { notes, proposals: [await propose(by, `Test "${t.name}": scale the top ${winners.length}, pause the rest`,
      `${winners.length} × ${daily} ${cur}/day × ${t.plan.scale_days} days = ${daily * winners.length * t.plan.scale_days} ${cur}.`,
      [...ranked.map((c, i) => `${i < winners.length ? "Scale" : "Pause"} ${c.label}: ${c.screen!.metrics?.clicks ?? 0} clicks for ${(c.screen!.metrics?.spend ?? 0).toFixed(2)} ${cur}, hook rate ${pct((c.screen!.metrics?.video_views ?? 0) / Math.max(1, c.screen!.metrics?.impressions ?? 0))}`),
        "Judged on clicks per dollar until install tracking exists; that's an early signal, not proof of installs."],
      { kind: "advance_scale", test_id: t.id, winners: winners.map((c) => ({ candidate_id: c.id, daily_budget: daily })), losers: ranked.slice(winners.length).map((c) => c.id), days: t.plan.scale_days },
      { table: "growth_tests", id: t.id })] };
  }

  if (t.stage === "scale") {
    const proposals: Approval[] = [];
    for (const c of active.filter((x) => x.scale?.ad_campaign_id)) proposals.push(...(await improveCampaign(c.scale!.ad_campaign_id!, by)).proposals);
    if (!proposals.length) notes.push("Scaling looks on track. Improve again in a day or two.");
    return { proposals, notes };
  }
  return { proposals: [], notes: ["This test is done."] };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Improve on one ad campaign: pause it if it's clearly worse than the account, give it more budget if clearly better. */
export async function improveCampaign(id: string, by: string): Promise<ImproveResult> {
  const c = await getCampaign(id);
  const m = metaAds();
  if (!m || !c.meta.campaign_id) return { proposals: [], notes: ["Not built in Meta yet."] };
  if ((await pending(c.id)).length) return { proposals: [], notes: ["A proposal for this campaign is already waiting in Decide."] };
  const r = await m.campaignResults(c.meta.campaign_id);
  if (r.spend < c.daily_budget * 2) return { proposals: [], notes: [`Only ${r.spend.toFixed(2)} spent so far; give it about two days of budget before judging.`] };
  const others = (await getRepo().list("ad_campaigns")).filter((x) => x.id !== c.id && x.meta.campaign_id);
  const peers = await Promise.all(others.slice(0, 10).map((x) => m.campaignResults(x.meta.campaign_id!).catch(() => null)));
  const cpcs = peers.filter((p): p is NonNullable<typeof p> => !!p && p.clicks > 0).map((p) => p.spend / p.clicks);
  const median = cpcs.length ? cpcs.sort((a, b) => a - b)[Math.floor(cpcs.length / 2)] : null;
  const cpc = r.clicks ? r.spend / r.clicks : Infinity;
  const line = `${r.clicks} clicks for ${r.spend.toFixed(2)} (cost per click ${Number.isFinite(cpc) ? cpc.toFixed(2) : "—"}${median ? `, others ${median.toFixed(2)}` : ""}), hook rate ${pct(r.videoViews / Math.max(1, r.impressions))}`;
  if (["ready", "live"].includes(c.status) && (r.clicks === 0 || (median && cpc > median * 1.6))) {
    return { notes: [], proposals: [await propose(by, `Pause "${c.title}"`, "Clearly behind the other campaigns.", [line, "Pausing stops spend now; you can resume it from the calendar."],
      { kind: "pause", ad_campaign_ids: [c.id] }, { table: "ad_campaigns", id: c.id })] };
  }
  if (c.status === "live" && median && cpc < median * 0.7) {
    const daily = Math.round(c.daily_budget * 1.3);
    return { notes: [], proposals: [await propose(by, `Give "${c.title}" more budget`, `${c.daily_budget} → ${daily}/day and 3 more days (+30%, the usual safe step so Meta's learning isn't reset).`,
      [line, `Extra spend ≈ ${((daily - c.daily_budget) * Math.max(0, daysLeft(c)) + daily * 3).toFixed(2)}.`],
      { kind: "set_budget", ad_campaign_id: c.id, daily_budget: daily, extend_days: 3 }, { table: "ad_campaigns", id: c.id })] };
  }
  return { proposals: [], notes: [`Holding: ${line}.`] };
}
const daysLeft = (c: AdCampaign) => Math.max(0, Math.round((Date.parse(c.ends_on) - Date.parse(hstToday())) / 86_400_000) + 1);

/** Improve on an Instagram post: if it beats your median, propose screening it as an ads-only promotion. */
export async function improvePost(igMediaId: string, caption: string, by: string): Promise<ImproveResult> {
  const m = metaAds();
  if (!m) return { proposals: [], notes: ["Meta isn't connected."] };
  if ((await pending(igMediaId)).length) return { proposals: [], notes: ["A proposal for this post is already waiting in Decide."] };
  const running = (await getRepo().list("ad_campaigns")).find((c) => creativesOf(c).some((x) => x.ig_media_id === igMediaId) && ["building", "ready", "live", "paused"].includes(c.status));
  if (running) return improveCampaign(running.id, by); // already promoted: improve that campaign instead of promoting twice
  const r = await m.reelResults(igMediaId);
  const rate = r.reach ? (r.saves + r.shares) / r.reach : 0;
  const plan = await planFor(2);
  const daily = plan.screen_daily, days = plan.screen_days;
  return { notes: [], proposals: [await propose(by, `Promote this post as a ${days}-day ads test`, `${daily} ${plan.currency}/day × ${days} days = ${daily * days} ${plan.currency}, promoting the post as-is (no new post).`,
    [`Organic so far: ${r.reach} reach, ${r.saves} saves, ${r.shares} shares (${pct(rate)} saves+shares/reach)`, `Free to spend now: ${plan.usable?.toFixed(2) ?? "unknown"} ${plan.currency}`, caption.slice(0, 140)],
    { kind: "promote_post", ig_media_id: igMediaId, caption: caption.slice(0, 500), daily_budget: daily, days }, { table: null, id: igMediaId })] };
}

// ---------------------------------------------------------------- doing it (after approval)

/** New ads-only campaign for a test step, tied to the approving proposal so buildCampaign accepts it. */
async function newCampaign(a: Approval, o: { title: string; text: string; headline: string; creative: AdCampaign["creative"]; daily: number; days: number }): Promise<AdCampaign> {
  const today = hstToday();
  const c: AdCampaign = {
    id: `ad-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, title: o.title, concept_id: null, objective: defaultObjective(),
    starts_on: today, ends_on: addDays(today, o.days - 1), daily_budget: o.daily,
    countries: (process.env.META_COUNTRIES || "US").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean), age_min: 18, age_max: 65,
    primary_text: o.text, headline: o.headline.slice(0, 40), cta: "DOWNLOAD", link: process.env.META_DEFAULT_LINK || "",
    creative: o.creative, status: "pending_approval", approval_id: a.id, meta: {}, created_at: now(), updated_at: now(),
  };
  if (!/^https:\/\//.test(c.link)) throw new Error("Set META_DEFAULT_LINK (your App Store / website link) in apps/web/.env.local first");
  await getRepo().insert("ad_campaigns", [c]);
  return buildCampaign(c.id);
}

export async function runProposal(a: Approval): Promise<void> {
  const action = (a.preview as { action?: ProposalAction }).action;
  const repo = getRepo();
  const done = (result: Record<string, unknown>) => repo.update("approvals", { id: a.id }, { status: "executed", result });
  try {
    if (!action) throw new Error("Proposal has no action");
    const m = metaAds();
    if (!m) throw new Error("Meta isn't connected");

    if (action.kind === "post_trials") {
      const t = await getTest(action.test_id);
      const posted: string[] = [];
      for (const c of t.candidates.filter((x) => action.candidate_ids.includes(x.id) && !x.trial?.media_id)) {
        try {
          const { postTrial } = await import("./trial-cap");
          const { publishTrialReel } = await import("./trial-share");
          const r = await postTrial(async () => publishTrialReel(m, await media(c.creative.job_id, c.creative.file), c.caption));
          c.trial = { media_id: r.mediaId, permalink: r.permalink, posted_at: now(), error: null };
          posted.push(c.label);
        } catch (e) {
          c.trial = { ...(c.trial ?? {}), error: (e as Error).message };
        }
        await saveTest(t);
      }
      await saveTest(t, `Posted ${posted.length} trial reels.`);
      const failed = t.candidates.filter((c) => action.candidate_ids.includes(c.id) && c.trial?.error);
      if (!posted.length && failed.length) throw new Error(failed[0].trial!.error!);
      return void (await done({ posted, failed: failed.map((c) => ({ label: c.label, error: c.trial!.error })) }));
    }

    if (action.kind === "advance_screen") {
      const t = await getTest(action.test_id);
      const picks = t.candidates.filter((c) => action.candidate_ids.includes(c.id));
      await assertAffordable(action.daily_budget * action.days * picks.length);
      for (const c of picks) {
        const built = await newCampaign(a, { title: `${t.name} · screen · ${c.label}`, text: c.caption, headline: c.hook, creative: c.creative, daily: action.daily_budget, days: action.days });
        c.screen = { ad_campaign_id: built.id };
        c.status = "advanced";
        if (built.status === "failed") throw new Error(built.meta.error ?? "build failed");
      }
      for (const c of t.candidates.filter((x) => !action.candidate_ids.includes(x.id))) c.status = "dropped";
      t.stage = "screen";
      await saveTest(t, `Screening ${picks.length} as ads: ${picks.map((c) => c.label).join(", ")}.`);
      return void (await done({ campaigns: picks.map((c) => c.screen?.ad_campaign_id) }));
    }

    if (action.kind === "advance_scale") {
      const t = await getTest(action.test_id);
      const extra = action.winners.reduce((s, w) => s + w.daily_budget * action.days, 0);
      await assertAffordable(extra);
      for (const w of action.winners) {
        const c = t.candidates.find((x) => x.id === w.candidate_id)!;
        const camp = await getCampaign(c.screen!.ad_campaign_id!);
        await scaleCampaign(camp, w.daily_budget, action.days);
        c.scale = { ad_campaign_id: camp.id };
      }
      for (const id of action.losers) {
        const c = t.candidates.find((x) => x.id === id);
        if (c?.screen?.ad_campaign_id) await setPaused(c.screen.ad_campaign_id, true).catch(() => null);
        if (c) c.status = "dropped";
      }
      t.stage = "scale";
      await saveTest(t, `Scaling ${action.winners.length}; paused ${action.losers.length}.`);
      return void (await done({ scaled: action.winners.length, paused: action.losers.length }));
    }

    if (action.kind === "set_budget") {
      const c = await getCampaign(action.ad_campaign_id);
      await assertAffordable((action.daily_budget - c.daily_budget) * daysLeft(c) + action.daily_budget * action.extend_days);
      await scaleCampaign(c, action.daily_budget, daysLeft(c) + action.extend_days);
      return void (await done({ daily_budget: action.daily_budget }));
    }

    if (action.kind === "opt_apply") {
      const { applyPending } = await import("./optimize"); // optimize.ts imports this file's neighbours
      return void (await done({ detail: await applyPending(action.key) }));
    }

    if (action.kind === "pause") {
      for (const id of action.ad_campaign_ids) await setPaused(id, true);
      return void (await done({ paused: action.ad_campaign_ids.length }));
    }

    if (action.kind === "post_trial_video") {
      const { launchVideo } = await import("./launch"); // launch.ts imports this file
      const r = await launchVideo({ job_id: action.job_id, variant_id: action.variant_id, dest: "trial", caption: action.caption }, a.decided_by ?? "autopilot");
      return void (await done({ detail: r.detail }));
    }

    if (action.kind === "rotate_ads") {
      const { runRotation } = await import("./ad-rotation");
      return void (await done(await runRotation(action)));
    }

        if (action.kind === "post_trials_batch") {
      const { launchVideo } = await import("./launch");
      const posted: string[] = [], failed: { id: string; error: string }[] = [];
      for (const x of action.items) {
        try { await launchVideo({ job_id: x.job_id, variant_id: x.variant_id, dest: "trial", caption: x.caption }, a.decided_by ?? "autopilot"); posted.push(`${x.job_id}/${x.variant_id}`); }
        catch (e) { failed.push({ id: `${x.job_id}/${x.variant_id}`, error: (e as Error).message }); }
      }
      if (!posted.length && failed.length) throw new Error(failed[0].error);
      return void (await done({ posted, failed }));
    }

        if (action.kind === "promote_post") {
      await assertAffordable(action.daily_budget * action.days);
      const built = await newCampaign(a, {
        title: `Promote IG post ${action.ig_media_id.slice(-6)}`, text: action.caption, headline: action.caption.split("\n")[0] || BRAND.name,
        creative: { job_id: "", variant_id: "", file: "", poster: null, ig_media_id: action.ig_media_id }, daily: action.daily_budget, days: action.days,
      });
      if (built.status === "failed") throw new Error(built.meta.error ?? "build failed");
      return void (await done({ ad_campaign_id: built.id }));
    }
  } catch (e) {
    await repo.update("approvals", { id: a.id }, { status: "failed", result: { error: (e as Error).message } });
  }
}

/**
 * Lower a live campaign's daily budget, keeping its dates. Lowering only: a raise still goes through Decide as a proposal.
 */
export async function lowerBudget(id: string, daily: number): Promise<AdCampaign> {
  const c = await getCampaign(id);
  if (!metaAds() || !c.meta.campaign_id) throw new Error("Not built in Meta yet");
  if (!["live", "ready", "paused"].includes(c.status)) throw new Error(`Can't change the budget of a campaign that is ${c.status}`);
  if (!(daily > 0) || daily >= c.daily_budget) throw new Error(`The new budget must be above 0 and below ${c.daily_budget}/day (raises go through Decide)`);
  const m = metaAds()!;
  const acct = await m.account();
  const sets = c.meta.adsets ? Object.values(c.meta.adsets) : c.meta.adset_id ? [c.meta.adset_id] : [];
  if (c.meta.waves) {
    await getRepo().update("ad_campaigns", { id: c.id }, { daily_budget: daily, updated_at: now() });
    const { rebudget } = await import("./waves");
    await rebudget({ ...c, daily_budget: daily });
  } else {
    for (const s of sets) await m.updateAdSet(s, { dailyBudgetMinor: Math.round((daily / sets.length) * (acct.currency === "JPY" ? 1 : 100)) });
    await getRepo().update("ad_campaigns", { id: c.id }, { daily_budget: daily, updated_at: now() });
  }
  return getCampaign(id);
}

/** Raise (or set) a built campaign's daily budget and run it `days` more from today. */
async function scaleCampaign(c: AdCampaign, daily: number, days: number) {
  const m = metaAds()!;
  const acct = await m.account();
  const end = addDays(hstToday(), Math.max(1, days) - 1);
  // a campaign split by feature shares the new budget evenly over its ad sets
  const sets = c.meta.adsets ? Object.values(c.meta.adsets) : c.meta.adset_id ? [c.meta.adset_id] : [];
  if (c.meta.waves) {
    // a waves launch: the new total is split between Winners and the feature ad sets, never over what was approved
    for (const id of sets) await m.updateAdSet(id, { endTime: `${end}T23:59:00${tzSuffix()}` });
    await getRepo().update("ad_campaigns", { id: c.id }, { daily_budget: daily, ends_on: end, updated_at: now() });
    const { rebudget } = await import("./waves");
    await rebudget({ ...c, daily_budget: daily, ends_on: end });
  } else {
    for (const id of sets) await m.updateAdSet(id, { dailyBudgetMinor: Math.round((daily / sets.length) * (acct.currency === "JPY" ? 1 : 100)), endTime: `${end}T23:59:00${tzSuffix()}` });
    await getRepo().update("ad_campaigns", { id: c.id }, { daily_budget: daily, ends_on: end, updated_at: now() });
  }
  if (c.status === "paused") await setPaused(c.id, false);
}
