import { dailyTotals, getRepo } from "@engine/db";
import Link from "next/link";
import { Suspense } from "react";
import { DualAxis } from "@/components/charts";
import { Meter, Spark } from "@/components/spark";
import { Badge, Card, CardBody, CardHeader, Empty, Led, PageHeader, statusTone, Table, Td, Th } from "@/components/ui";
import { creativesOf, metaLink, type MetaLink } from "@/lib/ad-campaigns";
import { ACCESS, requireArea } from "@/lib/auth";
import { adPulse, igAccount, igPosts, pillarScores, type IgPost } from "@/lib/meta-insights";
import { cn, daysAgo, fmt } from "@/lib/utils";
import { CampaignControls } from "./campaign-controls";
import { PostGrid } from "./post-grid";
import { FeatureBoardView, LabCard, OptimizeToggle } from "./optimize";
import { trialLearning } from "@/lib/daily-reels";
import { featureColor, featureName } from "@/lib/features";

/**
 * Pulse: Meta ads and Instagram in one place. Live from the Graph API with the desk's Meta token; until that's
 * connected it shows what the desk already holds (seeded/imported ad data, public post observations), labelled.
 * The page shell renders at once; the paid and Instagram sections stream in as their Meta calls return.
 */
export default async function ResultsPage() {
  const session = await requireArea("growth");
  const [link, ig] = await Promise.all([metaLink(), igAccount().catch(() => null)]);
  return (
    <>
      <PageHeader title="Results" description="Live from Meta and Instagram: what each post and ad is doing. Improve any post or campaign; older snapshots are in History."><Link href="/results/history" className="label hover:text-foreground">History →</Link></PageHeader>
      <div className="mb-3 grid gap-3 md:grid-cols-2">
        <Card className="flex items-center gap-3 px-3.5 py-3">
          <Led tone={link.status === "connected" ? "success" : link.status === "error" ? "danger" : "muted"} live={link.status === "connected"} />
          <div className="min-w-0 flex-1">
            <div className="label">Meta ads</div>
            <div className="truncate text-[13px]">{link.status === "connected" ? `${link.account.name} · ${link.account.currency}` : link.status === "error" ? link.detail : `Not connected: set ${link.missing.join(", ")}`}</div>
          </div>
          {link.status === "connected" && <a href={link.adsManager} target="_blank" rel="noreferrer" className="label whitespace-nowrap hover:text-foreground">ads manager →</a>}
        </Card>
        <Card className="flex items-center gap-3 px-3.5 py-3">
          <Led tone={ig ? "success" : "muted"} live={!!ig} />
          <div className="min-w-0 flex-1">
            <div className="label">Instagram</div>
            <div className="truncate text-[13px]">{ig ? `@${ig.username} · ${fmt.compact(ig.followers_count)} followers · ${fmt.num(ig.media_count)} posts` : "Not connected: uses META_IG_USER_ID with the same Meta token (instagram_basic, instagram_manage_insights)"}</div>
          </div>
        </Card>
      </div>
      <OptimizeToggle canApprove={ACCESS[session.role].includes("command")} />
      <LabCard />
      <FeatureBoardView />
      <TrialLearningCard />
      <Suspense fallback={<SectionSkeleton title="Paid · last 30 days" h="h-[420px]" />}>
        <PaidSection />
      </Suspense>
      <Suspense fallback={<SectionSkeleton title="Campaigns" h="h-[200px]" />}>
        <CampaignsSection link={link} canApprove={ACCESS[session.role].includes("command")} />
      </Suspense>
      <Suspense fallback={<SectionSkeleton title="Instagram posts" h="h-[640px]" />}>
        <InstagramSection />
      </Suspense>
    </>
  );
}

function SectionSkeleton({ title, h }: { title: string; h: string }) {
  return (
    <Card className="mb-3">
      <CardHeader title={title} description="Loading from Meta…" />
      <div className={`animate-pulse bg-muted/20 ${h}`} />
    </Card>
  );
}

