// Pure derivations over raw ops rows, shared by the web app and the worker agents.
import type { ApiSpend, CampaignDaily, ContentItem, FinActual, MetricDaily, ScenarioAssumptions } from "./types";

export interface Series { date: string; value: number }
export interface Kpi {
  key: string; label: string; value: number | null; unit: "count" | "usd" | "months" | "pct";
  delta: number | null; series: Series[]; hint?: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function metricSeries(rows: MetricDaily[], metric: string): Series[] {
  const by = new Map<string, number>();
  for (const r of rows) if (r.metric === metric) by.set(r.date, (by.get(r.date) ?? 0) + Number(r.value));
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, value]) => ({ date, value }));
}

const last = (s: Series[]) => (s.length ? s[s.length - 1].value : null);
/** Percent change of the last value vs `back` points earlier. */
function pctDelta(s: Series[], back: number): number | null {
  if (s.length <= back) return null;
  const a = s[s.length - 1 - back].value, b = s[s.length - 1].value;
  return a ? (b - a) / a : null;
}
/** Rolling window sums, e.g. signups over trailing 7 days. */
function rolling(s: Series[], w: number): Series[] {
  return s.map((p, i) => ({ date: p.date, value: sum(s.slice(Math.max(0, i - w + 1), i + 1).map((x) => x.value)) }));
}

export function dailyTotals<T extends { date: string }>(rows: T[], val: (r: T) => number): Series[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.date, (by.get(r.date) ?? 0) + val(r));
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, value]) => ({ date, value }));
}

export interface SpendProjection {
  monthToDate: number; projected: number; budget: number; trailing7Avg: number; daysLeft: number; overPct: number;
}
/** Month-end projection = MTD actual + trailing 7-day average × remaining days. */
export function projectMonthEnd(spend: ApiSpend[], today: string, budget: number, provider?: string): SpendProjection {
  const rows = provider ? spend.filter((s) => s.provider === provider) : spend;
  const month = today.slice(0, 7);
  const daily = dailyTotals(rows, (r) => Number(r.cost_usd));
  const mtd = sum(daily.filter((d) => d.date.startsWith(month)).map((d) => d.value));
  const last7 = daily.filter((d) => d.date <= today).slice(-7);
  const avg = last7.length ? sum(last7.map((d) => d.value)) / last7.length : 0;
  const [y, m, d] = today.split("-").map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysLeft = dim - d;
  const projected = mtd + avg * daysLeft;
  return { monthToDate: mtd, projected, budget, trailing7Avg: avg, daysLeft, overPct: budget ? (projected - budget) / budget : 0 };
}

export function computeKpis(input: { metrics: MetricDaily[]; spend: ApiSpend[]; ads: CampaignDaily[]; fin: FinActual[]; today: string; apiBudget: number }): Kpi[] {
  const { metrics, spend, ads, fin, today, apiBudget } = input;
  const mau = metricSeries(metrics, "mau"), dau = metricSeries(metrics, "dau");
  const signups7 = rolling(metricSeries(metrics, "signups"), 7);
  const paid = metricSeries(metrics, "paid_subs"), mrr = metricSeries(metrics, "mrr");
  const conv = metricSeries(metrics, "paid_conversions");
  const adSpend = dailyTotals(ads, (r) => Number(r.spend));
  // Blended CAC: trailing-30 ad spend / trailing-30 new paid subs.
  const cacSeries = adSpend.map((p, i) => {
    const s = sum(adSpend.slice(Math.max(0, i - 29), i + 1).map((x) => x.value));
    const c = sum(conv.filter((x) => x.date <= p.date).slice(-30).map((x) => x.value));
    return { date: p.date, value: c ? s / c : 0 };
  });
  const finSorted = [...fin].sort((a, b) => (a.month < b.month ? -1 : 1));
  const burnSeries = finSorted.map((f) => ({ date: f.month, value: burnOf(f) }));
  const runwaySeries = finSorted.map((f) => ({ date: f.month, value: burnOf(f) > 0 ? f.cash_end / burnOf(f) : 99 }));
  const proj = projectMonthEnd(spend, today, apiBudget);
  const spendDaily = dailyTotals(spend, (r) => Number(r.cost_usd));
  const tail = (s: Series[]) => s.slice(-30);
  return [
    { key: "mau", label: "MAU", value: last(mau), unit: "count", delta: pctDelta(mau, 30), series: tail(mau) },
    { key: "dau", label: "DAU", value: last(dau), unit: "count", delta: pctDelta(dau, 7), series: tail(dau) },
    { key: "signups7", label: "New users 7d", value: last(signups7), unit: "count", delta: pctDelta(signups7, 7), series: tail(signups7) },
    { key: "paid", label: "Paid subs", value: last(paid), unit: "count", delta: pctDelta(paid, 30), series: tail(paid) },
    { key: "mrr", label: "MRR", value: last(mrr), unit: "usd", delta: pctDelta(mrr, 30), series: tail(mrr) },
    { key: "cac", label: "Blended CAC", value: last(cacSeries), unit: "usd", delta: pctDelta(cacSeries, 30), series: tail(cacSeries), hint: "Trailing-30 ad spend ÷ new paid subs" },
    { key: "burn", label: "Monthly burn", value: last(burnSeries), unit: "usd", delta: pctDelta(burnSeries, 1), series: burnSeries },
    { key: "runway", label: "Runway", value: last(runwaySeries), unit: "months", delta: null, series: runwaySeries },
    { key: "api", label: "API spend MTD", value: proj.monthToDate, unit: "usd", delta: proj.overPct, series: tail(spendDaily), hint: `Projected $${Math.round(proj.projected).toLocaleString()} vs budget $${proj.budget.toLocaleString()}` },
  ];
}

