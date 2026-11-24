import Link from "next/link";
import { Suspense } from "react";
import { ApprovalsQueue } from "@/components/approvals";
import { Card, CardBody, CardHeader, Empty, PageHeader, statusTone, Badge } from "@/components/ui";
import { maxDailyBudget } from "@/lib/ad-campaigns";
import { ACCESS, requireArea } from "@/lib/auth";
import { spendable, TRIAL_HOURS } from "@/lib/improve";
import { campaignChoices, campaignDesk, inFlight, readyVideos, type ReadyVideo } from "@/lib/launch";
import { CampaignDesk } from "./campaigns";
import { TestCard } from "../lab/lab";
import { Launcher } from "./launch";
import { adoptImports } from "@/lib/video-import";
import { OptimizeToggle } from "../results/optimize";
import { trialCapStatus } from "@/lib/trial-cap";

export default async function LaunchPage() {
  const session = await requireArea("content");
  await adoptImports().catch(() => null);  // /brag ads and other imports saved while the engine was down
  const [videos, flight, money, choices, tcap] = await Promise.all([readyVideos(), inFlight(), spendable().catch(() => null), campaignChoices(), trialCapStatus().catch(() => null)]);
  return (
    <>
      <PageHeader title="Launch" description={`One approval per video: post it to your grid, run it as a trial reel (non-followers only, off your grid), put it in a test (trial reels, judged after ${TRIAL_HOURS()} h, then a cheap ads screen, then scale), or run it as an ad with a daily budget. Campaigns put several desk videos and Instagram posts into one Meta campaign, with others sent to trial.`} />
      <OptimizeToggle canApprove={ACCESS[session.role].includes("command")} compact />
      {tcap && (
        <Link href="/results" className="mb-3 flex flex-wrap items-baseline gap-x-2 rounded border bg-muted/20 px-2.5 py-1.5 text-[12px] hover:bg-muted/40">
          <span className="label">Trial reels today</span>
          <span className="font-mono font-semibold">{tcap.out}/{tcap.cap}</span>
          <span className="text-muted-foreground">{tcap.next}</span>
        </Link>
      )}
      <Suspense fallback={<Card className="mb-3"><CardHeader title="Campaigns" description="Loading campaigns and the Instagram feed…" /><div className="h-24 animate-pulse bg-muted/20" /></Card>}>
        <Campaigns videos={videos} cap={maxDailyBudget()} canApprove={ACCESS[session.role].includes("command")} />
      </Suspense>
      <Launcher videos={videos} money={money ? { free: money.free, committed: money.committed, currency: money.funds?.currency ?? "USD" } : null} cap={maxDailyBudget()} choices={choices} />
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title={`Needs a decision${flight.decisions.length ? ` · ${flight.decisions.length}` : ""}`} description="Next steps that spend more or change what's live: screening, scaling, budget changes, pauses." />
          <CardBody><ApprovalsQueue items={flight.decisions} emptyText="Nothing waiting on you." /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Ads running" description={<>Live items are watched on <Link href="/command#live" className="underline hover:text-foreground">Command → Live</Link>.</>} action={<Link href="/calendar" className="label hover:text-foreground">calendar →</Link>} />
          <CardBody className="divide-y">
            {!flight.ads.length ? <Empty>No ads yet.</Empty> : flight.ads.map((c) => (
              <div key={c.id} className="flex items-center gap-2 py-1.5 text-xs">
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                <span className="flex-1 truncate">{c.title}</span>
                <span className="font-mono text-muted-foreground">{c.daily_budget}/day · {c.starts_on} → {c.ends_on}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      {flight.tests.length > 0 && (
        <div className="mt-3 space-y-3">
          <div className="label">Tests</div>
          {flight.tests.map((t) => <TestCard key={t.id} t={t} />)}
        </div>
      )}
    </>
  );
}

/** Streams in after the page: the Instagram feed and Meta insights come from the Graph API (cached 10 minutes). */
async function Campaigns({ videos, cap, canApprove }: { videos: ReadyVideo[]; cap: number; canApprove: boolean }) {
  const d = await campaignDesk();
  return <CampaignDesk campaigns={d.campaigns} structures={d.structures} videos={videos} posts={d.posts} promoted={d.promoted} meta={d.meta} cap={cap} canApprove={canApprove} />;
}