async function PaidSection() {
  const repo = getRepo();
  const [ads, deskAds, deskCampaigns, plannedAds] = await Promise.all([
    adPulse(30).catch((e: Error) => ({ error: e.message })), repo.list("campaign_daily", { since: daysAgo(29) }), repo.list("campaigns"), repo.list("ad_campaigns"),
  ]);
  const liveAds = ads && !("error" in ads) ? ads : null;
  const err = ads && "error" in ads ? ads.error : null;

  // live insights, else the desk's own campaign_daily rows
  const days = liveAds ? liveAds.days : dailyTotals(deskAds, (r) => Number(r.spend)).map((d) => {
    const rows = deskAds.filter((r) => r.date === d.date);
    return { date: d.date, spend: d.value, impressions: rows.reduce((a, r) => a + r.impressions, 0), clicks: rows.reduce((a, r) => a + r.clicks, 0), installs: rows.reduce((a, r) => a + r.installs, 0) };
  });
  const sum = (k: "spend" | "impressions" | "clicks" | "installs") => days.reduce((a, d) => a + d[k], 0);
  const spend = sum("spend"), inst = sum("installs"), imp = sum("impressions"), clicks = sum("clicks");
  const money = (n: number) => (liveAds ? `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${liveAds.currency}` : fmt.usd(n));
  const instruments = [
    { label: "Spend · 30d", value: money(spend), series: days.map((d) => d.spend) },
    { label: "Installs", value: fmt.num(inst), series: days.map((d) => d.installs) },
    { label: "Cost / install", value: inst ? money(spend / inst) : "—", series: days.map((d) => (d.installs ? d.spend / d.installs : 0)) },
    { label: "CTR", value: imp ? fmt.pct(clicks / imp, 2) : "—", series: days.map((d) => (d.impressions ? d.clicks / d.impressions : 0)) },
    { label: "Impressions", value: fmt.compact(imp), series: days.map((d) => d.impressions) },
  ];
  const budgetFor = (campaignId: string) => plannedAds.find((c) => c.meta.campaign_id === campaignId)?.daily_budget ?? null;
  const campaignRows = liveAds ? liveAds.campaigns : deskCampaigns.map((c) => {
    const rows = deskAds.filter((r) => r.campaign_id === c.id);
    const s = rows.reduce((a, r) => a + r.spend, 0), i = rows.reduce((a, r) => a + r.installs, 0), m = rows.reduce((a, r) => a + r.impressions, 0), k = rows.reduce((a, r) => a + r.clicks, 0);
    return { id: c.id, name: c.name, spend: s, impressions: m, clicks: k, installs: i, ctr: m ? k / m : 0, cpi: i ? s / i : null, today: rows.find((r) => r.date === days[days.length - 1]?.date)?.spend ?? 0 };
  }).filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend);

  return (
    <Card className="mb-3">
      <CardHeader title="Paid · last 30 days" description={err ? <span className="text-destructive">Meta: {err}</span> : liveAds ? "Live Meta ad insights (account level)." : <span><Badge tone="outline">desk data</Badge> Seeded/imported campaign rows until Meta is connected.</span>} />
      <div className="grid grid-cols-2 divide-x divide-y divide-border/70 border-b sm:grid-cols-5 sm:divide-y-0">
        {instruments.map((m) => (
          <div key={m.label} className="px-3 py-2.5">
            <div className="label">{m.label}</div>
            <div className="num mt-1 font-mono text-[19px] font-semibold leading-none">{m.value}</div>
            <Spark data={m.series} height={24} className="mt-1.5" />
          </div>
        ))}
      </div>
      <CardBody>
        {days.length ? <DualAxis data={days.map((d) => ({ date: d.date, spend: +d.spend.toFixed(2), installs: d.installs }))} bar="spend" line="installs" barLabel="Spend" lineLabel="Installs" height={220} />
          : <Empty>No ad spend in the last 30 days.</Empty>}
      </CardBody>
      {campaignRows.length > 0 && (
        <Table>
          <thead><tr><Th>Campaign</Th><Th className="w-48">Today vs daily budget</Th><Th className="text-right">Spend</Th><Th className="text-right">Installs</Th><Th className="text-right">CPI</Th><Th className="text-right">CTR</Th></tr></thead>
          <tbody>{campaignRows.slice(0, 12).map((c) => {
            const b = budgetFor(c.id);
            return (
              <tr key={c.id}>
                <Td className="max-w-xs truncate">{c.name}</Td>
                <Td>{b ? <div className="flex items-center gap-2"><Meter value={c.today} max={b} /><span className="num shrink-0 font-mono text-[10.5px] text-muted-foreground">{c.today.toFixed(0)}/{b}</span></div> : <span className="num font-mono text-[11px] text-muted-foreground">{c.today.toFixed(2)} today</span>}</Td>
                <Td className="num text-right font-mono text-[12px]">{money(c.spend)}</Td>
                <Td className="num text-right font-mono text-[12px]">{fmt.num(c.installs)}</Td>
                <Td className="num text-right font-mono text-[12px]">{c.cpi != null ? money(c.cpi) : "—"}</Td>
                <Td className="num text-right font-mono text-[12px]">{fmt.pct(c.ctr, 2)}</Td>
              </tr>
            );
          })}</tbody>
        </Table>
      )}
    </Card>
  );
}

