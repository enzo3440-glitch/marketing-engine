// Client-safe (no server-only imports): the desk pages and the server both read it.

/**
 * The feature a video sells. Every ad and trial reel carries one, so results roll up by feature and each feature
 * gets its own ad set (an even share of the budget), which keeps the comparison fair.
 *
 * A video's feature is its `feature` tag when one was set by hand; otherwise it is read from its hook, script and
 * caption by the keyword lists below (the hook decides whenever it matches; the rest breaks ties).
 */
export interface Feature { id: string; name: string; color: string; words: readonly string[]; angle?: string }

const FALLBACK: Feature[] = [
  { id: "problem_solution", name: "Problem → solution", color: "#2563eb", words: ["tired of", "the old way", "instead", "no more", "skip the"] },
  { id: "how_it_works", name: "How it works", color: "#0891b2", words: ["how", "in seconds", "tap", "step", "easy"] },
];

/** Read from services/reel-engine/knowledge/features.json at build time (next.config.mjs puts it in DESK_FEATURES). */
function load(): Feature[] {
  try {
    const raw = process.env.DESK_FEATURES;
    const list = raw ? (JSON.parse(raw) as { features?: Feature[] }).features : null;
    const ok = (list ?? []).filter((f) => f && typeof f.id === "string" && typeof f.name === "string" && Array.isArray(f.words));
    return ok.length ? ok.map((f) => ({ ...f, color: f.color || "#64748b", words: f.words.map((w) => String(w).toLowerCase()) })) : FALLBACK;
  } catch { return FALLBACK; }
}

export const FEATURES: readonly Feature[] = load();
export type FeatureId = string;
export const FEATURE_IDS = FEATURES.map((f) => f.id) as FeatureId[];
export const featureName = (id: string) => FEATURES.find((f) => f.id === id)?.name ?? "Unsorted";
export const featureColor = (id: string) => FEATURES.find((f) => f.id === id)?.color ?? "#64748b";

const hits = (text: string, words: readonly string[]) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

/** The feature a video sells: its hand-set tag, else the best keyword match (hook first, then script, caption and ask). */
export function featureOf(v: { hook?: string | null; caption?: string | null; tags?: Record<string, string> | null }): FeatureId {
  const t = v.tags ?? {};
  if (t.feature && (FEATURE_IDS.includes(t.feature as FeatureId) || t.feature === "other")) return t.feature as FeatureId;
  const hook = `${v.hook ?? ""} ${t.title ?? ""}`.toLowerCase();
  const rest = `${t.script ?? ""} ${v.caption ?? ""} ${t.revision_ask ?? ""}`.toLowerCase();
  // the hook decides when it names a feature at all; the script and caption only break ties or fill in
  let best: FeatureId = "other", top = 0;
  for (const f of FEATURES) {
    const s = 100 * hits(hook, f.words) + hits(rest, f.words);
    if (s > top) { best = f.id; top = s; }
  }
  return best;
}
