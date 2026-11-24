import { getRepo } from "@engine/db";
import { ACCESS, guardApi, type Area } from "@/lib/auth";

export const dynamic = "force-dynamic";

export interface PaletteItem { kind: string; title: string; sub?: string; href: string }

/** Searchable index for the ⌘K palette: things you'd want to jump to, filtered by role. */
export async function GET() {
  const s = await guardApi("command", "content", "growth", "calendar", "ops", "build", "settings", "finance", "capital");
  if (s instanceof Response) return s;
  const can = (a: Area) => ACCESS[s.role].includes(a);
  const repo = getRepo();
  const [approvals, campaigns, content, jobs, incidents] = await Promise.all([
    can("command") ? repo.list("approvals", { eq: { status: "pending" } }) : [],
    can("calendar") ? repo.list("ad_campaigns") : [],
    can("content") ? repo.list("content_items") : [],
    can("content") ? repo.list("reel_jobs", { order: { col: "created_at", asc: false }, limit: 25 }) : [],
    can("ops") || can("build") ? repo.list("incidents") : [],
  ]);
  const items: PaletteItem[] = [
    ...approvals.map((a) => ({ kind: "Approval", title: a.title, sub: a.summary ?? undefined, href: "/command#decide" })),
    ...campaigns.map((c) => ({ kind: "Ad campaign", title: c.title, sub: `${c.status} · ${c.starts_on} → ${c.ends_on}`, href: "/calendar" })),
    ...content.filter((c) => c.status !== "posted").map((c) => ({ kind: c.id.startsWith("plan-") ? "Plan idea" : "Content", title: c.title ?? c.id, sub: `${c.status}${c.scheduled_at ? ` · ${c.scheduled_at.slice(0, 10)}` : ""}`, href: "/content" })),
    ...jobs.map((j) => ({ kind: "Reel batch", title: j.job_id, sub: j.status, href: "/content/engine" })),
    ...incidents.filter((i) => i.status !== "resolved").map((i) => ({ kind: "Incident", title: i.title, sub: `${i.severity} · ${i.status}`, href: "/ops" })),
  ];
  return Response.json(items);
}