export const burnOf = (f: FinActual) =>
  Number(f.ad_spend) + Number(f.api_spend) + Number(f.infra_spend) + Number(f.payroll) + Number(f.other_opex) - Number(f.revenue);

/** Pearson correlation of spend(t) vs signups(t+lag) for lag 0..maxLag. */
export function lagCorrelation(spend: Series[], signups: Series[], maxLag = 7): { lag: number; r: number }[] {
  const sMap = new Map(signups.map((s) => [s.date, s.value]));
  const out: { lag: number; r: number }[] = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    const xs: number[] = [], ys: number[] = [];
    for (const p of spend) {
      const d = new Date(p.date + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + lag);
      const y = sMap.get(d.toISOString().slice(0, 10));
      if (y != null) { xs.push(p.value); ys.push(y); }
    }
    out.push({ lag, r: pearson(xs, ys) });
  }
  return out;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = sum(x) / n, my = sum(y) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx && dy ? +(num / Math.sqrt(dx * dy)).toFixed(3) : 0;
}

/** (saves + shares) / views. Null when any input is unknown (public CMO data has no saves/shares). */
export function efficacy(c: Pick<ContentItem, "views" | "saves" | "shares">): number | null {
  if (c.views == null || c.saves == null || c.shares == null || c.views === 0) return null;
  return (c.saves + c.shares) / c.views;
}

export interface ProjectionPoint {
  month: string; mau: number; paid: number; revenue: number; cost: number; net: number; cash: number;
}
/** 24-month forward model from the latest actual month. */
export function projectFinance(fin: FinActual[], a: ScenarioAssumptions, months = 24): ProjectionPoint[] {
  const sorted = [...fin].sort((x, y) => (x.month < y.month ? -1 : 1));
  const base = sorted[sorted.length - 1];
  if (!base) return [];
  let mau = base.mau, paid = base.paid_subs, cash = base.cash_end;
  let fixed = Number(base.payroll) + Number(base.other_opex) + Number(base.infra_spend);
  const apiPerMau = base.mau ? Number(base.api_spend) / base.mau : 0;
  const out: ProjectionPoint[] = [];
  const d = new Date(base.month + "T00:00:00Z");
  for (let i = 1; i <= months; i++) {
    d.setUTCMonth(d.getUTCMonth() + 1);
    mau = mau * (1 + a.growth_rate);
    const target = mau * a.conversion;
    const newPaid = Math.max(0, target - paid * (1 - a.churn));
    paid = paid * (1 - a.churn) + newPaid;
    fixed = fixed * (1 + a.opex_growth);
    const revenue = paid * a.arpu;
    const cost = fixed + newPaid * a.cac + mau * apiPerMau;
    cash += revenue - cost;
    out.push({ month: d.toISOString().slice(0, 10), mau: Math.round(mau), paid: Math.round(paid), revenue, cost, net: revenue - cost, cash });
  }
  return out;
}

export function breakevenMonth(p: ProjectionPoint[]): string | null {
  return p.find((x) => x.net >= 0)?.month ?? null;
}

/** Monthly API budgets in USD (BUDGET_ANTHROPIC_MONTHLY, BUDGET_GOOGLE_MONTHLY). */
export function apiBudgets(env: Record<string, string | undefined> = process.env) {
  return {
    anthropic: Number(env.BUDGET_ANTHROPIC_MONTHLY ?? 900),
    google: Number(env.BUDGET_GOOGLE_MONTHLY ?? 300),
  };
}
