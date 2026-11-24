import { getRepo } from "@engine/db";
import { BuildBoard, CrashTable } from "./client";
import { PageHeader } from "@/components/ui";
import { requireArea } from "@/lib/auth";

export default async function BuildPage() {
  await requireArea("build");
  const repo = getRepo();
  const [items, incidents] = await Promise.all([repo.list("build_items", { order: { col: "priority" } }), repo.list("incidents", { eq: { source: "sentry" }, order: { col: "last_seen", asc: false } })]);
  return (
    <>
      <PageHeader title="Build" description="Build queue, bugs and field tests, plus the Sentry crash feed with agent-proposed fixes." />
      <BuildBoard items={items} />
      <div className="mt-5"><CrashTable incidents={incidents} /></div>
    </>
  );
}
