// Ported from a marketing whiteboard (worker/index.js): validation, brief and brainstorm prompt.
// Client-safe (no server imports).
import type { MapNode, MarketingMapDoc } from "@engine/db/types";

export const NODE_FIELDS = ["title", "hook", "visual", "audio", "overlay", "cta", "hypothesis", "note"] as const;
export const CHANNEL_IDS = ["instagram", "ads", "tiktok"] as const;

export function validateMap(map: MarketingMapDoc): MarketingMapDoc {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(map.channels) || map.nodes.length > 100 || map.channels.length !== 3) throw Error("Map needs three channels and no more than 100 ideas.");
  const ids = new Set(map.channels.map((c) => c.id));
  if (!CHANNEL_IDS.every((x) => ids.has(x))) throw Error("Keep the three channel IDs.");
  const all = new Set(["root", ...ids]);
  for (const n of map.nodes) {
    if (typeof n.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(n.id) || all.has(n.id) || !ids.has(n.channel) || typeof n.title !== "string" || !n.title.trim() || typeof n.hook !== "string") throw Error("Invalid or duplicate idea.");
    all.add(n.id);
    for (const k of NODE_FIELDS) if (n[k] != null && (typeof n[k] !== "string" || n[k]!.length > 5000)) throw Error("Idea text is too long or invalid.");
  }
  if ((map.edges ?? []).length > 150) throw Error("Too many cross-links.");
  for (const e of map.edges ?? []) if (!all.has(e.from) || !all.has(e.to) || e.from === e.to) throw Error("Cross-link endpoints must exist.");
  if (JSON.stringify(map).length > 250000) throw Error("Map too large.");
  return map;
}

export function productionBrief(map: MarketingMapDoc, n: MapNode): string {
  const c = map.channels.find((x) => x.id === n.channel)!;
  return [
    "CREATIVE BRIEF", `Channel: ${c.title}`, `Objective: ${c.objective}`, `Concept: ${n.title}`, `Hook: ${n.hook}`,
    `Visual / shots: ${n.visual}`, `Audio: ${n.audio}`, `Overlay: ${n.overlay}`, `App proof / CTA: ${n.cta}`, `Hypothesis: ${n.hypothesis}`,
    `Success metric: ${c.metric}`, `Guardrail: ${n.note || "Use truthful product proof, original or licensed footage/music. This is a test, not a prediction."}`,
  ].join("\n\n");
}

export const brainstormPrompt = (map: MarketingMapDoc) =>
  "Brainstorm additions to this marketing map. Preserve its three channels and existing concepts. Return JSON only with nodes and optional edges. Each new node needs a unique id, channel (instagram/ads/tiktok), title, hook, visual, audio, overlay, cta, hypothesis and note, all strings. Edges use from/to node IDs. Be concrete and truthful; do not invent testimonials, product capabilities or performance. These are proposals for human review, not instructions to publish. Current map:\n" +
  JSON.stringify(map, null, 2);

/** Review step: reject unexpected shapes before anything is applied. */
export function reviewProposal(map: MarketingMapDoc, p: unknown): { nodes: MapNode[]; edges: { from: string; to: string }[] } {
  const prop = p as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(prop?.nodes) || prop.nodes.length > 20) throw Error("Use a nodes array with up to 20 additions.");
  const ids = new Set(map.nodes.map((n) => n.id));
  const nodes: MapNode[] = [];
  for (const raw of prop.nodes as Record<string, unknown>[]) {
    const n: MapNode = { id: String(raw.id ?? ""), channel: String(raw.channel ?? ""), title: String(raw.title ?? "") };
    for (const k of NODE_FIELDS) if (typeof raw[k] === "string") n[k] = raw[k] as string; // drop unexpected properties
    if (!n.id || ids.has(n.id) || !map.channels.some((c) => c.id === n.channel) || !n.title || !n.hook) throw Error("Each idea needs a new ID, valid channel, title and hook.");
    ids.add(n.id);
    nodes.push(n);
  }
  const edges = Array.isArray(prop.edges) ? (prop.edges as { from: unknown; to: unknown }[]).map((e) => ({ from: String(e.from), to: String(e.to) })) : [];
  validateMap({ ...map, nodes: [...map.nodes, ...nodes], edges: [...(map.edges ?? []), ...edges] });
  return { nodes, edges };
}
