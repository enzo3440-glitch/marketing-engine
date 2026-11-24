import "server-only";
import { getRepo, type ReelVariant } from "@engine/db";
import type { ReviseInfo } from "@engine/connectors";
import { claudeLook } from "./claude-look";
import { engine } from "./reels";
import { BRAND } from "./brand";

/**
 * Revise one finished video on request: Claude (headless Claude Code on the Max login, no API key) looks at the video's
 * brief, a contact sheet of the render and every clip its batch can use, and answers the brief edits that do what was
 * asked. The engine renders them as <video>-r<N> beside the original (engine/revise.py); the original stays.
 */
export interface Revision {
  status: "thinking" | "rendering" | "done" | "error"; ask: string; at: number;
  id?: string; summary?: string; error?: string;
}

// keyed "<job>/<video>"; on globalThis so a dev reload keeps what's running
const R = ((globalThis as { __revisions?: Map<string, Revision> }).__revisions ??= new Map<string, Revision>());

export function revisions(jobId: string): Record<string, Revision> {
  return Object.fromEntries([...R].filter(([k]) => k.startsWith(`${jobId}/`)).map(([k, v]) => [k.slice(jobId.length + 1), v]));
}

export function startRevision(jobId: string, variantId: string, ask: string): Revision {
  const key = `${jobId}/${variantId}`;
  const now = R.get(key);
  if (now && (now.status === "thinking" || now.status === "rendering")) throw new Error("already revising this video");
  const r: Revision = { status: "thinking", ask, at: Date.now() };
  R.set(key, r);
  run(jobId, variantId, r).catch((e) => Object.assign(r, { status: "error", error: (e as Error).message.replace(/^\d+ [\w ]+: /, "") }));
  return r;
}

const GUIDE = (i: ReviseInfo) => `# Revising one ${BRAND.name} video

You change one finished video by editing its brief. The engine renders the edited brief as a new copy beside the
original, so be bold enough to do what was asked, but change nothing else.

## Files
- brief.json: the video's current brief.
- render.jpg: 12 moments of the current render, numbered with their time.
- clips.jpg: one frame of every clip this batch can use, labelled with its id. clips.json lists them (kind: footage,
  "app screen (phone)" = a real app screen recording on the floating phone, "placeholder" = a labelled shot still to film)
  and the music files you may use.
- Current cut times (s): ${JSON.stringify(i.cuts ?? [])}; length ${i.duration ?? "?"}s.${i.warnings.length ? `\n- Readability warnings on the current render: ${i.warnings.join("; ")}` : ""}

## Brief fields you may change
${i.editable.join(", ")}
- sequence: the shots in order, [{"clip": id, "beats": n, "start": seconds into the clip}]. A shot lasts n beats of the
  song. Only clip ids from clips.json. Land on the payoff of a move, not its unfinished start.
- hook: the opening text (on screen from 0s); hook_pos top|upper|center.
- lines: [{"text", "shot": index into sequence, "to"?: last shot index, "pos"?: top|center|lower, "style"?: pill|hook|hook_serif}].
  Every line needs time to be read (about 0.3s per word + 1s). Fewer words beat cramming.
- endcard: "${BRAND.name}|tagline"; cta: the pill under it; endcard_hold: seconds the end card stays up (default 1.9; the
  tagline needs about 2.3s and the pill 2s to be read, so 2.6+ when they're flagged). A longer video doesn't lengthen it.
- caption: the post caption (why someone would send it to a friend).
- music: a file name from clips.json; music_start: where in the song to begin; sfx: true/false (soft taps and whooshes).
- build_drop + drop_shot k: quiet start, and the song's drop lands on shot k.
- duration: seconds (keep 12-20 for ads).

## Rules
- ${BRAND.name} is ${BRAND.pitch}. Text must be true: only features the app really
  has (what the app screens show), no invented facts about places, no claims the footage doesn't show.
- Product ads use the cleared tracks in assets/music/ads (see its README) with a few effects:
  never trending audio, funny or comic audio, unless the request asks for it.
- Keep the hook, the close and the app screens unless the request is about them.
- If the request needs something the brief can't do (new footage, a new app screen, a new feature), make no change and
  say what's needed in "note".
- Your summary says what you changed, not what it will look like: you can't see the new render.

## Answer
One JSON object: {"change": {only the fields you change, each with its full new value}, "summary": "one short sentence
on what you changed, for the person who asked", "note": "only if something couldn't be done"}`;

