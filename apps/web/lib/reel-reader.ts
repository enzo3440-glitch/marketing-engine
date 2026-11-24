import "server-only";
import { existsSync } from "node:fs";

/**
 * Reads a reel from its link the way a viewer would: opens it in a headless copy of the installed Chrome/Edge,
 * plays it through, and measures it. Nothing is saved: cuts and color are computed in the page, and a few small
 * frames come back in memory for the engine to read on-screen text from.
 */

export interface ShotFx { into: "cut" | "dissolve" | "flash" | "whip"; into_dur?: number; zoom: number; pan: number }

export interface ReelReading {
  video: boolean;
  duration?: number; width?: number; height?: number;
  /** shot lengths in seconds, in order (the template's fixed cuts) */
  shots?: number[];
  /** per shot: how it comes in (hard cut, dissolve, flash, whip) and the camera inside it (zoom > 1 = push in, pan) */
  shot_fx?: ShotFx[];
  /** frames sampled every ~0.6s for text, as JPEG data URLs (memory only) */
  frames?: { t: number; jpg: string }[];
  /** average look over the reel: 0..1 saturation, warmth (-1 cool .. 1 warm), brightness, contrast */
  color?: { sat: number; warm: number; bright: number; contrast: number; mono: boolean };
  caption?: string | null;
  description?: string | null;
  /** the sound it uses, from Instagram's embed page; original = the creator's own audio, not a library song */
  sound?: { song: string; artist: string | null; original: boolean };
  images?: number;
  error?: string;
}

