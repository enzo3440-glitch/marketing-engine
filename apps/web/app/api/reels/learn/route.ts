import { getRepo, hookVerdicts, REEL_FORMATS } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { engine, perfRows } from "@/lib/reels";

/** Leaderboard + next matrix (engine POST /learn, or the local port in stub mode); applies hook promote/retire rules. */
export async function POST() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const repo = getRepo();
  const rows = await perfRows();
  const hooks = await repo.list("reel_hooks");
  const result = await engine().learn(rows, hooks.filter((h) => h.status !== "retired").map((h) => ({ id: h.id, text: h.text })), REEL_FORMATS);
  const verdicts = hookVerdicts(rows);
  const changed: string[] = [];
  for (const [id, v] of Object.entries(verdicts)) {
    const h = hooks.find((x) => x.id === id);
    if (h && v !== "testing" && h.status !== v) {
      await repo.update("reel_hooks", { id }, { status: v });
      changed.push(`${id} → ${v}`);
    }
  }
  return Response.json({ ...result, rows: rows.length, changed });
}
