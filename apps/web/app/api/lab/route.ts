import { getRepo } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { createTest, planFor, spendable } from "@/lib/improve";

export const dynamic = "force-dynamic";

/** Tests + what you can spend now + the budget plan a new test of `n` reels would get. */
export async function GET(req: Request) {
  const s = await guardApi("content", "growth");
  if (s instanceof Response) return s;
  const n = Number(new URL(req.url).searchParams.get("n") ?? 8) || 8;
  const [tests, money, plan] = await Promise.all([getRepo().list("growth_tests", { order: { col: "created_at", asc: false } }), spendable(true).catch(() => null), planFor(n).catch(() => null)]);
  return Response.json({ tests, money, plan });
}

/** {name, picks: [{job_id, variant_id, caption?, content_id?}]} → a new test at the trial stage. */
export async function POST(req: Request) {
  const s = await guardApi("content", "growth");
  if (s instanceof Response) return s;
  try {
    return Response.json(await createTest(await req.json()));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
