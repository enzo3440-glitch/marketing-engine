// TypeScript port of services/reel-engine/engine/learn.py so the leaderboard works with no engine running.
// Keep the two in step; the engine's POST /learn is preferred when VIDEO_ENGINE_URL is set.

export interface PerfRow {
  variant_id: string; platform: "ig" | "tiktok"; views?: number; avg_watch_s?: number; duration_s?: number;
  likes?: number; shares?: number; saves?: number; comments?: number; follows?: number;
  tags?: Record<string, string | undefined>;
}
export interface LeaderEntry { value: string; n: number; mean_z: number; shrunk: number }
export type Leaderboard = Record<string, LeaderEntry[]>;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function variantScore(r: PerfRow): number {
  const v = Math.max(r.views ?? 0, 1);
  const ret = Math.min((r.avg_watch_s ?? 0) / Math.max(r.duration_s ?? 1, 1), 1.5);
  const send = (((r.shares ?? 0) * 2 + (r.saves ?? 0) * 1.5) / v) * 100;
  const eng = (((r.likes ?? 0) + 2 * (r.comments ?? 0) + 3 * (r.follows ?? 0)) / v) * 100;
  return r3(0.45 * ret * 10 + 0.25 * send + 0.15 * eng + 0.15 * Math.log10(v));
}

// template / vibe / opening / hook come from director test sets: they spell out the winning formula
export function leaderboard(rows: PerfRow[], dims = ["template", "vibe", "opening", "hook", "hook_id", "format", "pacing", "grade", "music"]): Leaderboard {
  if (!rows.length) return {};
  const byPf = new Map<string, PerfRow[]>();
  for (const r of rows) byPf.set(r.platform ?? "ig", [...(byPf.get(r.platform ?? "ig") ?? []), r]);
  const z: [PerfRow, number][] = [];
  for (const rs of byPf.values()) {
    const s = rs.map(variantScore);
    const mu = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(s.length - 1, 1)) || 1;
    rs.forEach((r, i) => z.push([r, (s[i] - mu) / sd]));
  }
  const k = 3; // prior strength in "posts"
  const out: Leaderboard = {};
  for (const d of dims) {
    const acc = new Map<string, number[]>();
    for (const [r, zz] of z) {
      const val = r.tags?.[d];
      if (val) acc.set(val, [...(acc.get(val) ?? []), zz]);
    }
    out[d] = [...acc.entries()]
      .map(([value, xs]) => ({ value, n: xs.length, mean_z: r3(xs.reduce((a, b) => a + b, 0) / xs.length), shrunk: r3(xs.reduce((a, b) => a + b, 0) / (xs.length + k)) }))
      .sort((a, b) => b.shrunk - a.shrunk);
  }
  return out;
}

export interface NextMatrix {
  formats: string[]; hooks: { id: string; text: string }[];
  rationale: { winning_hooks: string[]; winning_formats: string[]; exploring: string[] }; max: number;
}

export function nextMatrix(rows: PerfRow[], hooksPool: { id: string; text: string }[], formatsPool: string[], explore = 0.3, size = 12): NextMatrix {
  const lb = leaderboard(rows);
  const tested = new Set((lb.hook_id ?? []).map((x) => x.value));
  const topH = (lb.hook_id ?? []).filter((x) => x.shrunk > 0).slice(0, 3).map((x) => x.value);
  let topF = (lb.format ?? []).filter((x) => x.shrunk > 0).slice(0, 2).map((x) => x.value);
  if (!topF.length) topF = formatsPool.slice(0, 2);
  const newH = hooksPool.filter((h) => !tested.has(h.id)).map((h) => h.id);
  const nExplore = Math.max(1, Math.floor(size * explore));
  const pickH = new Set([...topH, ...newH.slice(0, nExplore)]);
  const pickF = [...topF, ...formatsPool.filter((f) => !topF.includes(f)).slice(0, 1)];
  return {
    formats: pickF, hooks: hooksPool.filter((h) => pickH.has(h.id)),
    rationale: { winning_hooks: topH, winning_formats: topF, exploring: newH.slice(0, nExplore) }, max: size,
  };
}

/** Contract rule: retire a hook after 3 posts below the platform median; winner after 2 above. */
export function hookVerdicts(rows: PerfRow[]): Record<string, "winner" | "retired" | "testing"> {
  const byPf = new Map<string, number[]>();
  for (const r of rows) byPf.set(r.platform, [...(byPf.get(r.platform) ?? []), variantScore(r)]);
  const median = new Map([...byPf.entries()].map(([pf, s]) => {
    const t = [...s].sort((a, b) => a - b);
    return [pf, t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2];
  }));
  const tally = new Map<string, { above: number; below: number }>();
  for (const r of rows) {
    const h = r.tags?.hook_id;
    if (!h) continue;
    const t = tally.get(h) ?? { above: 0, below: 0 };
    if (variantScore(r) > (median.get(r.platform) ?? 0)) t.above++; else t.below++;
    tally.set(h, t);
  }
  const out: Record<string, "winner" | "retired" | "testing"> = {};
  for (const [h, t] of tally) out[h] = t.below >= 3 ? "retired" : t.above >= 2 ? "winner" : "testing";
  return out;
}
