import { getRepo } from "@engine/db";
import { Recommendations } from "./recs";
import { Card, CardBody, CardHeader, Empty, Stat } from "@/components/ui";
import { fmt } from "@/lib/utils";

interface Snap {
  summary?: string; coverage?: string; collectionNotes?: string;
  externalWatchlist?: { status?: string; collectionNote?: string; coverage?: string; lastSuccessfulAt?: string };
  acquisition?: { title?: string; status?: string; summary?: string };
  outsideOpportunities?: { title?: string; summary?: string; limitations?: string[] };
  methodology?: { title?: string; text?: string; body?: string }[];
  ownPostCoverage?: { knownCount?: number; completedAuditCount?: number; blocker?: string };
}

export default async function CmoPage() {
  const repo = getRepo();
  const [snap, recs, posts] = await Promise.all([repo.cmoSnapshot(), repo.list("cmo_recommendations"), repo.list("content_items", { eq: { source: "cmo_desk" } })]);
  if (!snap) {
    return <Empty>No CMO Desk export found. Put <code>radar-snapshot.json</code> and <code>watchlist-research.json</code> in <code>packages/db/data/private/</code>, then run <code>pnpm import:cmo</code>.</Empty>;
  }
  const s = snap.snapshot as Snap;
  const audits = posts.filter((p) => (p.meta as { fix?: string }).fix).sort((a, b) => ((a.posted_at ?? "") < (b.posted_at ?? "") ? 1 : -1));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Reel Radar snapshot" description={`Observed ${fmt.dateTime(snap.observed_at)} · exported ${fmt.dateTime(snap.exported_at)}. A dated copy, not a live connection.`} />
        <CardBody className="grid gap-4 md:grid-cols-4">
          <Stat label="Own posts audited" value={`${s.ownPostCoverage?.completedAuditCount ?? "—"} / ${s.ownPostCoverage?.knownCount ?? "—"}`} sub="public sample" />
          <Stat label="Recommendations" value={recs.length} sub={`${recs.filter((r) => r.status === "new").length} new`} />
          <Stat label="Watchlist status" value={s.externalWatchlist?.status ?? "—"} sub={s.externalWatchlist?.lastSuccessfulAt ? `checked ${fmt.ago(s.externalWatchlist.lastSuccessfulAt)}` : undefined} />
          <Stat label="Acquisition" value={<span className="text-sm">{s.acquisition?.status ?? "—"}</span>} />
          <p className="text-sm text-muted-foreground md:col-span-4">{s.summary}</p>
          {s.externalWatchlist?.collectionNote && <p className="text-xs text-muted-foreground md:col-span-4">Watchlist: {s.externalWatchlist.collectionNote}</p>}
        </CardBody>
      </Card>

      <Recommendations items={recs} />

      <Card>
        <CardHeader title="Post audits" description="Per-post creative diagnostics from the CMO Desk. Observations and fixes are hypotheses from public samples, not measured performance." />
        <div className="divide-y">
          {audits.slice(0, 20).map((p) => {
            const m = p.meta as { action?: string; observation?: string; fix?: string; confidence?: string };
            return (
              <details key={p.id} className="group px-4 py-2.5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm">
                  <span className="truncate"><span className="font-medium">{p.title}</span> <span className="text-xs text-muted-foreground">· {fmt.date(p.posted_at)} · {fmt.compact(p.views)} views</span></span>
                  <span className="shrink-0 text-xs text-muted-foreground">{m.action}</span>
                </summary>
                <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
                  <div><div className="mb-1 font-medium text-muted-foreground">Observation</div><p>{m.observation}</p></div>
                  <div><div className="mb-1 font-medium text-muted-foreground">Fix</div><p>{m.fix}</p></div>
                </div>
              </details>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
