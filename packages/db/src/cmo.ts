// Migration of the CMO Desk export (Reel Radar snapshot + watchlist research) and the
// Marketing Whiteboard seed into ops tables. Pure mapping; callers decide whether to write to Supabase
// (scripts/import-cmo.ts) or serve from memory (mock repo).
import fs from "node:fs";
import path from "node:path";
import type { CampaignDaily, Campaign, CmoRecommendation, ContentItem, MarketingMapDoc, ReelHook, ReelRef } from "./types";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export function dataDir(): string {
  if (process.env.OPS_DATA_DIR) return process.env.OPS_DATA_DIR;
  const cands = [
    path.resolve(process.cwd(), "packages/db/data"),
    path.resolve(process.cwd(), "../../packages/db/data"),
    path.resolve(process.cwd(), "../packages/db/data"),
    path.resolve(process.cwd(), "data"),
  ];
  return cands.find((p) => fs.existsSync(path.join(p, "marketing-map.seed.json"))) ?? cands[0];
}

function readJson(rel: string): Json | null {
  const p = path.join(dataDir(), rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export interface CmoExport {
  exportedAt: string | null;
  observedAt: string | null;
  snapshot: Json;
}

/** Latest CMO snapshot with the separately exported watchlist research merged in (handoff: merge pending). */
export function loadCmoExport(): CmoExport | null {
  const wrap = readJson("private/radar-snapshot.json");
  if (!wrap?.snapshot) return null;
  const snapshot = { ...wrap.snapshot };
  const research = readJson("private/watchlist-research.json");
  if (research?.externalWatchlist) {
    snapshot.externalWatchlist = research.externalWatchlist;
    const known = new Set((snapshot.externalBaselines ?? []).map((b: Json) => b.id));
    snapshot.externalBaselines = [
      ...(snapshot.externalBaselines ?? []),
      ...(research.externalBaselines ?? []).filter((b: Json) => !known.has(b.id)),
    ];
  }
  return { exportedAt: wrap.exportedAt ?? null, observedAt: snapshot.observedAt ?? null, snapshot };
}

export function loadMarketingMapSeed(): MarketingMapDoc {
  const seed = readJson("marketing-map.seed.json");
  return seed ?? { version: 1, title: "Acme · Marketing Map", updatedAt: null, channels: [], nodes: [] };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const tzIso = (v: unknown) => typeof v === "string" && /(Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));

/** Precision implied by a rounded display like "60.6K" (→ 100) or "1.2M" (→ 100000). */
function displayPrecision(display: string | undefined): number {
  const m = /^([\d.,]+)\s*([KM])$/i.exec(display?.trim() ?? "");
  if (!m) return 1;
  const decimals = (m[1].split(".")[1] ?? "").length;
  return (m[2].toUpperCase() === "K" ? 1e3 : 1e6) / 10 ** decimals;
}

/**
 * Repeat view counts per post in the Marketing Advisor observation contract
 * (packages/advisor/src/core.mjs assertObservation). One canonical post URL per creative so the
 * advisor's momentum check treats the series as comparable; the raw collection URL is kept alongside.
 */
export function advisorObservations(r: Json): Json[] {
  if (!tzIso(r.publishedAt)) return [];
  const url = r.publicMetrics?.sourceUrl ?? `https://www.instagram.com/reel/${r.id}/`;
  const paid = r.paidStatus === "unknown" || !r.paidStatus ? "unknown" : /paid/i.test(r.paidStatus) ? "paid" : "unknown";
  return (r.observations ?? [])
    .map((o: Json, i: number) => ({ o, i }))
    .filter(({ o }: { o: Json }) => typeof o.views === "number" && tzIso(o.observedAt) && Date.parse(o.observedAt) >= Date.parse(r.publishedAt))
    .map(({ o, i }: { o: Json; i: number }) => {
      const approximate = Boolean(o.viewsApproximate);
      return {
        id: `${r.id}-views-${i}`, creativeId: r.id, sourceUrl: url, rawSourceUrl: o.sourceUrl ?? null, metric: "views", scope: "post_lifetime",
        paidStatus: paid, observedAt: o.observedAt, publishedAt: r.publishedAt, value: o.views, display: o.viewsDisplay ?? String(o.views),
        approximate, precision: approximate ? displayPrecision(o.viewsDisplay) : 1,
      };
    });
}

export function cmoContentItems(s: Json): ContentItem[] {
  return (s.reels ?? []).map((r: Json): ContentItem => ({
    id: `ig-${r.id}`,
    platform: "instagram",
    kind: r.type === "post" ? "post" : "reel",
    status: "posted",
    title: r.title ?? null,
    caption: r.caption ?? null,
    media_url: r.publicMetrics?.sourceUrl ?? `https://www.instagram.com/reel/${r.id}/`,
    scheduled_at: null,
    posted_at: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    views: num(r.views),
    likes: num(r.publicMetrics?.likes),
    // Saves, shares and attributed signups are not publicly observable; they stay unknown until
    // the owner imports Insights or a Meta connector syncs them.
    saves: null,
    shares: null,
    attributed_signups: null,
    source: "cmo_desk",
    meta: {
      external_id: r.id,
      category: r.category, action: r.action, confidence: r.confidence,
      observation: r.observation, fix: r.fix, evidence: r.evidence,
      paidStatus: r.paidStatus, performanceStatus: r.performanceStatus, attentionRank: r.attentionRank,
      creativeRubric: r.creativeRubric, observedAt: r.observedAt,
      observations: advisorObservations(r),
    },
  }));
}

export function cmoRecommendations(s: Json, now = new Date().toISOString()): CmoRecommendation[] {
  const out: CmoRecommendation[] = [];
  for (const t of s.trends ?? []) {
    out.push({
      id: `trend-${t.id}`, kind: "trend", title: t.title, hook: t.hook ?? null,
      body: [t.idea, ...(t.beats ?? []).map((b: string, i: number) => `${i + 1}. ${b}`), t.test && `Test: ${t.test}`].filter(Boolean).join("\n"),
      evidence: t.evidence ?? null, confidence: t.confidence ?? null, signal: t.timing ?? null,
      sources: t.links ?? [], status: "new", created_at: s.updatedAt ?? now,
    });
  }
  const wl = s.externalWatchlist;
  for (const w of wl?.items ?? []) {
    out.push({
      id: `watch-${w.id}`, kind: "watchlist", title: w.title, hook: w.hook ?? null,
      body: [w.visual, w.timing, w.audio?.title && `Audio: ${w.audio.title} (${w.audio.status ?? "unverified"})`].filter(Boolean).join("\n"),
      evidence: w.why ?? null, confidence: w.confidence ?? null, signal: w.signal ?? null,
      sources: w.sources ?? [], status: "new", created_at: wl.lastSuccessfulAt ?? now,
    });
  }
  (s.paidReports?.recommendedDecisions ?? []).forEach((d: Json, i: number) => {
    out.push({
      id: `paid-${i + 1}`, kind: "paid_decision", title: d.signal, hook: null, body: d.next ?? null,
      evidence: d.evidence ?? null, confidence: "Reported campaign data; post IDs unverified", signal: null,
      sources: [], status: "new", created_at: s.paidReports?.importedAt ?? now,
    });
  });
  (s.acquisition?.creativeTests ?? []).forEach((c: Json, i: number) => {
    out.push({
      id: `test-${i + 1}`, kind: "creative_test", title: `${c.name} → ${c.goal}`, hook: c.hook ?? null,
      body: [...(c.beats ?? []).map((b: string, j: number) => `${j + 1}. ${b}`), c.test && `Test: ${c.test}`].filter(Boolean).join("\n"),
      evidence: c.guardrail ? `Guardrail: ${c.guardrail}` : null, confidence: "Hypothesis", signal: null,
      sources: [], status: "new", created_at: s.acquisition?.updatedAt ?? now,
    });
  });
  return out;
}

/** Seed hook pool for the Reel Engine from every hook the CMO research proposed. */
export function cmoHooks(s: Json, map: MarketingMapDoc, now = new Date().toISOString()): ReelHook[] {
  const seen = new Set<string>();
  const hooks: ReelHook[] = [];
  const add = (text: string | undefined, source: ReelHook["source"], framework: string | null) => {
    const t = text?.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    hooks.push({ id: `h${hooks.length + 1}`, text: t, framework, source, status: "new", created_at: now });
  };
  for (const t of s?.trends ?? []) add(t.hook, "radar", t.category ?? null);
  for (const w of s?.externalWatchlist?.items ?? []) add(w.hook, "radar", w.kind ?? null);
  for (const c of s?.acquisition?.creativeTests ?? []) add(c.hook, "radar", c.goal ?? null);
  for (const n of map.nodes) add(n.hook, "map", n.channel);
  // Evidence-ranked library (data/hook-library.json): best-performing patterns from our own posts + research.
  for (const h of readJson("hook-library.json")?.hooks ?? []) add(h.text, "radar", h.framework ?? null);
  return hooks;
}

/** Engine format from a free-text style label ("Seasonal cinematic mini-guide" → cinematic). */
export function guessFormat(label = ""): string {
  const l = label.toLowerCase();
  if (/cinematic|seasonal|nostalgia|mood/.test(l)) return "cinematic";
  if (/pov|first.person/.test(l)) return "pov";
  if (/reveal|turn around|setup.*shot|selfie.pan/.test(l)) return "reveal";
  if (/list|guide|\d+ (places|spots)/.test(l)) return "list";
  if (/talking|podcast|opinion|founder/.test(l)) return "talking";
  if (/one.?shot|single/.test(l)) return "oneshot";
  return "montage";
}

/** Outside Instagram references researched by the CMO Desk (baselines + watchlist sources). Links only. */
export function cmoRefs(s: Json, now = new Date().toISOString()): ReelRef[] {
  const out = new Map<string, ReelRef>();
  for (const b of s?.externalBaselines ?? []) {
    const url = b.url ?? b.sourceUrl;
    if (!url || out.has(url)) continue;
    out.set(url, {
      id: `ref-${b.id}`, url, file: null, source: "instagram", title: `@${b.account} · ${b.title}`,
      format: guessFormat(`${b.format} ${b.title}`), notes: [b.format && `Style: ${b.format}`, b.adaptation && `Adapt: ${b.adaptation}`].filter(Boolean).join("\n"),
      metrics: { likes: b.likes ?? null, views: b.views ?? null, observed_at: b.observedAt ?? null, account: b.account ?? null }, added_at: b.observedAt ?? now,
    });
  }
  for (const w of s?.externalWatchlist?.items ?? []) {
    for (const src of w.sources ?? []) {
      if (!src.url || out.has(src.url) || !/instagram|tiktok/.test(src.url)) continue;
      out.set(src.url, {
        id: `ref-w-${w.id}-${out.size}`, url: src.url, file: null, source: "watchlist", title: src.title, format: guessFormat(`${w.title} ${w.kind}`),
        notes: [`Watchlist #${w.rank}: ${w.title} (${String(w.signal).replace(/_/g, " ")})`, w.hook && `Hook: ${w.hook}`, w.visual && `Visual: ${w.visual}`].filter(Boolean).join("\n"),
        metrics: {}, added_at: s.externalWatchlist.lastSuccessfulAt ?? now,
      });
    }
  }
  return [...out.values()];
}

/** Imported Meta campaign reports are period totals, not daily rows: they live in campaigns.meta. */
export function cmoCampaigns(s: Json): { campaigns: Campaign[]; daily: CampaignDaily[] } {
  const rows: Json[] = s?.paidReports?.campaignRows ?? [];
  const campaigns = rows.map((r, i): Campaign => ({
    id: `cmo-meta-${r.sourceRow ?? i}`, platform: "meta", external_id: null, name: r.campaignName,
    status: r.delivery ?? null, objective: r.instagramFollows != null ? "instagram_follows" : null,
    meta: {
      source: "cmo_desk_paid_report", reportStart: r.reportStart, reportEnd: r.reportEnd,
      follows: r.instagramFollows, linkClicks: r.linkClicks, spendUsd: r.spendUsd,
      estimatedSpendUsd: r.estimatedSpendUsd, estimatedCostPerFollowUsd: r.estimatedCostPerFollowUsd,
      appInstalls: r.appInstalls,
    },
  }));
  return { campaigns, daily: [] };
}
