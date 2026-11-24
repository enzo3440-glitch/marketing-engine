// Deterministic 90-day mock dataset for every ops table. Used by the web app when Supabase is not
// configured, and by scripts/seed.ts to fill a fresh Supabase project.
import { tzOffsetMs } from "./tz";
import { cmoCampaigns, cmoContentItems, cmoHooks, cmoRecommendations, cmoRefs, loadCmoExport, loadMarketingMapSeed } from "./cmo";
import { apiBudgets, projectMonthEnd } from "./compute";
import type {
  AdCampaign, AdvisorEvent, AgentRun, GrowthTest, ApiSpend, Approval, BuildItem, CalendarEvent, Campaign, CampaignDaily, CapitalContact,
  CmoRecommendation, ContentItem, Deploy, FinActual, FinScenario, InboxItem, Incident, Integration,
  MarketingMap, MetricDaily, ReelClip, ReelHook, ReelJob, ReelPost, ReelRef, ReelVariant,
} from "./types";

export interface Dataset {
  integrations: Integration[];
  metrics_daily: MetricDaily[];
  api_spend: ApiSpend[];
  incidents: Incident[];
  approvals: Approval[];
  campaigns: Campaign[];
  campaign_daily: CampaignDaily[];
  content_items: ContentItem[];
  build_items: BuildItem[];
  capital_contacts: CapitalContact[];
  fin_actuals: FinActual[];
  fin_scenarios: FinScenario[];
  calendar_events: CalendarEvent[];
  inbox_items: InboxItem[];
  agent_runs: AgentRun[];
  deploys: Deploy[];
  reel_clips: ReelClip[];
  reel_hooks: ReelHook[];
  reel_jobs: ReelJob[];
  reel_variants: ReelVariant[];
  reel_posts: ReelPost[];
  reel_refs: ReelRef[];
  cmo_recommendations: CmoRecommendation[];
  advisor_events: AdvisorEvent[];
  ad_campaigns: AdCampaign[];
  growth_tests: GrowthTest[];
  cmo_snapshot: { observed_at: string | null; exported_at: string | null; snapshot: unknown } | null;
  marketing_map: MarketingMap;
}

export const PROVIDERS = [
  "anthropic", "railway", "supabase", "sentry", "google_cloud", "app_store_connect", "meta", "tiktok",
  "google_workspace", "github", "reel_engine",
] as const;

