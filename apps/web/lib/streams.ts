import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { ReelVariant } from "@engine/db";

/**
 * Two streams, two jobs:
 *  - "ig": Instagram reels and posts, mostly trial reels, as many a day as Instagram allows. Analog, real, cool, not
 *    commercial: the place and the feeling, the app at most a small card. Grows followers and sells the app quietly.
 *  - "ad": Meta ad campaigns. The commercial driver: a clear problem, the app big on screen, a CTA, installs.
 * A video's stream is its own tag if set (Launch's "move to" switch), else the stream its /brag folder was made for,
 * else ads for /brag product ads and Instagram for everything else (reels, carousels, uploads).
 */
export type Stream = "ig" | "ad";

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const FILE = path.join(DATA, "ads", "_streams.json");

const read = (): Record<string, Stream> => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } };

/** Remember which stream a /brag folder was made for (its tweaks inherit it). */
export function markFolder(folder: string, stream: Stream) {
  const m = read();
  m[folder] = stream;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(m, null, 1));
}

export function streamOf(v: Pick<ReelVariant, "tags">, folders = read()): Stream {
  const t = v.tags ?? {};
  if (t.stream === "ig" || t.stream === "ad") return t.stream;
  if (t.brag && folders[t.brag]) return folders[t.brag];
  return String(t.made_by ?? "").startsWith("brag") ? "ad" : "ig";
}
export const streamFolders = read;