async function run(jobId: string, variantId: string, r: Revision) {
  const e = engine();
  const info = await e.reviseInfo(jobId, variantId);
  if (!info) throw new Error("This video was made before revisions: re-make it once, then it can be revised.");
  const files: Record<string, Buffer | string> = {
    "GUIDE.md": GUIDE(info),
    "brief.json": JSON.stringify(info.brief, null, 1),
    "clips.json": JSON.stringify({ clips: info.clips, music: info.music }, null, 1),
    "clips.jpg": Buffer.from(info.clip_sheet, "base64"),
    ...(info.sheet ? { "render.jpg": Buffer.from(info.sheet.jpg, "base64") } : {}),
  };
  const ans = await claudeLook<{ change?: Record<string, unknown>; summary?: string; note?: string }>(
    `You are the editor for ${BRAND.name}'s video ads. Change this one video as asked: "${r.ask.replace(/"/g, "'")}".
Read GUIDE.md first and follow it, then look at the other files.`, files, 10 * 60_000);
  if (!ans) throw new Error("Claude didn't answer. Is Claude Code signed in on this machine?");
  const change = ans.change ?? {};
  if (!Object.keys(change).length) {
    Object.assign(r, { status: "done", summary: ans.note || ans.summary || "Claude made no change." });
    return;
  }
  const sent = await e.revise(jobId, variantId, change);
  Object.assign(r, { status: "rendering", id: sent.id, summary: [ans.summary, ans.note].filter(Boolean).join(" ") });
  for (let t = 0; t < 40 * 60; t += 3) {
    await new Promise((ok) => setTimeout(ok, 3000));
    const s = await e.revision(sent.rev).catch(() => null);
    if (!s || s.status === "queued" || s.status === "rendering") continue;
    if (s.status === "error" || !s.variant) throw new Error(s.error ?? "render failed");
    await addRow(jobId, variantId, s.variant, r);
    r.status = "done";
    return;
  }
  throw new Error("The render took over 40 minutes; check the engine.");
}

const base = (p?: string | null) => (p ? p.split(/[\\/]/).pop()! : null);

async function addRow(jobId: string, from: string, v: NonNullable<Awaited<ReturnType<ReturnType<typeof engine>["revision"]>>["variant"]>, r: Revision) {
  const repo = getRepo();
  const [orig] = await repo.list("reel_variants", { eq: { job_id: jobId, id: from } });
  let caption = orig?.caption ?? v.hook ?? "";
  const res = v.caption_file ? await engine().fetchFile(jobId, base(v.caption_file)!) : null;
  if (res?.ok) caption = (await res.text()).trim();
  const row: ReelVariant = {
    id: v.id, job_id: jobId, format: v.format ?? orig?.format ?? null, hook_id: orig?.hook_id ?? null, hook: v.hook ?? null,
    grade: v.grade ?? null, music: v.music ?? null, file: base(v.file), bare: base(v.bare), poster: base(v.poster), caption,
    duration: v.duration ?? null, warnings: v.warnings ?? [], picked: false,
    tags: { ...(orig?.tags ?? {}), ...(v.tags ?? {}), revision_of: from, revision_ask: r.ask.slice(0, 300), revision_summary: (r.summary ?? "").slice(0, 300) },
  };
  await repo.upsert("reel_variants", [row], "job_id,id");
}
