// Daily 7:00 desk time: Content Strategist. Reviews post performance, the Reel Engine leaderboard, migrated CMO
// research and the Marketing Map; drafts next posts as content_items + post approvals.
import { ReelEngine } from "@engine/connectors";
import { efficacy, REEL_FORMATS, type PerfRow } from "@engine/db";
import { z } from "zod";
import { askJson, claudeEnabled } from "../claude";
import { propose, type Agent } from "../run";

const Plan = z.object({
  posts: z.array(z.object({
    title: z.string(), platform: z.enum(["instagram", "tiktok"]), kind: z.enum(["reel", "trial_reel", "post"]),
    hook: z.string(), format: z.enum(["oneshot", "montage", "cinematic", "pov", "reveal", "list", "talking", "podcast"]),
    why: z.string().describe("Evidence from the data provided; label hypotheses as hypotheses"),
    caption: z.string(),
  })).max(3),
});

export const cmo: Agent = async ({ repo, log, env }) => {
  const [content, recs, hooks, posts, variants, map] = await Promise.all([
    repo.list("content_items", { eq: { status: "posted" } }), repo.list("cmo_recommendations", { eq: { status: "new" } }),
    repo.list("reel_hooks"), repo.list("reel_posts"), repo.list("reel_variants"), repo.getMap(),
  ]);
  const rows: PerfRow[] = posts.map((p) => {
    const v = variants.find((x) => x.job_id === p.job_id && x.id === p.variant_id);
    return { variant_id: p.variant_id, platform: p.platform, views: p.views ?? 0, avg_watch_s: Number(p.avg_watch_s ?? 0), duration_s: Number(v?.duration ?? 12), likes: p.likes ?? 0, shares: p.shares ?? 0, saves: p.saves ?? 0, comments: p.comments ?? 0, follows: p.follows ?? 0, tags: v?.tags };
  });
  const learned = await ReelEngine.fromEnv(env).learn(rows, hooks.filter((h) => h.status !== "retired").map((h) => ({ id: h.id, text: h.text })), REEL_FORMATS);
  const top = [...content].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 8)
    .map((c) => ({ title: c.title, views: c.views, likes: c.likes, efficacy: efficacy(c), posted_at: c.posted_at }));

  let drafts: z.infer<typeof Plan>["posts"];
  if (claudeEnabled()) {
    ({ posts: drafts } = await askJson({
      system: [
        `You are ${env.BRAND_NAME || "our brand"}'s CMO. ${env.BRAND_PITCH || ""}`.trim(),
        "Creative laws: the hook is the first 2 seconds; name the thing and the feeling; real footage only; no invented claims, reviews or numbers.",
        "Banned phrases: 'you won't believe', 'game changer', 'secret hack'. Saves/shares are often unknown in the data: do not infer them.",
        "Recommend up to 3 next posts. Prefer winning hooks/formats from the leaderboard, keep ~30% exploration.",
      ].join("\n"),
      prompt: JSON.stringify({ top_posts: top, leaderboard: learned.leaderboard, next_matrix: learned.next, research: recs.slice(0, 12).map((r) => ({ title: r.title, hook: r.hook, evidence: r.evidence, confidence: r.confidence })), marketing_map: map.doc.nodes.map((n) => ({ channel: n.channel, title: n.title, hook: n.hook })), strategy: map.doc.strategy }).slice(0, 60000),
      schema: Plan, effort: "medium",
    }));
  } else {
    // Heuristic fallback: the engine's next matrix → one draft per picked hook.
    drafts = learned.next.hooks.slice(0, 2).map((h, i) => ({
      title: h.text, platform: i ? "tiktok" : "instagram", kind: "reel", hook: h.text, format: (learned.next.formats[i] ?? "montage") as "montage",
      why: `From the learn loop: ${learned.next.rationale.winning_hooks.includes(h.id) ? "winning hook" : "exploration slot"}.`, caption: h.text,
    }));
  }
  for (const d of drafts) {
    const id = `cmo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await repo.insert("content_items", [{ id, platform: d.platform, kind: d.kind, status: "draft", title: d.title, caption: d.caption, media_url: null, scheduled_at: null, posted_at: null, views: null, likes: null, saves: null, shares: null, attributed_signups: null, source: "cmo", meta: { hook: d.hook, format: d.format, why: d.why } }]);
    await propose(repo, { type: "post", agent: "cmo", ref_table: "content_items", ref_id: id, title: `${d.kind === "post" ? "Post" : "Reel"}: ${d.title}`, summary: d.why, preview: { caption: d.caption, platform: d.platform, hook: d.hook, format: d.format } });
  }
  log(`${drafts.length} drafts (${claudeEnabled() ? "Claude" : "heuristic"}, leaderboard via ${learned.source})`);
};
