import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getRepo } from "@engine/db";
import { EngineDesk } from "./desk";
import { engine, hookRanking, importEngineJobs, syncJob } from "@/lib/reels";

export default async function EnginePage() {
  const repo = getRepo();
  const e = engine();
  await importEngineJobs().catch(() => 0);
  for (const j of await repo.list("reel_jobs", { eq: { status: "rendering" } })) await syncJob(j).catch(() => j);
  const [clips, hooks, jobs, health, refs, hookInfo] = await Promise.all([
    repo.list("reel_clips", { order: { col: "added_at", asc: false } }), repo.list("reel_hooks"),
    repo.list("reel_jobs", { order: { col: "created_at", asc: false }, limit: 30 }),
    e.health().catch((err: Error) => ({ status: "error" as const, detail: err.message })),
    repo.list("reel_refs", { order: { col: "added_at", asc: false } }),
    hookRanking(),
  ]);
  return (
    <>
      <PageHeader title="Advanced video tools" description="The batch builder, trend templates, clip bin and jobs. For everyday use, Make does this in one step.">
        <Link href="/make" className="label hover:text-foreground">← Make</Link>
      </PageHeader>
      <EngineDesk initialClips={clips} initialHooks={hooks} initialJobs={jobs} initialRefs={refs} hookInfo={hookInfo} engine={{ stub: e.stub, ...health }} />
    </>
  );
}
