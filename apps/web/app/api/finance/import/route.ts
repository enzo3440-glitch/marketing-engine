import { getRepo, type FinActual } from "@engine/db";
import { guardApi } from "@/lib/auth";

const COLS = ["month", "revenue", "paid_subs", "mau", "ad_spend", "api_spend", "infra_spend", "payroll", "other_opex", "cash_end"] as const;

export async function POST(req: Request) {
  const s = await guardApi("finance");
  if (s instanceof Response) return s;
  const text = await req.text();
  if (text.length > 200_000) return Response.json({ error: "CSV too large" }, { status: 413 });
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const header = lines.shift()?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
  if (!header.includes("month")) return Response.json({ error: `header must include month and any of: ${COLS.join(", ")}` }, { status: 400 });
  const repo = getRepo();
  const existing = await repo.list("fin_actuals");
  const rows: FinActual[] = [];
  for (const [i, line] of lines.entries()) {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const rec = Object.fromEntries(header.map((h, j) => [h, cells[j]]));
    const m = /^(\d{4})-(\d{2})/.exec(rec.month ?? "");
    if (!m) return Response.json({ error: `row ${i + 2}: month must be YYYY-MM` }, { status: 400 });
    const month = `${m[1]}-${m[2]}-01`;
    const prev = existing.find((e) => e.month === month);
    const row = { ...(prev ?? { revenue: 0, paid_subs: 0, mau: 0, ad_spend: 0, api_spend: 0, infra_spend: 0, payroll: 0, other_opex: 0, cash_end: 0 }), month } as FinActual;
    for (const k of COLS.slice(1)) {
      if (rec[k] == null || rec[k] === "") continue;
      const v = Number(rec[k].replace(/[$\s]/g, ""));
      if (!Number.isFinite(v)) return Response.json({ error: `row ${i + 2}: ${k} is not a number` }, { status: 400 });
      (row as unknown as Record<string, number>)[k] = v;
    }
    rows.push(row);
  }
  await repo.upsert("fin_actuals", rows, "month");
  return Response.json({ rows: rows.length });
}