const BROWSERS = [
  process.env.REEL_READER_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter((p): p is string => !!p);

/** In-page: play the reel through, diff every presented frame for cuts, then sample frames for text + color. */
const READ_IN_PAGE = async () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let v: HTMLVideoElement | undefined;
  for (let i = 0; i < 60 && !v; i++) {
    v = [...document.querySelectorAll("video")].find((x) => x.readyState >= 1 && isFinite(x.duration) && x.duration > 0);
    if (!v) await wait(250);
  }
  const caption = document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;
  const description = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? null;
  if (!v) return { video: false, caption, description, images: [...document.querySelectorAll("article img, main img")].filter((i) => (i as HTMLImageElement).naturalWidth > 300).length };
  const vid = v;
  const W = 64, H = 36, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  const small = () => { g.drawImage(vid, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
  const luma = (d: Uint8ClampedArray) => { const a = new Float32Array(W * H); for (let i = 0; i < W * H; i++) a[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; return a; };
  vid.muted = true; vid.loop = false; vid.pause(); vid.currentTime = 0; await wait(300);
  const diffs: [number, number][] = []; let prev: Float32Array | null = null, done = false;
  const lums: { t: number; a: Float32Array }[] = [];  // every presented frame, tiny: for transitions and camera moves
  const onFrame = (_: number, meta: { mediaTime: number }) => {
    const a = luma(small());
    if (prev) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - prev[i]); diffs.push([meta.mediaTime, s / a.length]); }
    prev = a; lums.push({ t: meta.mediaTime, a });
    if (!done) vid.requestVideoFrameCallback(onFrame);
  };
  vid.requestVideoFrameCallback(onFrame);
  vid.playbackRate = 1;  // real time: headless Chrome drops frames at 2x and short cuts get missed
  const end = new Promise<void>((r) => {
    vid.addEventListener("ended", () => r(), { once: true });
    const iv = setInterval(() => { if (vid.currentTime >= vid.duration - 0.05 || (vid.paused && vid.currentTime > 0.5)) { clearInterval(iv); r(); } }, 200);
  });
  await vid.play().catch(() => {});
  await Promise.race([end, wait(vid.duration * 1000 + 20000)]);
  done = true; vid.pause(); vid.playbackRate = 1;
  const vals = diffs.map((d) => d[1]).sort((x, y) => x - y); const med = vals[Math.floor(vals.length / 2)] || 1;
  let cuts = diffs.filter((d, i) => d[1] > Math.max(18, med * 4) && d[1] >= (diffs[i - 1]?.[1] || 0) && d[1] >= (diffs[i + 1]?.[1] || 0)).map((d) => d[0]);
  cuts = cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 0.1);
  // ---- how each shot comes in, and how the camera moves inside it ----
  const md = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const mean = (a: Float32Array) => a.reduce((x, y) => x + y, 0) / a.length;
  /** a sampled about the centre, scaled by s and shifted by dx: how b looks if it is a zoomed/panned a */
  const warp = (a: Float32Array, s: number, dx: number) => {
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.round(W / 2 + (x - W / 2) / s - dx), sy = Math.round(H / 2 + (y - H / 2) / s);
      o[y * W + x] = a[Math.min(H - 1, Math.max(0, sy)) * W + Math.min(W - 1, Math.max(0, sx))];
    }
    return o;
  };
  const best = (a: Float32Array, b: Float32Array, scales: number[], shifts: number[]) => {
    let r = { s: 1, dx: 0, d: md(a, b) };
    for (const s of scales) for (const dx of shifts) { const d = md(warp(a, s, dx), b); if (d < r.d - 0.2) r = { s, dx, d }; }
    return r;
  };
  const at = (t: number) => { let k = 0; while (k < lums.length - 1 && lums[k].t < t) k++; return k; };
  // dissolves: no single spike, but several frames in a row all changing, the picture differs before vs after, and
  // (what tells a real crossfade from fast motion or motion blur) the middle frame IS a blend of the two: it sits
  // much closer to their average than to either one
  const hard = Math.max(18, med * 4);
  const dissolves: { t: number; dur: number }[] = [];
  for (let i = 0; i < diffs.length;) {
    let j = i;
    while (j < diffs.length && diffs[j][1] > Math.max(5, med * 2.2) && diffs[j][1] < hard) j++;
    if (j - i >= 4 && j - i <= 24) {
      const a = lums[Math.max(0, i - 1)]?.a, b = lums[Math.min(lums.length - 1, j + 1)]?.a, m = lums[Math.floor((i + j) / 2) + 1]?.a;
      if (a && b && m && md(a, b) > Math.max(22, med * 6)) {
        const mix = new Float32Array(a.length); for (let q = 0; q < a.length; q++) mix[q] = (a[q] + b[q]) / 2;
        if (md(m, mix) < 0.55 * Math.min(md(m, a), md(m, b))) dissolves.push({ t: diffs[Math.floor((i + j) / 2)][0], dur: diffs[j - 1][0] - diffs[i][0] });
      }
    }
    i = Math.max(j, i + 1);
  }
  for (const d of dissolves) if (!cuts.some((c) => Math.abs(c - d.t) < 0.25)) cuts.push(d.t);
  cuts.sort((x, y) => x - y);
  const bounds = [0, ...cuts, vid.duration];
  const shots = bounds.slice(1).map((b, i) => +(b - bounds[i]).toFixed(3));
  const SC = [0.86, 0.9, 0.94, 0.97, 1, 1.03, 1.07, 1.11, 1.16], SH = [-6, -3, 0, 3, 6];
  const shot_fx = bounds.slice(1).map((b, i) => {
    const a0 = bounds[i], k0 = at(a0), k1 = at(b) - 1;
    // into this shot: a dissolve found above, a white/bright flash frame, a whip (big sideways smear), else a hard cut
    let into: "cut" | "dissolve" | "flash" | "whip" = "cut", into_dur = 0;
    if (i > 0) {
      const dz = dissolves.find((d) => Math.abs(d.t - a0) < 0.25);
      const near = lums.slice(Math.max(0, k0 - 2), k0 + 2);
      if (dz) { into = "dissolve"; into_dur = +dz.dur.toFixed(2); }
      else if (near.some((f) => mean(f.a) > 215) && mean(lums[Math.max(0, k0 - 3)].a) < 190) into = "flash";
      else if (k0 > 1 && k0 < lums.length - 1) {
        const w = best(lums[k0 - 1].a, lums[k0].a, [1], [-12, -8, -4, 4, 8, 12]);
        if (Math.abs(w.dx) >= 8 && w.d < md(lums[k0 - 1].a, lums[k0].a) * 0.6) into = "whip";
      }
    }
    // camera inside the shot: first vs last steady frame (scale > 1 = pushing in). Only kept when it's a real move:
    // the warp explains the change much better than no move, and the halfway frame is partway there (a steady push
    // or drift, not subject motion or a lucky match)
    let zoom = 1, pan = 0;
    if (k1 - k0 >= 12) {
      const A = lums[k0 + 1].a, B = lums[k1 - 1].a, M = lums[Math.floor((k0 + k1) / 2)].a;
      const m = best(A, B, SC, SH);
      if ((m.s !== 1 || m.dx !== 0) && m.d < 0.7 * md(A, B)) {
        const h = best(A, M, SC, SH);
        const towards = (h.s - 1) * (m.s - 1) > 0 || (m.s === 1 && Math.sign(h.dx) === Math.sign(m.dx));
        if (towards && Math.abs(h.s - 1) <= Math.abs(m.s - 1) + 0.02) { zoom = m.s; pan = m.dx / W; }
      }
    }
    return { into, ...(into_dur ? { into_dur } : {}), zoom: +zoom.toFixed(3), pan: +pan.toFixed(3) };
  });
  // frames for text (every ~0.6s, at most 28) + color stats
  const seek = (t: number) => new Promise<void>((r) => { const f = () => { vid.removeEventListener("seeked", f); r(); }; vid.addEventListener("seeked", f); vid.currentTime = t; setTimeout(r, 2000); });
  const n = Math.min(28, Math.ceil(vid.duration / 0.6)), step = vid.duration / n;
  // full width (up to 1080): small captions (a 12px line at 540 wide) are lost to OCR at half size
  const fw = Math.min(1080, vid.videoWidth || 540), fh = Math.round((fw * vid.videoHeight) / vid.videoWidth);
  const big = document.createElement("canvas"); big.width = fw; big.height = fh; const bg = big.getContext("2d")!;
  const frames: { t: number; jpg: string }[] = [];
  let sat = 0, warm = 0, bright = 0, contrast = 0;
  for (let i = 0; i < n; i++) {
    const t = +(i * step + step / 2).toFixed(2);
    await seek(t);
    bg.drawImage(vid, 0, 0, fw, fh); frames.push({ t, jpg: big.toDataURL("image/jpeg", 0.8) });
    const d = small(); let s = 0, w = 0, b = 0, b2 = 0;
    for (let k = 0; k < W * H; k++) {
      const r = d[k * 4] / 255, gg = d[k * 4 + 1] / 255, bl = d[k * 4 + 2] / 255;
      const mx = Math.max(r, gg, bl), mn = Math.min(r, gg, bl), l = 0.3 * r + 0.59 * gg + 0.11 * bl;
      s += mx ? (mx - mn) / mx : 0; w += r - bl; b += l; b2 += l * l;
    }
    const m = W * H; sat += s / m; warm += w / m; bright += b / m; contrast += Math.sqrt(Math.max(0, b2 / m - (b / m) ** 2));
  }
  const color = { sat: +(sat / n).toFixed(3), warm: +(warm / n).toFixed(3), bright: +(bright / n).toFixed(3), contrast: +(contrast / n).toFixed(3), mono: sat / n < 0.06 };
  return { video: true, duration: +vid.duration.toFixed(2), width: vid.videoWidth, height: vid.videoHeight, shots, shot_fx, frames, color, caption, description };
};

