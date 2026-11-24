import { tzOffsetMs } from "@/lib/tz";
import { getRepo, PILLARS } from "@engine/db";
import Link from "next/link";
import { ApprovalsQueue } from "@/components/approvals";
import { KpiCard } from "@/components/kpi";
import { Badge, Card, CardBody, CardHeader, Empty, Led, PageHeader, severityTone, statusTone } from "@/components/ui";
import { requireArea } from "@/lib/auth";
import { agentStatus, loadKpis } from "@/lib/data";
import { fmt, hstToday } from "@/lib/utils";
import { LiveSection } from "./live";

const hstDay = (iso: string) => new Date(Date.parse(iso) + tzOffsetMs()).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const CH: Record<string, string> = { ig_organic: "IG", ig_paid: "Ad", tiktok: "TT" };

type AgendaRow = { day: string; time?: string; kind: "post" | "ad-start" | "ad-end" | "meeting"; title: string; color?: string; status?: string; href: string };

export default async function CommandPage() {
  await requireArea("command");
  const repo = getRepo();
  const today = hstToday();
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const [kpis, approvals, incidents, events, agents, campaigns, content, jobs] = await Promise.all([
    loadKpis(), repo.list("approvals", { eq: { status: "pending" }, order: { col: "created_at", asc: false } }), repo.list("incidents"),
    repo.list("calendar_events", { eq: { is_own: true }, order: { col: "starts_at" } }), agentStatus(),
    repo.list("ad_campaigns", { order: { col: "starts_on" } }), repo.list("content_items"), repo.list("reel_jobs", { order: { col: "created_at", asc: false }, limit: 40 }),
  ]);
  const rank = { critical: 0, error: 1, warn: 2, info: 3 };
  const open = incidents.filter((i) => ["open", "triaged", "fix_proposed"].includes(i.status)).sort((a, b) => rank[a.severity] - rank[b.severity] || (a.last_seen < b.last_seen ? 1 : -1));
  const errors = open.filter((i) => i.severity === "critical" || i.severity === "error").length;

  // Next 7 days: planned posts, ad starts/ends, brand meetings
  const agenda: AgendaRow[] = [];
  for (const c of content) {
    if (!c.scheduled_at || c.status === "posted") continue;
    const d = hstDay(c.scheduled_at);
    if (d < today || d > week[6]) continue;
    const m = c.meta as { pillar?: string; channel?: string };
    agenda.push({ day: d, kind: "post", title: `${CH[m.channel ?? ""] ?? (c.platform === "tiktok" ? "TT" : "IG")} · ${c.title}`, color: PILLARS.find((p) => p.id === m.pillar)?.color, status: c.status, href: "/content" });
  }
  for (const c of campaigns) {
    if (c.starts_on >= today && c.starts_on <= week[6]) agenda.push({ day: c.starts_on, kind: "ad-start", title: `Ad starts · ${c.title}`, status: c.status, href: "/calendar" });
    if (c.ends_on >= today && c.ends_on <= week[6] && ["ready", "live"].includes(c.status)) agenda.push({ day: c.ends_on, kind: "ad-end", title: `Ad ends · ${c.title}`, status: c.status, href: "/calendar" });
  }
  for (const e of events) {
    const d = hstDay(e.starts_at);
    if (d >= today && d <= week[6]) agenda.push({ day: d, time: fmt.time(e.starts_at), kind: "meeting", title: e.title, href: "/calendar" });
  }

  const live = campaigns.filter((c) => ["building", "ready", "live", "paused"].includes(c.status));
  const rendering = jobs.filter((j) => j.status === "queued" || j.status === "rendering");
  const lastDone = jobs.find((j) => j.status === "done");
  const ideas = content.filter((c) => c.id.startsWith("plan-"));
  const gate = (k: "reviewed" | "tested") => ideas.filter((c) => (c.meta as { gates?: Record<string, boolean> }).gates?.[k]).length;
  const thisWeek = content.filter((c) => c.scheduled_at && week.includes(hstDay(c.scheduled_at)) && (c.meta as { pillar?: string }).pillar);
  const mix = PILLARS.map((p) => ({ ...p, n: thisWeek.filter((c) => (c.meta as { pillar?: string }).pillar === p.id).length }));
  const mixMax = Math.max(1, ...mix.map((m) => m.n));

  return (
    <>
      <PageHeader title="Command" description={`${fmt.date(today)} · ${approvals.length} to decide · ${errors} open errors · ${agenda.filter((a) => a.day === today).length} things today`} />

      <Card className="mb-3 grid grid-cols-2 divide-x divide-y divide-border/70 sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
        {kpis.map((k) => <KpiCard key={k.key} k={k} />)}
      </Card>

      <div className="grid gap-3 xl:grid-cols-12">
        <Card id="decide" className="xl:col-span-5">
          <CardHeader title={<span className="flex items-center gap-2">Decide <span className="num font-mono text-warning">{approvals.length}</span></span>}
            description="Nothing ships, posts or spends without your approval." />
          <CardBody className="max-h-[560px] overflow-y-auto py-1"><ApprovalsQueue items={approvals} /></CardBody>
        </Card>

        <Card className="xl:col-span-4">
          <CardHeader title="Next 7 days" description="Planned posts by pillar, ad starts and ends, brand meetings." action={<Link href="/calendar" className="label whitespace-nowrap hover:text-foreground">calendar →</Link>} />
          <CardBody className="max-h-[560px] space-y-3 overflow-y-auto py-2.5">
            {week.map((d) => {
              const rows = agenda.filter((a) => a.day === d).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
              return (
                <div key={d}>
                  <div className={`label mb-1 ${d === today ? "text-primary" : ""}`}>{d === today ? "Today" : new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</div>
                  {rows.length ? rows.map((r, i) => (
                    <Link key={i} href={r.href} className="flex items-center gap-2 rounded-sm border-l-2 px-2 py-1 text-[12.5px] hover:bg-accent"
                      style={{ borderLeftColor: r.color ?? (r.kind === "meeting" ? "hsl(var(--info))" : r.kind.startsWith("ad") ? "hsl(var(--primary))" : "hsl(var(--border))") }}>
                      {r.time && <span className="num w-12 shrink-0 font-mono text-[11px] text-muted-foreground">{r.time}</span>}
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      {r.status && r.status !== "idea" && <Badge tone={statusTone(r.status)} className="px-1 py-0">{r.status}</Badge>}
                      {r.status === "idea" && <span className="font-mono text-[9.5px] uppercase text-muted-foreground">idea</span>}
                    </Link>
                  )) : <div className="px-2 text-[11.5px] text-muted-foreground/70">—</div>}
                </div>
              );
            })}
          </CardBody>
        </Card>

        <div className="space-y-3 xl:col-span-3">
          <Card>
            <CardHeader title="Live systems" />
            <CardBody className="space-y-2.5 py-2.5 text-[12.5px]">
              <div>
                <div className="label mb-1">Meta campaigns</div>
                {live.length ? live.slice(0, 5).map((c) => (
                  <Link key={c.id} href="/calendar" className="flex items-center gap-2 py-0.5 hover:text-primary">
                    <Led tone={c.status === "live" ? "success" : c.status === "paused" ? "muted" : "warning"} live={c.status === "live"} />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="num font-mono text-[10.5px] text-muted-foreground">{c.daily_budget}/d</span>
                  </Link>
                )) : <div className="text-muted-foreground">No campaigns built yet.</div>}
              </div>
              <div>
                <div className="label mb-1">Video engine</div>
                {rendering.length ? rendering.slice(0, 4).map((j) => (
                  <div key={j.job_id} className="flex items-center gap-2 py-0.5"><Led tone="info" live /><span className="min-w-0 flex-1 truncate font-mono text-[11px]">{j.job_id}</span><span className="text-[11px] text-muted-foreground">{j.status}</span></div>
                )) : <div className="flex items-center gap-2 text-muted-foreground"><Led tone="muted" />Idle{lastDone ? ` · last batch ${fmt.ago(lastDone.created_at)}` : ""}</div>}
              </div>
              <div>
                <div className="label mb-1">Plan ideas</div>
                <div className="flex items-center gap-3 font-mono text-[11px]">
                  <span><span className="text-foreground">{ideas.length}</span> ideas</span>
                  <span><span className="text-foreground">{gate("reviewed")}</span> reviewed</span>
                  <span><span className="text-foreground">{gate("tested")}</span> tested</span>
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Pillar mix · this week" />
            <CardBody className="space-y-1 py-2.5">
              {mix.map((m) => (
                <div key={m.id} className="flex items-center gap-2 text-[11.5px]">
                  <span className="w-28 truncate text-muted-foreground">{m.name}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${(m.n / mixMax) * 100}%`, background: m.color }} /></div>
                  <span className="num w-4 text-right font-mono text-[10.5px]">{m.n}</span>
                </div>
              ))}
            </CardBody>
          </Card>

          <Card id="alerts">
            <CardHeader title={<span className="flex items-center gap-2">Alerts <span className={`num font-mono ${errors ? "text-destructive" : "text-success"}`}>{open.length}</span></span>} />
            <CardBody className="max-h-64 space-y-2 overflow-y-auto py-2.5">
              {open.length ? open.slice(0, 8).map((i) => (
                <div key={i.id} className="flex items-start gap-2 text-[12.5px]">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <div className="truncate">{i.title}</div>
                    <div className="text-[11px] text-muted-foreground">{i.source} · {i.occurrences}× · {fmt.ago(i.last_seen)}</div>
                  </div>
                </div>
              )) : <Empty>All clear.</Empty>}
            </CardBody>
          </Card>
        </div>
      </div>

      <LiveSection />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="label mr-1">Agents</span>
        {agents.map(({ agent, run }) => (
          <div key={agent} className="flex items-center gap-1.5 rounded-sm border bg-card/70 px-2 py-1 text-[11px]" title={run?.log ?? undefined}>
            <Led tone={!run ? "muted" : run.status === "ok" ? "success" : run.status === "failed" ? "danger" : "warning"} />
            <span className="font-medium">{agent}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{run ? fmt.ago(run.started_at) : "never"}</span>
          </div>
        ))}
      </div>
    </>
  );
}
