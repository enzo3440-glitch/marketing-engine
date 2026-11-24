import { getRepo, REF_FORMATS, type ReelRef, type RefTextLook } from "@engine/db";
import { guardApi } from "@/lib/auth";
import { intentFrom, queueRead } from "@/lib/ref-intake";
import { engine } from "@/lib/reels";

const SAFE = /^[\w.\- ]+$/; // same rule as engine/server.py
const LOOKS = ["clean", "teal_orange", "film", "golden", "moody", "tropical", "mono"];

/** A reference's hook becomes a selectable hook in the batch builder (deduped on text). */
async function addToPool(text: string) {
  const repo = getRepo();
  const hooks = await repo.list("reel_hooks");
  if (hooks.some((h) => h.text.toLowerCase() === text.toLowerCase())) return;
  const next = Math.max(0, ...hooks.map((h) => Number(h.id.replace(/\D/g, "")) || 0)) + 1;
  await repo.insert("reel_hooks", [{ id: `h${next}`, text, framework: "ref", source: "owner", status: "new", created_at: new Date().toISOString() }]);
}
const sourceOf = (url: string): ReelRef["source"] =>
  /instagram\.com/.test(url) ? "instagram" : /tiktok\.com/.test(url) ? "tiktok" : /youtube\.com|youtu\.be/.test(url) ? "youtube" : "link";

export async function GET() {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  return Response.json(await getRepo().list("reel_refs", { order: { col: "added_at", asc: false } }));
}

/**
 * JSON {url, format, notes, title} → a link reference (never downloaded: links stay links).
 * Raw body with ?name= → a video file: uploaded to the engine and measured (shots, cut rate, pacing).
 */
export async function POST(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const repo = getRepo();
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  const format = REF_FORMATS.includes(url.searchParams.get("format") as never) ? url.searchParams.get("format")! : null;
  const id = `ref-${Date.now().toString(36)}`;
  if (name) {
    const clean = `ref_${name.replace(/[^\w.\- ]/g, "_")}`;
    if (!SAFE.test(clean) || !/\.(mp4|mov|m4v|webm)$/i.test(clean)) return Response.json({ error: "video file required (.mp4/.mov/.m4v/.webm)" }, { status: 400 });
    if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });
    const e = engine();
    let metrics: Record<string, unknown> = {};
    if (!e.stub) {
      const up = await e.upload(clean, req.body);
      metrics = (await e.analyzeRef(up.path, { text: true })) ?? {};
      const first = (metrics.lines as { text: string }[] | undefined)?.[0]?.text;
      if (first && !metrics.hook) {  // its opening text is its hook
        metrics.hook = first;
        await addToPool(first);
      }
    }
    const [row] = await repo.insert("reel_refs", [{
      id, url: null, file: clean, source: "file", title: url.searchParams.get("title") || name, notes: url.searchParams.get("notes") || null,
      format: format ?? String(metrics.format ?? "montage"),
      // your note decides template / learn, same as a link; a dropped video is its own sound
      metrics: { ...metrics, ...intentFrom(url.searchParams.get("notes"), { intent: url.searchParams.get("intent") ?? undefined }), ...(metrics.lines ? { read_at: new Date().toISOString() } : {}) },
      added_at: new Date().toISOString(),
    }]);
    return Response.json({ ...row, analyzed: !e.stub });
  }
  const b = (await req.json()) as { url?: string; format?: string; notes?: string; title?: string; look?: string; hook?: string; intent?: string; learn?: string[]; song?: string };
  let link: URL;
  try { link = new URL(b.url ?? ""); } catch { return Response.json({ error: "paste a full link (https://…)" }, { status: 400 }); }
  if (!/^https?:$/.test(link.protocol)) return Response.json({ error: "http(s) links only" }, { status: 400 });
  const existing = (await repo.list("reel_refs")).find((r) => r.url === link.toString());
  if (existing) return Response.json({ ...existing, existed: true });
  if (b.hook?.trim()) await addToPool(b.hook.trim().slice(0, 120));
  const [row] = await repo.insert("reel_refs", [{
    id, url: link.toString(), file: null, source: sourceOf(link.hostname), title: b.title?.trim() || link.pathname.split("/").filter(Boolean).slice(-2).join(" / "),
    notes: b.notes?.trim() || null, format: REF_FORMATS.includes(b.format as never) ? b.format! : "montage",
    metrics: {
      ...(b.look && LOOKS.includes(b.look) ? { look: b.look } : {}), ...(b.hook?.trim() ? { hook: b.hook.trim().slice(0, 120) } : {}),
      ...(b.song?.trim() ? { song: b.song.trim().slice(0, 120) } : {}), ...intentFrom(b.notes, { intent: b.intent, learn: b.learn }),
    },
    added_at: new Date().toISOString(),
  }]);
  queueRead([row]);  // read it from the link in the background: cuts, text, look
  return Response.json({ ...row, reading: true });
}