const fileUrl = (job: string, n: string | null | undefined) => (n ? `/api/reels/files/${encodeURIComponent(job)}/${encodeURIComponent(n)}` : null);

/** The desk's own campaigns (every status) with their videos; built ones get Meta's last-30-day numbers by campaign id. */
async function CampaignsSection({ link, canApprove }: { link: MetaLink; canApprove: boolean }) {
  const [campaigns, ads] = await Promise.all([getRepo().list("ad_campaigns", { order: { col: "created_at", asc: false } }), adPulse(30).catch(() => null)]);
  const byId = new Map((ads?.campaigns ?? []).map((r) => [r.id, r]));
  const money = (x: number) => `${x.toLocaleString("en-US", { maximumFractionDigits: x < 10 ? 2 : 0 })}${ads ? ` ${ads.currency}` : ""}`;
  return (
    <Card className="mb-3">
      <CardHeader title={`Campaigns${campaigns.length ? ` · ${campaigns.length}` : ""}`} description="The desk's Meta campaigns, built in Launch → Campaigns. Spend, CTR, installs and CPI are Meta's last 30 days."
        action={<Link href="/launch" className="label hover:text-foreground">launch →</Link>} />
      {!campaigns.length ? <CardBody><Empty>No campaigns yet. Build one on Launch.</Empty></CardBody> : (
        <Table>
          <thead><tr><Th>Campaign</Th><Th>Videos</Th><Th>Status</Th><Th>Dates</Th><Th className="text-right">Budget</Th><Th className="text-right">Spend</Th><Th className="text-right">CTR</Th><Th className="text-right">Installs</Th><Th className="text-right">CPI</Th><Th /></tr></thead>
          <tbody>{campaigns.slice(0, 40).map((c) => {
            const r = c.meta.campaign_id ? byId.get(c.meta.campaign_id) : undefined;
            const list = creativesOf(c), trials = c.trials ?? [];
            const adsManager = link.status === "connected" && c.meta.campaign_id ? `${link.adsManager}&selected_campaign_ids=${c.meta.campaign_id}` : null;
            return (
              <tr key={c.id}>
                <Td className="max-w-[220px]"><div className="truncate">{c.title}</div>{c.meta.error && <div className="truncate text-[10.5px] text-destructive" title={c.meta.error}>{c.meta.error}</div>}</Td>
                <Td>
                  <div className="flex items-center gap-1" title={[...list.map((x) => (x.ig_media_id ? "IG: " : "") + (x.label ?? x.key)), ...trials.map((t) => `trial: ${t.label ?? t.key}`)].join(" · ")}>
                    {list.slice(0, 6).map((x) => {
                      const src = x.ig_media_id ? x.thumb : fileUrl(x.job_id!, x.poster);
                      // eslint-disable-next-line @next/next/no-img-element
                      return <span key={x.key} className="block h-8 w-[18px] overflow-hidden rounded-sm bg-muted">{src && <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />}</span>;
                    })}
                    <span className="num ml-1 font-mono text-[10.5px] text-muted-foreground">{list.length} ad{list.length === 1 ? "" : "s"}{trials.length ? ` · ${trials.length} trial` : ""}</span>
                  </div>
                </Td>
                <Td><Badge tone={statusTone(c.status)}>{c.status.replace("_", " ")}</Badge></Td>
                <Td className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">{fmt.date(c.starts_on)} – {fmt.date(c.ends_on)}</Td>
                <Td className="num text-right font-mono text-[12px]">{c.daily_budget}/day</Td>
                <Td className="num text-right font-mono text-[12px]">{r ? money(r.spend) : "—"}</Td>
                <Td className="num text-right font-mono text-[12px]">{r ? fmt.pct(r.ctr, 2) : "—"}</Td>
                <Td className="num text-right font-mono text-[12px]">{r ? fmt.num(r.installs) : "—"}</Td>
                <Td className="num text-right font-mono text-[12px]">{r?.cpi != null ? money(r.cpi) : "—"}</Td>
                <Td><CampaignControls id={c.id} status={c.status} built={!!c.meta.campaign_id} canApprove={canApprove} adsManager={adsManager} /></Td>
              </tr>
            );
          })}</tbody>
        </Table>
      )}
    </Card>
  );
}

