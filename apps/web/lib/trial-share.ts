import "server-only";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { MetaAds } from "@engine/connectors";

/**
 * A public link to one reel file, just while Instagram fetches it.
 *
 * Instagram only makes a trial reel from a `video_url` upload (trial_params on a resumable upload is ignored and the
 * reel goes out as a normal one). The videos live on this machine, so the desk serves the share folder on 127.0.0.1
 * and opens a Cloudflare quick tunnel to it (no account or token). The server only answers random-named .mp4 files
 * in the share folder; each file is deleted once the post is done, and the tunnel closes after a few idle minutes.
 */

const DATA = process.env.REEL_DATA_DIR || path.resolve(process.cwd(), "../../services/reel-engine/reel-data");
const DIR = path.join(DATA, "ads", "_trialshare");
const PORT = Number(process.env.DESK_SHARE_PORT) || 3999;
const IDLE_MS = 5 * 60_000;
const BIN = () => process.env.CLOUDFLARED_PATH || path.join(process.env.LOCALAPPDATA || "", "cloudflared", "cloudflared.exe");

interface Share { server?: http.Server; tunnel?: ChildProcess; url?: Promise<string>; busy: number; idle?: NodeJS.Timeout }
const g = globalThis as { __trialShare?: Share };
const st = (g.__trialShare ??= { busy: 0 });

function serve(): Promise<void> {
  if (st.server) return Promise.resolve();
  fs.mkdirSync(DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || "").split("?")[0].replace(/^\/+/, ""));
    const p = path.join(DIR, name);
    if (!/^[a-f0-9-]{36}\.mp4$/.test(name) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(p).size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(p).pipe(res);
  });
  st.server = server;
  return new Promise((ok, bad) => {
    server.once("error", (e) => { st.server = undefined; bad(new Error(`The trial-reel share server couldn't start on port ${PORT}: ${e.message}`)); });
    server.listen(PORT, "127.0.0.1", () => ok());
  });
}

function tunnel(): Promise<string> {
  if (st.url) return st.url;
  const bin = BIN();
  if (!fs.existsSync(bin)) return Promise.reject(new Error(`Trial reels need cloudflared for a public link; it isn't at ${bin} (set CLOUDFLARED_PATH).`));
  st.url = new Promise<string>((ok, bad) => {
    const p = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { windowsHide: true });
    st.tunnel = p;
    let out = "";
    const t = setTimeout(() => { close(); bad(new Error("The Cloudflare tunnel didn't open in 60 s")); }, 60_000);
    const read = (b: Buffer) => {
      out = (out + b.toString()).slice(-4000);
      const u = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(out)?.[0];
      if (u) { clearTimeout(t); ok(u); }
    };
    p.stdout.on("data", read); p.stderr.on("data", read);
    p.once("exit", () => { clearTimeout(t); st.tunnel = undefined; st.url = undefined; bad(new Error("The Cloudflare tunnel closed")); });
  });
  st.url.catch(() => { st.url = undefined; });
  return st.url;
}

function close() {
  st.tunnel?.kill(); st.tunnel = undefined; st.url = undefined;
  st.server?.close(); st.server = undefined;
}

/** Run `fn` with a public https link to `video`; the file is deleted after and the tunnel closes when idle. */
export async function withPublicLink<T>(video: Blob, fn: (url: string) => Promise<T>): Promise<T> {
  st.busy++;
  if (st.idle) { clearTimeout(st.idle); st.idle = undefined; }
  const file = path.join(DIR, `${crypto.randomUUID()}.mp4`);
  try {
    await serve();
    const base = await tunnel();
    fs.writeFileSync(file, Buffer.from(await video.arrayBuffer()));
    const url = `${base}/${path.basename(file)}`;
    // a new quick tunnel takes a while to resolve, and this machine's DNS can hold on to the miss: check for up to
    // 3 minutes, then hand the link to Instagram anyway (its fetch fails the container if the link is really down)
    for (let i = 0; i < 18; i++) {
      const h = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (h?.ok) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    return await fn(url);
  } finally {
    fs.rmSync(file, { force: true });
    if (--st.busy === 0) st.idle = setTimeout(close, IDLE_MS);
  }
}

/** Post a reel as a trial reel (non-followers first), through a public link. */
export function publishTrialReel(m: MetaAds, video: Blob, caption: string) {
  return withPublicLink(video, (videoUrl) => m.publishReel({ videoUrl, caption, trial: true }));
}