/** Fix a reference's tags: format (edit structure) and look (color grade) are separate on purpose. */
export async function PATCH(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const b = (await req.json()) as {
    id?: string; format?: string; look?: string | null; notes?: string; title?: string; hook?: string;
    song?: string; lines?: NonNullable<ReelRef["metrics"]["lines"]>; reread?: boolean; intent?: string; learn?: string[];
    /** fix the caption look the reader measured: one typeface and/or colour for every line */
    textLook?: { font?: string; fill?: [number, number, number] };
  };
  if (!b.id) return Response.json({ error: "id required" }, { status: 400 });
  const repo = getRepo();
  const [cur] = await repo.list("reel_refs", { eq: { id: b.id } });
  if (!cur) return Response.json({ error: "not found" }, { status: 404 });
  const patch: Partial<ReelRef> = {};
  if (b.format !== undefined) {
    if (!REF_FORMATS.includes(b.format as never)) return Response.json({ error: "unknown format" }, { status: 400 });
    patch.format = b.format;
  }
  if (b.look !== undefined) {
    if (b.look !== null && !LOOKS.includes(b.look)) return Response.json({ error: "unknown look" }, { status: 400 });
    patch.metrics = { ...cur.metrics, look: b.look ?? undefined };
  }
  if (typeof b.hook === "string") {
    const hook = b.hook.trim().replace(/\s+/g, " ").slice(0, 120);
    patch.metrics = { ...(patch.metrics ?? cur.metrics), hook: hook || undefined };
    if (hook) await addToPool(hook);
  }
  if (typeof b.song === "string") patch.metrics = { ...(patch.metrics ?? cur.metrics), song: b.song.trim().slice(0, 120) || undefined };
  if (Array.isArray(b.lines)) {
    const lines = b.lines.filter((l) => l.text?.trim()).map((l) => ({ ...l, text: l.text.trim().slice(0, 140) })).slice(0, 40);
    patch.metrics = { ...(patch.metrics ?? cur.metrics), lines };
  }
  if (b.reread && cur.file) {  // re-measure a dropped reference: cuts + on-screen text
    const m = await engine().analyzeRef(cur.file, { text: true }).catch(() => null);
    if (m) patch.metrics = { ...(patch.metrics ?? cur.metrics), ...m, format: cur.metrics.format } as ReelRef["metrics"];
  }
  if (b.textLook && (patch.metrics ?? cur.metrics).lines?.length) {
    const m = patch.metrics ?? cur.metrics;
    const base: RefTextLook = { font: "inter600", size: [56, 44], upper: false, fill: [255, 255, 255], box: null, stroke: 0, shadow: 10, lh: 1.1 };
    const override = { ...(m.text_override ?? {}), ...b.textLook };  // kept, so a re-read doesn't undo your fix
    patch.metrics = { ...m, text_override: override, lines: m.lines!.map((l) => ({ ...l, look: { ...base, ...(l.look ?? {}), ...override } })) };
  }
  if (b.intent !== undefined || b.learn !== undefined) {
    patch.metrics = { ...(patch.metrics ?? cur.metrics), ...intentFrom(null, { intent: b.intent ?? cur.metrics.intent, learn: b.learn ?? cur.metrics.learn }) };
  }
  if (b.reread && cur.url) queueRead([{ ...cur, ...patch, metrics: { ...(patch.metrics ?? cur.metrics), lines: [] } }]);
  if (typeof b.notes === "string") patch.notes = b.notes.trim() || null;
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim();
  await repo.update("reel_refs", { id: b.id }, patch);
  return Response.json({ ...cur, ...patch });
}

export async function DELETE(req: Request) {
  const s = await guardApi("content");
  if (s instanceof Response) return s;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await getRepo().remove("reel_refs", { id });
  return Response.json({ ok: true });
}