export const AGENTS = [
  "spendWatcher", "infraWatcher", "crashTriage", "growthAnalyst", "cmo", "financeModeler", "inboxScout", "executor",
] as const;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HST_OFFSET_MS = tzOffsetMs();
/** YYYY-MM-DD on the desk clock (DESK_TIMEZONE). */
export function hstDate(d: Date): string {
  return new Date(d.getTime() + HST_OFFSET_MS).toISOString().slice(0, 10);
}
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** A desk-clock wall time as an ISO instant. */
const hstAt = (date: string, hh: number, mm = 0) =>
  new Date(Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`) - HST_OFFSET_MS).toISOString();

let uuidCounter = 0;
const uuid = (r: () => number) => {
  const h = () => Math.floor(r() * 16).toString(16);
  uuidCounter++;
  return `${Array.from({ length: 8 }, h).join("")}-${Array.from({ length: 4 }, h).join("")}-4${Array.from({ length: 3 }, h).join("")}-a${Array.from({ length: 3 }, h).join("")}-${uuidCounter.toString(16).padStart(12, "0")}`;
};

export function buildMockDataset(now = new Date()): Dataset {
  const r = rng(20261025);
  const today = hstDate(now);
  const days = Array.from({ length: 90 }, (_, i) => addDays(today, i - 89));
  const nowIso = now.toISOString();

  // Growth curve --------------------------------------------------------------
  const metrics: MetricDaily[] = [];
  let mau = 3100, paid = 290;
  for (const [i, date] of days.entries()) {
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 1.25 : 1;
    const signups = Math.round((38 + i * 0.55 + r() * 22) * weekend);
    const conversions = Math.round(signups * (0.045 + r() * 0.02));
    const churned = Math.round(paid * (0.0016 + r() * 0.001));
    paid += conversions - churned;
    mau = Math.round(mau * 1.0028 + signups * 0.35 - r() * 8);
    const dau = Math.round(mau * (0.14 + r() * 0.03) * weekend);
    const installs = Math.round(signups * (1.18 + r() * 0.12));
    metrics.push(
      { date, metric: "dau", value: dau, source: "supabase" },
      { date, metric: "mau", value: mau, source: "supabase" },
      { date, metric: "signups", value: signups, source: "supabase" },
      { date, metric: "paid_conversions", value: conversions, source: "app_store_connect" },
      { date, metric: "paid_subs", value: paid, source: "app_store_connect" },
      { date, metric: "mrr", value: Math.round(paid * 7.99 * 100) / 100, source: "app_store_connect" },
      { date, metric: "installs", value: installs, source: "app_store_connect" },
    );
  }

  // API spend -------------------------------------------------------------------
  const api_spend: ApiSpend[] = [];
  for (const [i, date] of days.entries()) {
    const ramp = 1 + i / 160;
    const opusIn = Math.round((2.6e6 + r() * 1.4e6) * ramp), opusOut = Math.round(opusIn * 0.12);
    const haikuIn = Math.round((9e6 + r() * 4e6) * ramp), haikuOut = Math.round(haikuIn * 0.08);
    api_spend.push(
      { date, provider: "anthropic", model: "claude-opus-5-5", tokens_in: opusIn, tokens_out: opusOut, cost_usd: +(opusIn * 4e-6 + opusOut * 20e-6).toFixed(4) },
      { date, provider: "anthropic", model: "claude-haiku-5-5", tokens_in: haikuIn, tokens_out: haikuOut, cost_usd: +(haikuIn * 0.1e-6 + haikuOut * 0.5e-6).toFixed(4) },
      { date, provider: "google", model: "places-api", tokens_in: 0, tokens_out: 0, cost_usd: +((5.5 + r() * 3) * ramp).toFixed(4) },
      { date, provider: "google", model: "maps-javascript", tokens_in: 0, tokens_out: 0, cost_usd: +((1.2 + r() * 0.8) * ramp).toFixed(4) },
    );
  }

  // Campaigns ---------------------------------------------------------------------
  const campaigns: Campaign[] = [
    { id: "meta-1", platform: "meta", external_id: "000000000000001", name: "Discovery · app installs", status: "active", objective: "app_installs", meta: {} },
    { id: "meta-2", platform: "meta", external_id: "000000000000002", name: "Brand story · follows", status: "active", objective: "instagram_follows", meta: {} },
    { id: "meta-3", platform: "meta", external_id: "000000000000003", name: "Retarget · site visitors", status: "paused", objective: "conversions", meta: {} },
    { id: "tt-1", platform: "tiktok", external_id: "000000000000011", name: "Insider tips · Spark", status: "active", objective: "app_installs", meta: {} },
    { id: "tt-2", platform: "tiktok", external_id: "000000000000012", name: "Expert vs beginner contrast", status: "active", objective: "reach", meta: {} },
  ];
  const campaign_daily: CampaignDaily[] = [];
  for (const [i, date] of days.entries()) {
    for (const c of campaigns) {
      if (c.status === "paused" && i > 60) continue;
      const base = c.platform === "meta" ? 18 : 12;
      const spend = +(base * (0.7 + r() * 0.6) * (1 + i / 180)).toFixed(2);
      const cpm = c.platform === "meta" ? 7 + r() * 4 : 4 + r() * 3;
      const impressions = Math.round((spend / cpm) * 1000);
      const clicks = Math.round(impressions * (0.008 + r() * 0.008));
      const installs = Math.round(clicks * (0.12 + r() * 0.1));
      campaign_daily.push({ campaign_id: c.id, date, spend, impressions, clicks, installs });
    }
  }

  // Incidents --------------------------------------------------------------------
  const crash = (title: string, file: string, sev: Incident["severity"], occ: number, users: number, ageDays: number, status: Incident["status"], fix?: boolean): Incident => ({
    id: uuid(r), source: "sentry", severity: sev, title, body: `${title}\n  at ${file}`,
    payload: { culprit: file, platform: "react-native", release: "acme@1.8.2+214" },
    fingerprint: `sentry:${title.toLowerCase().replace(/\W+/g, "-").slice(0, 48)}`, occurrences: occ, users_affected: users,
    status, first_seen: hstAt(addDays(today, -ageDays), 9), last_seen: hstAt(addDays(today, -Math.min(ageDays, 1)), 14),
    resolved_at: status === "resolved" ? hstAt(today, 8) : null,
    proposed_fix: fix ? {
      summary: `Guard against undefined place data before rendering in ${file.split("/").pop()}.`,
      diff: `--- a/${file}\n+++ b/${file}\n@@ -41,7 +41,9 @@ export function PlaceCard({ place }: Props) {\n-  const hero = place.photos[0].url;\n+  const hero = place.photos?.[0]?.url;\n+  if (!hero) return <PlaceCardSkeleton />;\n   return (\n     <Card>\n`,
    } : null,
  });
  const incidents: Incident[] = [
    crash("TypeError: Cannot read property 'url' of undefined", "src/components/PlaceCard.tsx", "critical", 412, 187, 3, "fix_proposed", true),
    crash("Unhandled promise rejection: Network request failed", "src/lib/api/places.ts", "error", 96, 61, 6, "triaged"),
    crash("RangeError: Maximum call stack size exceeded", "src/screens/MapScreen.tsx", "error", 23, 9, 2, "open"),
    crash("Invariant Violation: VirtualizedList key collision", "src/screens/FeedScreen.tsx", "warn", 51, 44, 12, "open"),
    crash("SIGABRT in ExpoLocation", "ios/Pods/ExpoLocation", "critical", 8, 8, 1, "open"),
    crash("Supabase auth refresh 401 loop", "src/lib/supabase.ts", "error", 140, 72, 20, "resolved"),
    { id: uuid(r), source: "railway", severity: "error", title: "Deploy failed: acme-api (build exited 1)", body: "pnpm install --frozen-lockfile failed: lockfile out of date", payload: { service: "acme-api" }, fingerprint: "railway:deploy:acme-api:5", occurrences: 1, users_affected: 0, status: "open", proposed_fix: null, first_seen: hstAt(addDays(today, -1), 16), last_seen: hstAt(addDays(today, -1), 16), resolved_at: null },
  ];
  // Spend alert from the same projection the Spend Watcher uses.
  for (const [provider, budget] of Object.entries(apiBudgets())) {
    const p = projectMonthEnd(api_spend, today, budget, provider);
    if (p.overPct > 0.2) {
      incidents.push({
        id: uuid(r), source: "spend", severity: p.overPct > 0.5 ? "critical" : "warn", title: `${provider} projected month-end ${(p.overPct * 100).toFixed(0)}% over plan`,
        body: `MTD $${p.monthToDate.toFixed(0)}; trailing 7-day avg $${p.trailing7Avg.toFixed(2)}/day, projected $${p.projected.toFixed(0)} vs $${budget} budget`,
        payload: {}, fingerprint: `spend:${provider}:${today.slice(0, 7)}`, occurrences: 1, users_affected: 0, status: "open", proposed_fix: null,
        first_seen: hstAt(today, 6), last_seen: hstAt(today, 6), resolved_at: null,
      });
    }
  }

  // Approvals --------------------------------------------------------------------
  const approvals: Approval[] = [
    { id: uuid(r), type: "fix_pr", ref_table: "incidents", ref_id: incidents[0].id, title: "Fix PR: guard undefined place photos", summary: incidents[0].proposed_fix!.summary, preview: { diff: incidents[0].proposed_fix!.diff, branch: `fix/${incidents[0].id}` }, status: "pending", created_by_agent: "crashTriage", decided_by: null, decided_at: null, result: null, created_at: hstAt(today, 5, 40) },
    { id: uuid(r), type: "post", ref_table: "content_items", ref_id: "draft-1", title: "Reel: The 6am routine, before anyone else", summary: "Cinematic one-shot, hook test h3 vs h1. Bare cut for trending sound.", preview: { caption: "The quiet hour before the crowds. The light only does this for 20 minutes.\n\n#acme #example", platform: "instagram" }, status: "pending", created_by_agent: "cmo", decided_by: null, decided_at: null, result: null, created_at: hstAt(today, 7, 2) },
    { id: uuid(r), type: "outreach_email", ref_table: "capital_contacts", ref_id: "cc-3", title: "Follow-up: investor demo day", summary: "Draft follow-up with October metrics and deck link.", preview: { to: "partner@example.vc", subject: "Acme · October update", body: "Hi Sam,\n\nQuick update since demo day: MAU up 18%, paid subs past 400…" }, status: "pending", created_by_agent: "capital", decided_by: null, decided_at: null, result: null, created_at: hstAt(addDays(today, -1), 15) },
    { id: uuid(r), type: "other", ref_table: null, ref_id: null, title: "Morning growth brief", summary: "Signups +9% WoW. TikTok Spark CPI $1.84 vs Meta $2.61. Spend→signup correlation peaks at 2-day lag (r=0.41).", preview: {}, status: "pending", created_by_agent: "growthAnalyst", decided_by: null, decided_at: null, result: null, created_at: hstAt(today, 6) },
    { id: uuid(r), type: "ad_change", ref_table: "campaigns", ref_id: "meta-3", title: "Pause retargeting ad set (CPI 2.4× blended)", summary: "Proposed by growth analyst; executor stub only logs.", preview: { campaign: "Retarget · site visitors", change: "pause" }, status: "approved", created_by_agent: "growthAnalyst", decided_by: null, decided_at: hstAt(addDays(today, -2), 9), result: null, created_at: hstAt(addDays(today, -2), 6) },
  ];

  // Content (migrated CMO data first; synthetic only when the private export is absent) ---------
  const cmo = loadCmoExport();
  const map = loadMarketingMapSeed();
  const content_items: ContentItem[] = cmo ? cmoContentItems(cmo.snapshot) : Array.from({ length: 24 }, (_, i) => ({
    id: `ig-mock-${i}`, platform: i % 3 === 0 ? "tiktok" : "instagram", kind: "reel", status: "posted",
    title: ["Morning routine", "Hidden shortcut", "Coffee crawl", "Behind the scenes"][i % 4],
    caption: null, media_url: null, scheduled_at: null, posted_at: hstAt(addDays(today, -i * 3 - 1), 17),
    views: Math.round(800 + r() * 9000), likes: Math.round(30 + r() * 400), saves: Math.round(5 + r() * 80),
    shares: Math.round(2 + r() * 60), attributed_signups: Math.round(r() * 12), source: "mock", meta: {},
  }) as ContentItem);
  content_items.push(
    { id: "draft-1", platform: "instagram", kind: "reel", status: "draft", title: "The 6am routine, before anyone else", caption: "The quiet hour before the crowds.", media_url: null, scheduled_at: hstAt(addDays(today, 1), 17), posted_at: null, views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: "cmo", meta: {} },
    { id: "sched-1", platform: "tiktok", kind: "trial_reel", status: "scheduled", title: "Expert vs beginner: weekend edition", caption: null, media_url: null, scheduled_at: hstAt(addDays(today, 2), 18), posted_at: null, views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: "desk", meta: {} },
    { id: "idea-1", platform: "instagram", kind: "reel", status: "idea", title: "The doorway you almost missed", caption: null, media_url: null, scheduled_at: null, posted_at: null, views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: "cmo", meta: {} },
    { id: "appr-1", platform: "instagram", kind: "post", status: "approved", title: "Carousel: 5 ideas for a rainy weekend", caption: null, media_url: null, scheduled_at: hstAt(addDays(today, 3), 9), posted_at: null, views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: "desk", meta: {} },
  );
  const paidImport = cmo ? cmoCampaigns(cmo.snapshot) : { campaigns: [], daily: [] };
  campaigns.push(...paidImport.campaigns);

  // Reel Engine: one finished stub job so gallery + leaderboard have data ------------------
  const reel_hooks = cmoHooks(cmo?.snapshot, map, nowIso);
  const reel_clips: ReelClip[] = [
    { id: "c1", file: "drone_beach.mp4", source: "upload", kind: "broll", star: true, tags: ["drone", "beach"], thumb: null, quality: 0.86, duration: 24.1, talking_likely: false, added_at: hstAt(addDays(today, -4), 10) },
    { id: "c2", file: "forest_walk.mp4", source: "upload", kind: "oneshot", star: false, tags: ["hike"], thumb: null, quality: 0.74, duration: 41.5, talking_likely: false, added_at: hstAt(addDays(today, -4), 10) },
    { id: "c3", file: "app_demo.mp4", source: "upload", kind: "talking", star: false, tags: ["app", "talking"], thumb: null, quality: 0.68, duration: 32.0, talking_likely: true, added_at: hstAt(addDays(today, -3), 12) },
    { id: "c4", file: "mural_doorway.mp4", source: "upload", kind: "broll", star: true, tags: ["art", "reveal"], thumb: null, quality: 0.81, duration: 18.7, talking_likely: false, added_at: hstAt(addDays(today, -3), 12) },
  ];
  const jobId = `example-${addDays(today, -3)}`;
  const testHooks = reel_hooks.slice(0, 3);
  const formats = ["montage", "oneshot", "pov"];
  const reel_variants: ReelVariant[] = [];
  formats.forEach((fmt) => testHooks.forEach((h) => {
    reel_variants.push({
      id: `${fmt}-${h.id}-1`, job_id: jobId, format: fmt, hook_id: h.id, hook: h.text, grade: fmt === "pov" ? "film" : "teal_orange",
      music: "synth:cinematic", file: null, bare: null, poster: null,
      caption: `${h.text}\n\n#acme #example`, duration: fmt === "oneshot" ? 8 : 12,
      warnings: [], tags: { format: fmt, hook_id: h.id, grade: fmt === "pov" ? "film" : "teal_orange", music: "synth:cinematic", pacing: "fast" }, picked: false,
    });
  }));
  const reel_jobs: ReelJob[] = [{
    job_id: jobId, status: "done", created_at: hstAt(addDays(today, -3), 13), stub: true, error: null,
    request: { job_id: jobId, clips: reel_clips.map((c) => ({ id: c.id, path: c.file, star: c.star })), defaults: { duration: 12, music: "synth:cinematic", endcard: true, hashtags: ["acme"] }, matrix: { formats, hooks: testHooks.map((h) => ({ id: h.id, text: h.text })), grades: ["teal_orange", "film"], max: 12 } },
    manifest: { job_id: jobId, variants: reel_variants.map((v) => ({ id: v.id, format: v.format, hook: v.hook, duration: v.duration, tags: v.tags })), stub: true },
  }];
  // Posts across all three formats so the leaderboard compares them.
  const posted = [0, 1, 3, 4, 6, 7].map((i) => reel_variants[i]);
  const reel_posts: ReelPost[] = posted.map((v, i) => ({
    id: i + 1, job_id: jobId, variant_id: v.id, platform: i % 2 ? "tiktok" : "ig", url: null, sound: i % 2 ? "trending: original sound – islandvibes" : null,
    posted_at: hstAt(addDays(today, -2), 17), views: Math.round(900 + r() * 6000), avg_watch_s: +(3 + r() * 6).toFixed(1),
    likes: Math.round(20 + r() * 300), comments: Math.round(r() * 20), shares: Math.round(r() * 60), saves: Math.round(r() * 90),
    follows: Math.round(r() * 25), updated_at: hstAt(today, 8),
  }));
  posted.forEach((v) => (v.picked = true));
  testHooks.forEach((h) => (h.status = "testing"));

  // Build / capital ------------------------------------------------------------------------
  const build_items: BuildItem[] = [
    ["feature", "Offline saved spots", "active", 1], ["feature", "Shareable trip lists", "backlog", 2], ["bug", "Map pins overlap at zoom 14", "active", 1],
    ["test", "Field test: low-signal mode", "backlog", 2], ["feature", "Paywall A/B: annual first", "active", 1], ["bug", "Android back button closes app on Explore", "backlog", 1],
    ["feature", "Sentry release tagging", "done", 1], ["test", "Field test: crowd filter", "done", 2], ["feature", "Push: daily reminder", "backlog", 3],
    ["bug", "Photo upload stalls on 3G", "active", 2], ["feature", "Streak badges", "backlog", 3], ["test", "Accessibility pass (VoiceOver)", "backlog", 2],
  ].map(([kind, title, status, priority], i) => ({ id: `b${i + 1}`, kind, title, status, priority, notes: null }) as BuildItem);

  const capital_contacts: CapitalContact[] = [
    ["Sam Carter", "Example Ventures", "investor", "follow_up"], ["Pat Morgan", "Example Tourism Board", "partnership", "meeting_set"],
    ["Marcus Chen", "Sample Capital", "investor", "intro_requested"], ["Dana Okoro", "Example Accelerator", "investor", "pitched"],
    ["Sam Ruiz", "Example Hotels", "partnership", "negotiating"], ["Priya Shah", "Former marketplace founder", "mentor", "active"],
    ["Alex Rivera", "Example Coffee Co", "warm", "intro_requested"], ["Jordan Lee", "Creator, 410k", "hit", "drafted"],
    ["Ava Lindqvist", "Example Guides", "partnership", "cold"], ["Ben Torres", "Angel", "investor", "committed"],
    ["Mia Tan", "Example Airlines", "partnership", "cold"], ["Chris Doe", "Local university entrepreneurship", "mentor", "active"],
  ].map(([name, org, segment, stage], i) => ({ id: `cc-${i + 1}`, name, org, segment, stage, last_touch: addDays(today, -Math.floor(r() * 40)), notes: null }) as CapitalContact);

  // Finance: 12 months of actuals --------------------------------------------------------------
  const fin_actuals: FinActual[] = [];
  let cash = 312000;
  for (let m = 11; m >= 0; m--) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - m);
    const k = 11 - m;
    const subs = Math.round(150 * Math.pow(1.065, k));
    const revenue = +(subs * 7.99).toFixed(2);
    const ad = Math.round(1100 + k * 160), api = Math.round(1500 + k * 210), infra = Math.round(310 + k * 22);
    const payroll = 9000, other = Math.round(1400 + r() * 500);
    cash = cash + revenue - ad - api - infra - payroll - other;
    fin_actuals.push({ month: d.toISOString().slice(0, 10), revenue, paid_subs: subs, mau: Math.round(1600 * Math.pow(1.07, k)), ad_spend: ad, api_spend: api, infra_spend: infra, payroll, other_opex: other, cash_end: Math.round(cash) });
  }
  const fin_scenarios: FinScenario[] = [
    { id: "base", name: "Base", assumptions: { growth_rate: 0.07, conversion: 0.09, arpu: 7.99, cac: 24, churn: 0.05, opex_growth: 0.015 } },
    { id: "upside", name: "Upside", assumptions: { growth_rate: 0.12, conversion: 0.11, arpu: 8.99, cac: 19, churn: 0.04, opex_growth: 0.02 } },
    { id: "downside", name: "Downside", assumptions: { growth_rate: 0.03, conversion: 0.07, arpu: 7.49, cac: 32, churn: 0.07, opex_growth: 0.01 } },
  ];

  // Calendar + inbox ---------------------------------------------------------------------------
  const calendar_events: CalendarEvent[] = [];
  const meetingTitles = ["Team standup", "Investor call", "Creator sync", "Partnership review", "Build review", "Growth sync", "Dentist", "Gym"];
  for (let d = -3; d <= 7; d++) {
    const date = addDays(today, d);
    const n = 1 + Math.floor(r() * 3);
    for (let j = 0; j < n; j++) {
      const title = meetingTitles[Math.floor(r() * meetingTitles.length)];
      const hh = 8 + Math.floor(r() * 9);
      calendar_events.push({ id: `ev-${date}-${j}`, external_id: null, title, starts_at: hstAt(date, hh), ends_at: hstAt(date, hh, 45), attendees: ["owner@example.com"], is_own: !["Dentist", "Gym"].includes(title) });
    }
  }
  calendar_events.push({ id: `ev-${today}-am`, external_id: null, title: "Team standup", starts_at: hstAt(today, 9), ends_at: hstAt(today, 9, 20), attendees: ["owner@example.com", "eng@example.com"], is_own: true });
  const inbox_items: InboxItem[] = [
    ["Apple App Store", "Your submission was approved: Acme 1.8.3", 3], ["Sam Carter", "Re: October update", 3], ["Meta for Business", "Your ad account spend limit is approaching", 2],
    ["Pat Morgan", "Pilot: next steps + data sharing", 3], ["Railway", "Usage alert: acme-api reached 80% of plan", 2], ["Jordan Lee", "Collab dates for November?", 2],
    ["Stripe", "Payout of $2,904.11 is on its way", 1], ["Sentry", "Weekly report: 3 new issues", 1],
  ].map(([sender, subject, importance], i) => ({ id: `in-${i + 1}`, thread_id: `t-${i + 1}`, sender: sender as string, subject: subject as string, snippet: "", importance: importance as number, received_at: hstAt(addDays(today, -Math.floor(i / 3)), 8 + i) }));

  // Agent runs, deploys, integrations -----------------------------------------------------------
  const agent_runs: AgentRun[] = AGENTS.map((agent, i) => ({
    id: uuid(r), agent, started_at: new Date(now.getTime() - (i + 1) * 17 * 60_000).toISOString(),
    finished_at: new Date(now.getTime() - (i + 1) * 17 * 60_000 + 9000).toISOString(),
    status: agent === "inboxScout" ? "failed" : "ok", log: agent === "inboxScout" ? "google_workspace not configured (mock mode)" : "mock run",
  }));
  const deploys: Deploy[] = Array.from({ length: 12 }, (_, i) => ({
    id: `dep-${i + 1}`, service: ["acme-api", "acme-web", "engine-web", "engine-worker"][i % 4],
    status: i === 1 ? "failed" : "success", commit_message: ["fix: place card guard", "feat: paywall annual-first", "chore: deps", "feat: sentry webhooks", "fix: map clustering", "feat: offline saved"][i % 6],
    created_at: new Date(now.getTime() - i * 9.5 * 3600_000).toISOString(),
  }));
  const integrations: Integration[] = PROVIDERS.map((provider) => ({ provider, status: "not_configured", last_sync_at: null, last_error: null, config: {} }));

  return {
    integrations, metrics_daily: metrics, api_spend, incidents, approvals, campaigns, campaign_daily, content_items,
    build_items, capital_contacts, fin_actuals, fin_scenarios, calendar_events, inbox_items, agent_runs, deploys,
    reel_clips, reel_hooks, reel_jobs, reel_variants, reel_posts, reel_refs: cmo ? cmoRefs(cmo.snapshot, nowIso) : [],
    cmo_recommendations: cmo ? cmoRecommendations(cmo.snapshot, nowIso) : [],
    advisor_events: [],
    ad_campaigns: [],
    growth_tests: [],
    cmo_snapshot: cmo ? { observed_at: cmo.observedAt, exported_at: cmo.exportedAt, snapshot: cmo.snapshot } : null,
    marketing_map: { id: "main", revision: 1, doc: map, updated_at: nowIso },
  };
}
