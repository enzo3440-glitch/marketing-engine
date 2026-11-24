import { tzOffsetMs } from "@engine/db";
// Read-only views of the desk's dashboards, computed from the same rows and helpers the pages use.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AGENTS, apiBudgets, breakevenMonth, computeKpis, dailyTotals, lagCorrelation, metricSeries, projectFinance, projectMonthEnd,
} from "@engine/db";
import { daysAgo, desk, hstToday, readRepo } from "../context";
import { define } from "../tool";

const range = z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30).describe("Days to cover (7, 30 or 90), like the page's range picker");
const limit = (d: number) => z.number().int().min(1).max(500).default(d).describe("Max rows to return");
const ARPU = 7.99;
const round = (n: number | null, d = 2) => (n == null ? null : +n.toFixed(d));

/** KPI cards without their 95-day series (last 14 points kept for trend). */
async function kpis() {
  const repo = readRepo();
  const since = daysAgo(95);
  const [metrics, spend, ads, fin] = await Promise.all([
    repo.list("metrics_daily", { since }), repo.list("api_spend", { since }), repo.list("campaign_daily", { since }), repo.list("fin_actuals"),
  ]);
  const b = apiBudgets();
  return computeKpis({ metrics, spend, ads, fin, today: hstToday(), apiBudget: b.anthropic + b.google })
    .map((k) => ({ ...k, value: round(k.value), delta: round(k.delta, 4), series: k.series.slice(-14) }));
}

