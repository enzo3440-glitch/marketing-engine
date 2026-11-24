import { momentum, type Observation } from "@engine/advisor/core";
import { getRepo } from "@engine/db";
import { AdvisorDesk } from "./desk";
import { advisor, dbLedger } from "@/lib/advisor";

export default async function AdvisorPage() {
  const repo = getRepo();
  const [posts, map, ledger] = await Promise.all([repo.list("content_items", { eq: { status: "posted" } }), repo.getMap(), dbLedger.read()]);
  const now = new Date().toISOString();
  const rows = posts
    .map((p) => {
      const obs = ((p.meta as { observations?: Observation[] }).observations ?? []);
      let m;
      try { m = momentum(obs, { now }); } catch (e) { m = { label: "Invalid observation", reason: (e as Error).message, rate: null }; }
      return { id: p.id, title: p.title ?? p.id, url: p.media_url, postedAt: p.posted_at, views: p.views, nObs: obs.length, label: m.label, reason: m.reason, rate: m.rate };
    })
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || (b.views ?? 0) - (a.views ?? 0));
  return (
    <AdvisorDesk
      status={advisor().status()}
      posts={rows}
      ideas={map.doc.nodes.map((n) => ({ id: n.id, title: n.title, hook: n.hook ?? "", channel: n.channel }))}
      ledger={ledger as { revision: number; events: { id: string; type: string; revision: number; payload: Record<string, unknown>; recorded_at: string }[] }}
    />
  );
}
