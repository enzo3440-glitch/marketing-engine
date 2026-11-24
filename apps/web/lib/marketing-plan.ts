import { tzSuffix } from "./tz";
import "server-only";
import { ALL_PLAN_POSTS, getRepo, nextMonday, schedulePlan, type ContentItem, type PlanPost } from "@engine/db";
import { hstToday } from "./utils";

/**
 * The marketing guide's posts and the entertain/educate/sell slate, put into the content pipeline as untested ideas on
 * the weekly pillar calendar. Each one needs review and a test before it can go to the approvals queue.
 */

export const planId = (ref: string) => `plan-${ref}`;
export type PlanMeta = PlanPost & { gates: { reviewed: boolean; tested: boolean; reviewed_by?: string; tested_by?: string }; launch_start: string };
export const isPlanItem = (c: ContentItem) => c.id.startsWith("plan-") && !!(c.meta as Partial<PlanMeta>).pillar;

/** 8:00 a.m. desk time on a plan date. */
const at = (day: string | null) => (day ? new Date(`${day}T08:00:00${tzSuffix()}`).toISOString() : null);

/** Add the posts that aren't in the pipeline yet; reschedule ones still at "idea" to the given launch Monday. */
export async function importPlan(launchStart?: string): Promise<{ added: number; rescheduled: number; launch_start: string }> {
  const repo = getRepo();
  const start = nextMonday(launchStart && /^\d{4}-\d{2}-\d{2}$/.test(launchStart) ? launchStart : hstToday());
  const dates = schedulePlan(start);
  const existing = new Map((await repo.list("content_items")).filter((c) => c.id.startsWith("plan-")).map((c) => [c.id, c]));
  const add: ContentItem[] = [];
  let rescheduled = 0;
  for (const p of ALL_PLAN_POSTS) {
    const cur = existing.get(planId(p.ref));
    if (cur) {
      if (cur.status === "idea") {
        await repo.update("content_items", { id: cur.id }, { scheduled_at: at(dates[p.ref]), meta: { ...cur.meta, launch_start: start } });
        rescheduled++;
      }
      continue;
    }
    const meta: PlanMeta = { ...p, gates: { reviewed: false, tested: false }, launch_start: start };
    add.push({
      id: planId(p.ref), platform: p.channel === "tiktok" ? "tiktok" : "instagram", kind: p.kind ?? "reel", status: "idea",
      title: `${p.ref} · ${p.title}`, caption: p.hook, media_url: null, scheduled_at: at(dates[p.ref]), posted_at: null,
      views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: p.source, meta: meta as unknown as Record<string, unknown>,
    });
  }
  if (add.length) await repo.insert("content_items", add);
  return { added: add.length, rescheduled, launch_start: start };
}

/** Plan items in the pipeline and the launch Monday they were scheduled from. */
export async function planState(): Promise<{ items: ContentItem[]; launch_start: string | null; missing: number }> {
  const items = (await getRepo().list("content_items")).filter(isPlanItem);
  const launch_start = (items[0]?.meta as Partial<PlanMeta> | undefined)?.launch_start ?? null;
  return { items, launch_start, missing: ALL_PLAN_POSTS.length - items.length };
}
