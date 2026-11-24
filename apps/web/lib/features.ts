// Client-safe (no server-only imports): the desk pages and the server both read it.

/**
 * The feature a video sells. Every ad and trial reel carries one, so results roll up by feature and each feature
 * gets its own ad set (an even share of the budget), which keeps the comparison fair.
 *
 * A video's feature is its `feature` tag when one was set by hand; otherwise it is read from its hook, script and
 * caption by the keyword lists below (the hook decides whenever it matches; the rest breaks ties).
 */
export const FEATURES = [
  { id: "custom_tours", name: "Custom tours", color: "#2563eb", words: ["tour", "walking tour", "guided", "your own route", "route for you", "itinerary for you"] },
  { id: "trip_guide", name: "Simple trip guide", color: "#0891b2", words: ["plan", "planning", "research", "tabs", "guide", "itinerary", "list", "covered", "flight and the hotel", "take care of the rest", "free day", "hours free", "afternoon"] },
  { id: "like_a_local", name: "Travel like a local", color: "#d97706", words: ["local", "locals", "no english menu", "counter", "izakaya", "neighborhood", "neighbourhood", "the food", "where they eat"] },
  { id: "get_lost", name: "Getting lost", color: "#0f766e", words: ["get lost", "getting lost", "no plan", "don't follow the crowd", "in-between", "in between", "just go", "spontan", "long way", "aren't lost", "aren’t lost"] },
  { id: "hidden_gems", name: "Hidden gems", color: "#e11d48", words: ["hidden", "gem", "secret", "can't search", "can’t search", "not on instagram", "not on google", "same 5 spots", "same places", "sends everyone", "sent you here", "couldn't send", "couldn’t send", "isn't on your feed", "isn’t on your feed", "everyone photographs", "most people", "the feed", "the crowd", "nobody"] },
  { id: "gamification", name: "Gamification", color: "#7c3aed", words: ["riddle", "unlock", "quest", "challenge", "solve", "points", "badge", "collect", "game", "level up"] },
] as const;
export type FeatureId = (typeof FEATURES)[number]["id"] | "other";
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