export async function readReel(url: string): Promise<ReelReading> {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) return { video: false, error: "No Chrome or Edge found to read reels with (set REEL_READER_BROWSER)" };
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 }, locale: "en-US" });
    page.setDefaultTimeout(120_000);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const reading = (await page.evaluate(READ_IN_PAGE)) as ReelReading;
    // Instagram's embed page names the sound without signing in: "Song · Artist", or the creator's original audio
    const code = url.match(/instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/)?.[1];
    if (code) {
      await page.goto(`https://www.instagram.com/reel/${code}/embed/`, { waitUntil: "domcontentloaded" }).catch(() => null);
      const html = await page.content().catch(() => "");
      const field = (k: string) => html.match(new RegExp(`${k}\\\\*"\\s*:\\s*\\\\*"([^"\\\\]{1,120})`))?.[1];
      const song = field("song_name"), artist = field("artist_name");
      if (song) reading.sound = { song, artist: artist ?? null, original: /^original audio$/i.test(song) };
    }
    return reading;
  } catch (e) {
    return { video: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    await browser.close();
  }
}

export interface ReelMeta { caption: string | null; account: string | null; likes: number | null; posted: string | null }

/** Caption, account, likes and date from a reel page's meta tags: `135K likes, 153 comments - some_account on October 3, 2026: "…"`. */
export function parseMeta(description: string | null, ogTitle: string | null): ReelMeta {
  const d = description ?? "";
  const m = d.match(/^([\d.,]+[KkMm]?) likes?, [\d.,]+[KkMm]? comments? - ([\w.]+) on ([A-Z][a-z]+ \d{1,2}, \d{4}): "([\s\S]*)"?$/);
  const num = (s: string) => { const n = parseFloat(s.replace(/,/g, "")); return /[Kk]$/.test(s) ? n * 1e3 : /[Mm]$/.test(s) ? n * 1e6 : n; };
  const fromTitle = ogTitle?.match(/on (?:Instagram|TikTok): "([\s\S]*)"?$/)?.[1] ?? null;
  return {
    caption: (m?.[4] ?? fromTitle)?.replace(/"$/, "").trim() || null,
    account: m?.[2] ?? null, likes: m ? Math.round(num(m[1])) : null, posted: m?.[3] ?? null,
  };
}

/** Just the page metadata (caption, account, likes) for many reels: a page load each, no playback. */
export async function readMetas(urls: string[]): Promise<Record<string, ReelMeta | null>> {
  const exe = BROWSERS.find((p) => existsSync(p));
  const out: Record<string, ReelMeta | null> = {};
  if (!exe) return out;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--mute-audio"] });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    for (const url of urls) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
      const [desc, title] = await Promise.all([
        page.getAttribute('meta[name="description"]', "content").catch(() => null),
        page.getAttribute('meta[property="og:title"]', "content").catch(() => null),
      ]);
      out[url] = desc || title ? parseMeta(desc, title) : null;
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** Just the sounds' names, from Instagram's embed pages (rendered by script, so a headless page; no playback). */
export async function readSounds(urls: string[]): Promise<Record<string, ReelReading["sound"] | null>> {
  const exe = BROWSERS.find((p) => existsSync(p));
  const out: Record<string, ReelReading["sound"] | null> = {};
  if (!exe) return out;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--mute-audio"] });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    for (const url of urls) {
      const code = url.match(/instagram\.com\/(?:[\w.]+\/)?(?:reels?|p)\/([\w-]+)/)?.[1];
      if (!code) { out[url] = null; continue; }
      await page.goto(`https://www.instagram.com/reel/${code}/embed/`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
      await page.waitForTimeout(1500);
      const html = await page.content().catch(() => "");
      const field = (k: string) => html.match(new RegExp(`${k}\\\\*"\\s*:\\s*\\\\*"([^"\\\\]{1,120})`))?.[1];
      const song = field("song_name");
      out[url] = song ? { song, artist: field("artist_name") ?? null, original: /^original audio$/i.test(song) } : null;
    }
  } finally {
    await browser.close();
  }
  return out;
}

/**
 * A reel's sound, for local previews and beat sync of its template (posting still uses Instagram's sound).
 * Instagram streams audio and video separately; this catches the audio track's address as the page loads it
 * and fetches that one file whole (no re-recording, no quality loss).
 */
export async function readAudio(url: string): Promise<{ data: Buffer; type: string } | { error: string }> {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) return { error: "No Chrome or Edge found" };
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 900 }, locale: "en-US" });
    // streams are tagged in the url's efg param ({"vencode_tag": "...dash_..._audio", "xpv_asset_id": ...}); the page
    // also preloads the next reels, so take the audio of the same asset as the first video stream (the reel itself)
    let audioUrl: string | null = null, asset: string | null = null;
    const type = "audio/mp4";
    const audios: { url: string; asset: string }[] = [];
    page.on("response", (r) => {
      let tag = "";
      try { tag = Buffer.from(decodeURIComponent(new URL(r.url()).searchParams.get("efg") ?? ""), "base64").toString(); } catch { return; }
      const id = tag.match(/"xpv_asset_id":(\d+)/)?.[1] ?? "";
      if (!/vencode_tag/.test(tag)) return;
      if (/_audio/.test(tag)) audios.push({ url: r.url(), asset: id });
      else if (id) asset ??= id;
      audioUrl = (asset && audios.find((a) => a.asset === asset)?.url) || null;
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    for (let i = 0; i < 40 && !audioUrl; i++) {
      await page.evaluate(() => { const v = document.querySelector("video"); if (v) { v.muted = true; void v.play().catch(() => {}); } }).catch(() => {});
      await page.waitForTimeout(500);
    }
    if (!audioUrl) return { error: "no separate audio track on this reel" };
    const whole = new URL(audioUrl as string);
    whole.searchParams.delete("bytestart"); whole.searchParams.delete("byteend");
    const res = await page.request.get(whole.toString(), { timeout: 120_000 });
    if (!res.ok()) return { error: `audio fetch failed (${res.status()})` };
    const data = await res.body();
    return data.length > 10_000 ? { data, type } : { error: "audio track came back empty" };
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  } finally {
    await browser.close();
  }
}

/** The library grade closest to a measured look. */
export function gradeFor(c: NonNullable<ReelReading["color"]>): string {
  if (c.mono) return "mono";
  if (c.warm > 0.12 && c.sat > 0.35) return "golden";
  if (c.warm < -0.05 && c.contrast > 0.2) return "teal_orange";
  if (c.sat > 0.5) return "tropical";
  if (c.bright < 0.32 && c.sat < 0.35) return "moody";
  if (c.sat < 0.32) return "film";
  return "clean";
}
