// Clip reads: Claude (any MCP client, incl. `claude -p` on a Claude Max login) looks at each clip and says how
// striking it is, what's in it, which scene it belongs to and which seconds to use. The editor ranks shots by it.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { desk, engine, readRepo, ToolError } from "../context";
import { define, McpContent } from "../tool";

export const CLIP_READ_GUIDE = `Judge raw phone footage for fast-cut montages on Instagram Reels, like a demanding picture editor:
most clips are average. Striking subjects (a striking subject, sweeping views, golden light, people moving through a space)
beat filler (hands, ground, dashboards, the fifth take of the same trail, dark or blurry frames).
rating 0..1: 0.9+ would stop a scroll, 0.5 usable filler, under 0.3 weak. scene: a short name shared by every take of the same
place or subject (reuse an existing name when it is the same bridge, campfire, road...). moments: the 1-3 best parts, 0.8-4s each,
in seconds. skip only when nothing is usable.
best_for: "hold" when the shot is majestic, vast or intricate and rewards a long look (sweeping mountain views, turquoise lakes,
a field of flowers, a cliff-edge view: the hero shots for long holds and the moment
after the drop); "quick" when it hits hard but
reads in a split second (a spark, a jump, a bold silhouette, a detail): flash-cut material; "both" if it does either.
Within one scene (several takes of the same bridge, campfire, lake), rate the most spectacular take clearly highest (e.g. the bridge
walk with the mountains behind it) so the editor uses that one and skips the rest. People simply walking rate lower than the
landscape they walk through unless the moment itself is remarkable.
Each moment's peak: the single most epic instant inside it (seconds). For a pan or tilt that reveals something, the peak is where
the full view is in frame (the whole valley and lake, not the mountain's edge before it); the editor lands short cuts on the peak
and lets long holds arrive at it, so a reveal never stops half-way. List the moments best first.`;

export function registerClips(server: McpServer) {
  define(server, "list_unread_clips", {
    title: "Clips waiting for a read", areas: ["content"], kind: "read",
    description: "Clips in the bin nobody has judged yet, plus the scene names already in use (reuse them for takes of the same thing).",
    input: { limit: z.number().int().min(1).max(200).default(50) },
  }, async ({ limit }) => {
    const clips = await readRepo().list("reel_clips", { order: { col: "added_at", asc: true } });
    const unread = clips.filter((c) => !c.read && c.kind !== "reference");
    return {
      guide: CLIP_READ_GUIDE,
      scenes: [...new Set(clips.map((c) => c.read?.scene).filter(Boolean))],
      unread: unread.slice(0, limit).map((c) => ({ id: c.id, file: c.file, duration: c.duration })),
      left: Math.max(0, unread.length - limit),
    };
  });

  define(server, "view_clip", {
    title: "Look at a clip", areas: ["content"], kind: "read",
    description: "A clip as 8 numbered moments on one image (each tile labelled with its time), to judge it with save_clip_read.",
    input: { id: z.string().describe("Clip id from list_unread_clips / list_reel_clips") },
  }, async ({ id }) => {
    const [c] = await readRepo().list("reel_clips", { eq: { id } });
    if (!c) throw new ToolError(`No clip ${id}`);
    const sheet = await engine().clipSheet(c.file);
    if (!sheet) throw new ToolError("The Reel Engine is in stub mode (VIDEO_ENGINE_URL unset): no frames to show.");
    return new McpContent([
      { type: "image", data: sheet.jpg, mimeType: "image/jpeg" },
      { type: "text", text: `${c.file} · ${sheet.duration}s · moments at ${sheet.times.map((t, i) => `${i + 1}=${t}s`).join(", ")}` },
    ]);
  });

  define(server, "save_clip_read", {
    title: "Save a clip read", areas: ["content"], kind: "write",
    description: "Store your judgement of a clip; the editor uses it to rank shots, cut to the best moments and space out takes of one scene.",
    input: {
      id: z.string(),
      rating: z.number().min(0).max(1),
      subject: z.string().describe("What is in it, a few words"),
      scene: z.string().describe("Short place/subject name shared by takes of the same thing"),
      moments: z.array(z.object({ t0: z.number(), t1: z.number(), peak: z.number().describe("the most epic instant, inside t0..t1"), why: z.string() })).max(3),
      best_for: z.enum(["hold", "quick", "both"]).describe("hold = majestic, rewards a long look; quick = reads in a split second"),
      skip: z.boolean().default(false),
      flaws: z.string().default(""),
    },
  }, async (read) => desk("POST", "/api/reels/clips/read", { reads: [read] }));
}
