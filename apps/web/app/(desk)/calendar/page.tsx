import { tzOffsetMs } from "@/lib/tz";
import { getRepo, PILLARS } from "@engine/db";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, Empty, PageHeader } from "@/components/ui";
import { metaLink } from "@/lib/ad-campaigns";
import { ACCESS, requireArea } from "@/lib/auth";
import { fmt, hstToday } from "@/lib/utils";
import { CampaignCalendar, type PlanPostView, type ReelPick } from "./campaigns";
import { MarketingPlan } from "./plan";
import { planState, type PlanMeta } from "@/lib/marketing-plan";

const hstDay = (iso: string) => new Date(Date.parse(iso) + tzOffsetMs()).toISOString().slice(0, 10);

export default async function CalendarPage({ searchParams }: { searchParams: { week?: string; w?: string } }) {
  const session = await requireArea("calendar");
  const repo = getRepo();
  const [events, inbox, campaigns, map, jobs, variants, meta] = await Promise.all([
    repo.list("calendar_events", { eq: { is_own: true }, order: { col: "starts_at" } }), repo.list("inbox_items", { order: { col: "received_at", asc: false } }),
    repo.list("ad_campaigns", { order: { col: "starts_on" } }), repo.getMap(), repo.list("reel_jobs", { eq: { status: "done" }, order: { col: "created_at", asc: false } }),
    repo.list("reel_variants"), metaLink(),
  ]);
  const plan = await planState();
  const posts: PlanPostView[] = plan.items.filter((c) => c.scheduled_at).map((c) => {
    const m = c.meta as unknown as PlanMeta;
    return { id: c.id, title: c.title ?? m.ref, day: hstDay(c.scheduled_at!), pillar: m.pillar, color: PILLARS.find((p) => p.id === m.pillar)?.color ?? "#888", status: c.status, channel: m.channel };
  });
  const gateCount = (k: "reviewed" | "tested") => plan.items.filter((c) => (c.meta as unknown as PlanMeta).gates?.[k]).length;
  const today = hstToday();
  // Ad campaign calendar: 5 weeks from this week's Monday, moved 4 weeks at a time
  const w = Number(searchParams.w ?? 0) || 0;
  const mon = new Date(today + "T00:00:00Z");
  mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7) + w * 7);
  const adDays = Array.from({ length: 35 }, (_, i) => { const d = new Date(mon); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const order = new Map(jobs.map((j, i) => [j.job_id, i]));
  const reels: ReelPick[] = variants.filter((v) => v.file && order.has(v.job_id))
    .sort((a, b) => Number(b.picked) - Number(a.picked) || order.get(a.job_id)! - order.get(b.job_id)!)
    .slice(0, 80)
    .map((v) => ({ job_id: v.job_id, variant_id: v.id, poster: v.poster, picked: v.picked, label: `${v.hook ?? v.id} · ${v.format ?? ""} · ${v.duration ?? "?"}s (${v.job_id})` }));
  const offset = Number(searchParams.week ?? 0) || 0;
  const start = new Date(today + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) + offset * 7); // Monday
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const important = inbox.filter((m) => m.importance >= 2);

  return (
    <>
      <PageHeader title="Calendar" description="Ad campaigns and planned posts from the marketing plan, the weekly pillars and launch rounds, then brand-tagged meetings and important Gmail threads." />
      <div className="mb-6">
        <CampaignCalendar campaigns={campaigns} posts={posts} concepts={map.doc.nodes.filter((n) => n.channel === "ads")} strategy={map.doc.strategy ?? []}
          reels={reels} meta={meta} days={adDays} today={today} offset={w} canApprove={ACCESS[session.role].includes("command")} />
      </div>
      <div className="mb-6">
        <MarketingPlan launchStart={plan.launch_start} count={plan.items.length} missing={plan.missing} today={today}
          gates={{ reviewed: gateCount("reviewed"), tested: gateCount("tested"), approved: plan.items.filter((c) => !["idea", "draft"].includes(c.status)).length }} />
      </div>
      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="xl:col-span-3">
          <CardHeader title={`Week of ${fmt.date(days[0])}`} action={
            <div className="flex gap-1 text-xs">
              <Link className="rounded border px-2 py-1" href={`?week=${offset - 1}`}>←</Link>
              <Link className="rounded border px-2 py-1" href="?week=0">This week</Link>
              <Link className="rounded border px-2 py-1" href={`?week=${offset + 1}`}>→</Link>
            </div>
          } />
          <div className="grid grid-cols-1 sm:grid-cols-7">
            {days.map((d) => {
              const evs = events.filter((e) => hstDay(e.starts_at) === d);
              return (
                <div key={d} className={`min-h-[220px] border-b border-r p-2 ${d === today ? "bg-primary/5" : ""}`}>
                  <div className={`mb-2 text-xs ${d === today ? "font-semibold text-primary" : "text-muted-foreground"}`}>{new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}</div>
                  <div className="space-y-1.5">
                    {evs.map((e) => (
                      <div key={e.id} className="rounded border-l-2 border-primary bg-muted/50 px-2 py-1 text-xs">
                        <div className="num text-[10px] text-muted-foreground">{fmt.time(e.starts_at)}–{fmt.time(e.ends_at)}</div>
                        <div className="font-medium leading-tight">{e.title}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <Card>
          <CardHeader title="Important inbox" description={`${important.length} flagged`} />
          <CardBody className="space-y-3">
            {important.length ? important.map((m) => (
              <div key={m.id} className="text-sm">
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{m.sender}</span>{m.importance >= 3 && <Badge tone="warning">high</Badge>}</div>
                <div className="truncate text-xs">{m.subject}</div>
                <div className="text-[11px] text-muted-foreground">{fmt.ago(m.received_at)}</div>
              </div>
            )) : <Empty>Inbox is quiet.</Empty>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
