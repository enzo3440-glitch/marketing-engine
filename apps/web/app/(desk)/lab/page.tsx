import { getRepo, PILLARS } from "@engine/db";
import { PageHeader } from "@/components/ui";
import { requireArea } from "@/lib/auth";
import { planFor, spendable, TRIAL_HOURS } from "@/lib/improve";
import { Lab, type ReelOption } from "./lab";

export default async function LabPage() {
  await requireArea("content");
  const repo = getRepo();
  const [tests, jobs, variants, items, money, plan] = await Promise.all([
    repo.list("growth_tests", { order: { col: "created_at", asc: false } }), repo.list("reel_jobs", { eq: { status: "done" }, order: { col: "created_at", asc: false } }),
    repo.list("reel_variants"), repo.list("content_items"), spendable().catch(() => null), planFor(8).catch(() => null),
  ]);
  const order = new Map(jobs.map((j, i) => [j.job_id, i]));
  const reels: ReelOption[] = variants.filter((v) => v.file && order.has(v.job_id))
    .sort((a, b) => Number(b.picked) - Number(a.picked) || order.get(a.job_id)! - order.get(b.job_id)!).slice(0, 60)
    .map((v) => ({ job_id: v.job_id, variant_id: v.id, label: v.hook ?? v.id, poster: v.poster, caption: v.caption ?? "", picked: v.picked }));
  const ideas = items.filter((c) => c.id.startsWith("plan-") && c.status !== "posted")
    .map((c) => ({ id: c.id, title: c.title ?? c.id, color: PILLARS.find((p) => p.id === (c.meta as { pillar?: string }).pillar)?.color ?? "#888" }));
  return (
    <>
      <PageHeader title="Test Lab" description={`Trial reels first (free, non-followers only, off your grid) → the best screened as ads-only campaigns on a small budget → the winners scaled. Improve proposes each step; nothing posts or spends until you approve it in Decide. Trial reels are judged after ${TRIAL_HOURS()} h.`} />
      <Lab tests={tests} reels={reels} ideas={ideas} money={money ? { free: money.free, committed: money.committed, currency: money.funds?.currency ?? "USD", balance: money.funds?.balance ?? null, capRoom: money.funds?.capRoom ?? null } : null} plan={plan} />
    </>
  );
}