export function registerDashboards(server: McpServer) {
  define(server, "get_command_overview", {
    title: "Command overview", kind: "read", areas: ["command"],
    description: "The Command dashboard: KPI cards, pending approvals, open incidents by severity, today's calendar, latest run of each worker agent.",
    input: {},
  }, async () => {
    const repo = readRepo();
    const today = hstToday();
    const [k, approvals, incidents, events, runs] = await Promise.all([
      kpis(), repo.list("approvals", { order: { col: "created_at", asc: false } }), repo.list("incidents"),
      repo.list("calendar_events", { eq: { is_own: true }, order: { col: "starts_at" } }),
      repo.list("agent_runs", { order: { col: "started_at", asc: false }, limit: 400 }),
    ]);
    const rank = { critical: 0, error: 1, warn: 2, info: 3 };
    const open = incidents.filter((i) => ["open", "triaged", "fix_proposed"].includes(i.status))
      .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.last_seen < b.last_seen ? 1 : -1));
    return {
      today, kpis: k,
      pendingApprovals: approvals.filter((a) => a.status === "pending").map((a) => ({ id: a.id, type: a.type, title: a.title, summary: a.summary, by: a.created_by_agent, created_at: a.created_at })),
      openIncidents: open.slice(0, 20).map((i) => ({ id: i.id, severity: i.severity, source: i.source, title: i.title, status: i.status, occurrences: i.occurrences, last_seen: i.last_seen })),
      todaysEvents: events.filter((e) => new Date(Date.parse(e.starts_at) + tzOffsetMs()).toISOString().slice(0, 10) === today),
      agents: AGENTS.map((agent) => {
        const r = runs.find((x) => x.agent === agent);
        return { agent, status: r?.status ?? "never", started_at: r?.started_at ?? null, finished_at: r?.finished_at ?? null };
      }),
    };
  });

  define(server, "get_growth_dashboard", {
    title: "Growth dashboard", kind: "read", areas: ["growth"],
    description: "Funnel (impressions → paid), ad spend vs signups by day, spend→signup lag correlation and the per-campaign table (CPM/CPI/CAC/ROAS, attributed by install share).",
    input: { range },
  }, async ({ range }) => {
    const repo = readRepo();
    const since = daysAgo(range - 1);
    const [metrics, ads, campaigns] = await Promise.all([repo.list("metrics_daily", { since }), repo.list("campaign_daily", { since }), repo.list("campaigns")]);
    const tot = (k: "impressions" | "clicks" | "installs" | "spend") => ads.reduce((a, r) => a + Number(r[k]), 0);
    const signups = metricSeries(metrics, "signups"), paid = metricSeries(metrics, "paid_conversions");
    const sum = (s: { value: number }[]) => s.reduce((a, b) => a + b.value, 0);
    const spendDaily = dailyTotals(ads, (r) => Number(r.spend));
    const sMap = new Map(signups.map((s) => [s.date, s.value]));
    const lags = lagCorrelation(spendDaily, signups);
    const totalInstalls = tot("installs") || 1;
    const rows = campaigns.filter((c) => !c.id.startsWith("cmo-")).map((c) => {
      const r = ads.filter((a) => a.campaign_id === c.id);
      const spend = r.reduce((a, b) => a + Number(b.spend), 0), imp = r.reduce((a, b) => a + b.impressions, 0);
      const installs = r.reduce((a, b) => a + b.installs, 0), attrPaid = sum(paid) * (installs / totalInstalls);
      return {
        id: c.id, platform: c.platform, name: c.name, status: c.status, spend: round(spend), impressions: imp, installs,
        cpm: round(imp ? (spend / imp) * 1000 : null), cpi: round(installs ? spend / installs : null), cac: round(attrPaid ? spend / attrPaid : null),
        roas: round(spend ? (attrPaid * ARPU * 12) / spend : null),
      };
    }).sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
    return {
      range, since,
      funnel: { impressions: tot("impressions"), clicks: tot("clicks"), installs: tot("installs"), signups: sum(signups), paid: sum(paid) },
      daily: spendDaily.map((d) => ({ date: d.date, spend: round(d.value), signups: sMap.get(d.date) ?? 0 })),
      bestLag: [...lags].sort((a, b) => b.r - a.r)[0] ?? null,
      campaigns: rows,
      importedFromCmo: campaigns.filter((c) => c.id.startsWith("cmo-")).map((c) => ({ id: c.id, name: c.name, platform: c.platform })),
    };
  });

  define(server, "get_ops_dashboard", {
    title: "Ops dashboard", kind: "read", areas: ["ops"],
    description: "API spend vs budget with month-end projection per provider, cost by model, integration health, recent deploys and open non-Sentry incidents.",
    input: { range },
  }, async ({ range }) => {
    const repo = readRepo();
    const today = hstToday();
    const [spendAll, integrations, deploys, incidents] = await Promise.all([
      repo.list("api_spend", { since: daysAgo(Math.max(range, 40)) }), repo.list("integrations"),
      repo.list("deploys", { order: { col: "created_at", asc: false }, limit: 15 }), repo.list("incidents"),
    ]);
    const spend = spendAll.filter((s) => s.date >= daysAgo(range - 1));
    const budgets = apiBudgets();
    const models = new Map<string, { provider: string; model: string; cost: number; tokens_in: number; tokens_out: number }>();
    for (const s of spend) {
      const k = `${s.provider}/${s.model}`;
      const m = models.get(k) ?? { provider: s.provider, model: s.model, cost: 0, tokens_in: 0, tokens_out: 0 };
      m.cost += Number(s.cost_usd); m.tokens_in += Number(s.tokens_in); m.tokens_out += Number(s.tokens_out);
      models.set(k, m);
    }
    return {
      range, today,
      projections: (Object.keys(budgets) as (keyof typeof budgets)[]).map((p) => {
        const x = projectMonthEnd(spendAll, today, budgets[p], p);
        return { provider: p, monthToDate: round(x.monthToDate), projected: round(x.projected), budget: x.budget, overPct: round(x.overPct, 4), daysLeft: x.daysLeft };
      }),
      byModel: [...models.values()].map((m) => ({ ...m, cost: round(m.cost) })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
      integrations: integrations.map((i) => ({ provider: i.provider, status: i.status, last_sync_at: i.last_sync_at, last_error: i.last_error })),
      deploys,
      openIncidents: incidents.filter((i) => i.source !== "sentry" && i.status !== "resolved").map((i) => ({ id: i.id, severity: i.severity, title: i.title, status: i.status, last_seen: i.last_seen })),
    };
  });

  define(server, "get_build_board", {
    title: "Build board", kind: "read", areas: ["build"],
    description: "Build items (features, bugs, tests) by priority and Sentry crashes with any proposed fix.",
    input: { limit: limit(60) },
  }, async ({ limit }) => {
    const repo = readRepo();
    const [items, crashes] = await Promise.all([
      repo.list("build_items", { order: { col: "priority" } }),
      repo.list("incidents", { eq: { source: "sentry" }, order: { col: "last_seen", asc: false } }),
    ]);
    return {
      items: items.slice(0, limit),
      crashes: crashes.slice(0, limit).map((c) => ({ id: c.id, severity: c.severity, title: c.title, status: c.status, occurrences: c.occurrences, users_affected: c.users_affected, last_seen: c.last_seen, fix: c.proposed_fix?.summary ?? null })),
    };
  });

  define(server, "get_finance_dashboard", {
    title: "Finance dashboard", kind: "read", areas: ["finance"],
    description: "Monthly actuals, saved scenarios and each scenario's 24-month projection summary (break-even month, cash low point, MRR at 12/24 months) against FIN_GOAL_MRR.",
    input: { includeProjection: z.boolean().default(false).describe("Include every projected month, not just the summary") },
  }, async ({ includeProjection }) => {
    const repo = readRepo();
    const [actuals, scenarios] = await Promise.all([repo.list("fin_actuals", { order: { col: "month" } }), repo.list("fin_scenarios")]);
    return {
      goalMrr: Number(process.env.FIN_GOAL_MRR ?? 25000), actuals,
      scenarios: scenarios.map((s) => {
        const p = projectFinance(actuals, s.assumptions);
        const low = p.reduce((m, x) => (x.cash < m.cash ? x : m), p[0] ?? { cash: 0, month: "" });
        return {
          id: s.id, name: s.name, assumptions: s.assumptions, breakeven: breakevenMonth(p),
          cashLow: low ? { month: low.month, cash: round(low.cash, 0) } : null,
          mrr12: round(p[11]?.revenue ?? null, 0), mrr24: round(p[23]?.revenue ?? null, 0),
          ...(includeProjection ? { projection: p.map((x) => ({ ...x, revenue: round(x.revenue, 0), cost: round(x.cost, 0), net: round(x.net, 0), cash: round(x.cash, 0) })) } : {}),
        };
      }),
    };
  });

  define(server, "get_capital_pipeline", {
    title: "Capital pipeline", kind: "read", areas: ["capital"],
    description: "Capital contacts (investors, partnerships, mentors) by segment and stage, plus drafted outreach emails waiting in approvals.",
    input: { segment: z.enum(["hit", "warm", "partnership", "investor", "mentor"]).optional() },
  }, async ({ segment }) => {
    const repo = readRepo();
    const [contacts, outreach] = await Promise.all([
      repo.list("capital_contacts", segment ? { eq: { segment } } : {}),
      repo.list("approvals", { eq: { type: "outreach_email" }, order: { col: "created_at", asc: false } }),
    ]);
    return { contacts, outreach: outreach.map((a) => ({ id: a.id, title: a.title, status: a.status, summary: a.summary, created_at: a.created_at })) };
  });

  define(server, "get_calendar", {
    title: "Calendar & inbox", kind: "read", areas: ["calendar"],
    description: "Upcoming calendar events and the inbox items ranked by importance.",
    input: { days: z.number().int().min(1).max(60).default(14).describe("Look-ahead window for events"), limit: limit(25) },
  }, async ({ days, limit }) => {
    const repo = readRepo();
    const [events, inbox] = await Promise.all([
      repo.list("calendar_events", { eq: { is_own: true }, order: { col: "starts_at" } }),
      repo.list("inbox_items", { order: { col: "received_at", asc: false } }),
    ]);
    const now = new Date().toISOString(), until = new Date(Date.now() + days * 86400_000).toISOString();
    return {
      events: events.filter((e) => e.ends_at >= now && e.starts_at <= until),
      inbox: [...inbox].sort((a, b) => b.importance - a.importance).slice(0, limit),
    };
  });

  define(server, "list_content_items", {
    title: "Content items", kind: "read", areas: ["content"],
    description: "Content calendar items (reels, trial reels, posts) with status and performance.",
    input: { status: z.enum(["idea", "draft", "approved", "scheduled", "posted"]).optional(), source: z.string().optional().describe("e.g. reel_engine, cmo_desk"), limit: limit(50) },
  }, async ({ status, source, limit }) => {
    const eq: Record<string, string> = {};
    if (status) eq.status = status;
    if (source) eq.source = source;
    return (await readRepo().list("content_items", { eq })).slice(0, limit);
  });

  define(server, "list_cmo_recommendations", {
    title: "CMO recommendations", kind: "read", areas: ["content"],
    description: "CMO desk recommendations: trends, watchlist (incl. trending sounds), paid decisions, creative tests, agent output.",
    input: {
      kind: z.enum(["trend", "watchlist", "paid_decision", "creative_test", "agent"]).optional(),
      status: z.enum(["new", "accepted", "dismissed"]).optional(), limit: limit(50),
    },
  }, async ({ kind, status, limit }) => {
    const eq: Record<string, string> = {};
    if (kind) eq.kind = kind;
    if (status) eq.status = status;
    return (await readRepo().list("cmo_recommendations", { eq, order: { col: "created_at", asc: false } })).slice(0, limit);
  });

  define(server, "get_cmo_watchlist", {
    title: "CMO external watchlist", kind: "read", areas: ["content"],
    description: "The imported CMO Desk snapshot's external watchlist: outside accounts/posts being tracked, their hooks, audio and observed growth.",
    input: { limit: limit(40) },
  }, async ({ limit }) => {
    const snap = await readRepo().cmoSnapshot();
    const wl = (snap?.snapshot as { externalWatchlist?: { lastSuccessfulAt?: string; items?: unknown[] } } | undefined)?.externalWatchlist;
    if (!wl) return { observed_at: snap?.observed_at ?? null, items: [], note: "No CMO snapshot imported (pnpm import:cmo)." };
    return { observed_at: snap?.observed_at ?? null, lastSuccessfulAt: wl.lastSuccessfulAt ?? null, items: (wl.items ?? []).slice(0, limit) };
  });

  define(server, "set_cmo_recommendation_status", {
    title: "Accept / dismiss a CMO recommendation", kind: "write", areas: ["content"],
    description: "Mark a CMO recommendation accepted, dismissed or back to new (reversible).",
    input: { id: z.string(), status: z.enum(["new", "accepted", "dismissed"]) },
  }, async ({ id, status }) => desk("PATCH", `/api/cmo/recommendations/${encodeURIComponent(id)}`, { status }));

  // Approvals ---------------------------------------------------------------------------------------

  define(server, "list_approvals", {
    title: "Approvals queue", kind: "read", areas: ["command"],
    description: "Everything agents (and the reel engine) asked permission for: fix PRs, posts, outreach emails, ad changes.",
    input: {
      status: z.enum(["pending", "approved", "rejected", "executed", "failed"]).optional().default("pending"),
      type: z.enum(["fix_pr", "post", "outreach_email", "ad_change", "other"]).optional(), limit: limit(30),
    },
  }, async ({ status, type, limit }) => {
    const eq: Record<string, string> = { status };
    if (type) eq.type = type;
    return (await readRepo().list("approvals", { eq, order: { col: "created_at", asc: false } })).slice(0, limit);
  });

  define(server, "get_approval", {
    title: "Approval detail", kind: "read", areas: ["command"],
    description: "One approval with its full preview (diff, caption, email body…) so it can be reviewed before deciding.",
    input: { id: z.string() },
  }, async ({ id }) => {
    const [a] = await readRepo().list("approvals", { eq: { id } });
    return a ?? `No approval ${id}`;
  });

  for (const decision of ["approve", "reject"] as const) {
    define(server, `${decision}_approval`, {
      title: `${decision === "approve" ? "Approve" : "Reject"} an approval`, kind: "write", destructive: true, areas: ["command"],
      description: decision === "approve"
        ? "Approve a pending item. The worker's executor then carries it out (opens the PR, publishes the post, sends the email). Final: an approval is decided once."
        : "Reject a pending item; a drafted post goes back to idea. Final: an approval is decided once.",
      input: { id: z.string(), confirm: z.boolean().describe("Must be true; confirm with the user first") },
    }, async ({ id }) => {
      await desk("POST", `/api/approvals/${encodeURIComponent(id)}`, { decision });
      const [a] = await readRepo().list("approvals", { eq: { id } });
      return { ok: true, id, status: a?.status ?? (decision === "approve" ? "approved" : "rejected") };
    });
  }
}