async function InstagramSection() {
  const [posts, items] = await Promise.all([igPosts(48).catch(() => null), getRepo().list("content_items")]);
  const grid: IgPost[] = posts ?? items.filter((c) => c.status === "posted" && c.platform === "instagram").sort((a, b) => ((a.posted_at ?? "") < (b.posted_at ?? "") ? 1 : -1)).slice(0, 48)
    .map((c) => ({ id: c.id, caption: c.title ?? "", kind: c.kind, at: c.posted_at ?? "", permalink: c.media_url ?? "", thumb: null, likes: c.likes ?? 0, comments: 0,
      reach: c.views, saves: c.saves, shares: c.shares, views: c.views, pillar: (c.meta as { pillar?: string }).pillar ?? null }));
  const pillars = pillarScores(posts, items);
  const pillarTop = Math.max(0.0001, ...pillars.map((p) => p.rate ?? 0));
  return (
    <>
      <Card className="mb-3">
        <CardHeader title="Instagram posts" description={posts ? "Live media insights. Brightness and the bar = (saves + shares) ÷ reach; dot = plan pillar (matched by hook)."
          : <span><Badge tone="outline">desk data</Badge> Public observations from the CMO export (views and likes; saves/shares unknown) until Instagram insights connect.</span>} />
        <CardBody>{grid.length ? <PostGrid posts={grid} live={!!posts} /> : <Empty>No posts yet.</Empty>}</CardBody>
      </Card>
      <Card>
        <CardHeader title="Pillar scoreboard" description="(Saves + shares) ÷ reach per content pillar: the guide's organic scorecard. Planned = ideas on the calendar." />
        <CardBody className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
          {pillars.map((p) => (
            <div key={p.id}>
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}</span>
                <span className="num font-mono text-[11px]">{p.rate != null ? fmt.pct(p.rate, 2) : "—"}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${((p.rate ?? 0) / pillarTop) * 100}%`, background: p.color }} /></div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{p.posts} measured · {p.planned} planned{p.reach ? ` · ${fmt.compact(p.reach)} reach` : ""}</div>
            </div>
          ))}
          {!pillars.some((p) => p.rate != null) && <p className="text-[11.5px] text-muted-foreground sm:col-span-2 xl:col-span-3">Fills in as plan posts go live with the plan&apos;s hooks in their captions.</p>}
        </CardBody>
      </Card>
    </>
  );
}


/** Trial reels: what yesterday's reels taught us, and how today's slots are spent because of it (lib/daily-reels.ts). */
async function TrialLearningCard() {
  const t = await trialLearning();
  const cap = t.cap;
  const l = t.lessons;
  const pct = (x: number | null, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
  return (
    <Card className="mb-3">
      <CardHeader title="Trial reels · what we learned today"
        description={`Read once a day, before the day's ${t.goal} reels are made${t.reserve ? ` (${t.reserve} slots held for live optimize's re-cuts)` : ""}. Every feature keeps a reel a day until 4 are read; the rest go to the features most likely to win, and about 30% remix winners changing one thing.`} />
      <div className="mx-4 mb-3 rounded border bg-muted/20 p-2.5 text-[12px]">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="label">Daily cap</span>
          <span className="font-mono text-base font-semibold">{cap.out}/{cap.cap}</span>
          <span className="text-muted-foreground">out in the last 24 h</span>
          <span className={cap.blocked_until ? "rounded-sm bg-destructive/10 px-1.5 text-destructive" : cap.hit ? "rounded-sm bg-success/15 px-1.5 text-success" : "rounded-sm bg-primary/10 px-1.5 text-primary"}>
            {cap.mode === "fixed" ? "fixed" : cap.blocked_until ? "paused by Instagram" : cap.hit ? `limit found: ${cap.ceiling}/day` : `ramping +${cap.step}/day`}</span>
        </div>
        <p className="mt-1 text-muted-foreground">{cap.next}</p>
        {cap.days.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[10.5px]">{[...cap.days].reverse().map((d) => (
            <span key={d.date} title={d.refused ? "Instagram refused one this day" : undefined} className={cn("rounded border px-1", d.refused && "border-destructive/50 text-destructive", !d.refused && d.posted >= d.cap && "border-success/50")}>
              {d.date.slice(5)} {d.posted}/{d.cap}{d.refused ? " ✕" : ""}</span>))}</div>
        )}
        {cap.log.length > 0 && <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">{cap.log.slice(0, 3).map((l, i) => <li key={i}>{l.at.slice(0, 10)} · {l.text}</li>)}</ul>}
      </div>
      <CardBody className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div>
          {!l ? <Empty>Not read yet: the first read happens on the autopilot&apos;s first pass of the day.</Empty> : (<>
            <ul className="mb-2 space-y-1 text-[12.5px]">{l.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            <Table>
              <thead><tr><Th>Feature</Th><Th className="text-right">Reels read</Th><Th className="text-right">Reach</Th><Th className="text-right">Saves + shares</Th><Th className="text-right">Watched</Th><Th className="text-right">Chance it&apos;s best</Th></tr></thead>
              <tbody>{l.features.map((f) => (
                <tr key={f.id}>
                  <Td><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: featureColor(f.id) }} />{f.name}</Td>
                  <Td className="text-right font-mono">{f.reels}</Td>
                  <Td className="text-right font-mono">{fmt.compact(f.reach)}</Td>
                  <Td className="text-right font-mono">{f.reels ? pct(f.act, 2) : "—"}</Td>
                  <Td className="text-right font-mono">{pct(f.watch, 0)}</Td>
                  <Td className="text-right font-mono">{f.reels ? `${Math.round(f.pbest * 100)}%` : "—"}</Td>
                </tr>))}</tbody>
            </Table>
            {l.changes.some((c) => c.reels) && <p className="mt-2 text-[11.5px] text-muted-foreground">Remix changes: {l.changes.filter((c) => c.reels).map((c) => `${c.change} ${c.vs >= 0 ? "+" : ""}${Math.round(c.vs * 100)}% (${c.reels})`).join(" · ")}</p>}
          </>)}
        </div>
        <div>
          <div className="label mb-1">Today&apos;s plan</div>
          {!t.plan.length ? <Empty>Today&apos;s reels haven&apos;t been started yet.</Empty> : (
            <ul className="space-y-1.5 text-[12px]">{t.plan.map((x, i) => (
              <li key={i} className="rounded border p-1.5" style={{ borderLeft: `3px solid ${featureColor(x.feature ?? "")}` }}>
                <div className="font-medium">{x.kind === "remix" ? "Remix" : "New"} · {featureName(x.feature ?? "")} · {x.title}</div>
                <div className="text-muted-foreground">{x.why}</div>
              </li>))}</ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
