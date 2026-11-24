"use client";
import { BookOpen, Clapperboard, ExternalLink, Film, LayoutTemplate, Layers, Play, Smartphone, Star, Upload, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Select, Textarea } from "@/components/ui";
import type { ReadyVideo } from "@/lib/launch";
import type { Creation } from "@/lib/reel-create";
import type { Template } from "@/lib/templates";
import type { Where } from "@/lib/ideas";
import type { StoryDoc } from "@/lib/story-docs";
import { WhereMarks } from "../ideas/ideas";
import { CutStrip, RefPreview } from "../content/engine/templates-panel";

export interface ClipOption { id: string; file: string; kind: string | null; star: boolean; duration: number | null; rating: number | null; subject: string }
type IdeaOption = { id: string; title: string; hook: string; tier: string | null; channel: string | null; rank: number | null; where: Where[] };
type Mode = "app_ad" | "app_screens" | "template" | "raw" | "footage" | "story_doc";

const MODES: { key: Mode; title: string; sub: string; icon: typeof Film }[] = [
  { key: "app_ad", title: "App ad · our phone", sub: "/brag rebuilds the screens from the latest app code: hook, our phone springing up, the payoff, one CTA, brag music (5–20 min each).", icon: Smartphone },
  { key: "app_screens", title: "App ad · floating screens", sub: "Like your reference ad: the app's screens and cards float over one film shot, no phone. Made by /brag from the latest app code.", icon: Layers },
  { key: "template", title: "Template", sub: "Pick clips, then a template learned from your reference reels: its cuts, text and song. One video per template.", icon: LayoutTemplate },
  { key: "raw", title: "Raw from an idea", sub: "Claude picks your most eye-catching footage for the idea; labelled placeholders stand in for shots you still need.", icon: Clapperboard },
  { key: "story_doc", title: "Story doc · narrated", sub: "A city's story in one voice over archive photos and maps, the travel-show cold-open way. Upload the narration; pictures and captions time to it. Makes a trial reel and an ad.", icon: BookOpen },
  { key: "footage", title: "From my footage", sub: "Click the clips you want; it cuts them into a reel on a format that fits.", icon: Film },
];
const isApp = (m: Mode) => m === "app_ad" || m === "app_screens";

/** A reference template's makeup: the reel itself (or its cut rhythm), then each section with its time, cuts and words. */
function TemplateMakeup({ t }: { t: Template }) {
  const L = t.literal!;
  const starts = L.slots.reduce<number[]>((a, x) => [...a, a[a.length - 1] + x], [0]);
  const total = starts[L.slots.length];
  // a section runs from one text line's first shot to the next one's; shots before any text open the reel
  const firsts = [...new Set([0, ...L.lines.map((l) => l.shot)])].filter((s) => s < L.slots.length).sort((a, z) => a - z);
  const sections = firsts.map((s, k) => {
    const end = firsts[k + 1] ?? L.slots.length;
    return { from: starts[s], to: starts[end], cuts: end - s, text: L.lines.filter((l) => l.shot === s).map((l) => l.text) };
  });
  return (
    <div className="mt-2 flex gap-2">
      {L.file ? <RefPreview refId={L.refId} /> : <CutStrip slots={L.slots} />}
      <div className="min-w-0 flex-1 space-y-1 text-[11px]">
        <div className="text-muted-foreground">{L.slots.length === 1 ? "one held shot" : `${L.slots.length} cuts`} over {total.toFixed(1)}s{L.turn ? " · turn your phone" : ""}</div>
        <div className="max-h-28 space-y-0.5 overflow-y-auto">
          {sections.map((s, i) => (
            <div key={i} className="flex gap-1.5">
              <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{s.from.toFixed(1)}–{s.to.toFixed(1)}s</span>
              <span className="min-w-0 truncate" title={s.text.join(" / ")}>
                <span className="text-muted-foreground">{s.cuts === 1 ? "1 shot" : `${s.cuts} cuts`}</span>
                {s.text.length ? <> · &ldquo;{s.text.join(" / ")}&rdquo;</> : <span className="text-muted-foreground"> · no text</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-1 pt-1 text-muted-foreground">
          <span className="truncate">♪ {L.song ?? (L.file ? "its own sound" : "add its sound in Instagram")}</span>
          {L.url && <a href={L.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 hover:text-foreground" title="Watch the original"><ExternalLink className="h-3 w-3" /></a>}
        </div>
      </div>
    </div>
  );
}
export const fileUrl = (job: string, n: string | null) => (n ? `/api/reels/files/${encodeURIComponent(job)}/${encodeURIComponent(n)}` : undefined);

export function Maker({ ideas, clips: initialClips, initialIdea, initialRuns, recent }: {
  ideas: IdeaOption[]; clips: ClipOption[]; initialIdea: string | null; initialRuns: Creation[]; recent: ReadyVideo[];
}) {
  const [mode, setMode] = useState<Mode>(initialIdea && !ideas.find((i) => i.id === initialIdea)?.where.includes("ads") ? "raw" : "app_ad");
  const [idea, setIdea] = useState(initialIdea ?? "");
  const [note, setNote] = useState("");
  const [count, setCount] = useState(1);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [tpl, setTpl] = useState<Set<string>>(new Set());
  const [started, setStarted] = useState<string | null>(null);
  const [clips, setClips] = useState(initialClips);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState(initialRuns);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState<ClipOption | null>(null);
  const chosen = ideas.find((i) => i.id === idea);
  const shownClips = useMemo(() => clips.filter((c) => !q || `${c.file} ${c.subject}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)) || (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 60), [clips, q, picked]);

  // poll while anything is thinking or rendering
  const active = runs.some((r) => r.status === "thinking" || r.status === "rendering");
  // template videos aren't in the page's first list (they live in the engine), so ask once on open
  useEffect(() => { api<Creation[]>("/api/make").then(setRuns).catch(() => {}); }, []);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => setRuns(await api<Creation[]>("/api/make").catch(() => runs)), 5000);
    return () => clearInterval(t);
  }, [active, runs]);

  // templates, and how well each suits the clips you've picked
  const pickedKey = [...picked].sort().join(",");
  useEffect(() => {
    if (mode !== "template") return;
    let live = true;
    api<Template[]>(`/api/reels/templates?clips=${encodeURIComponent(pickedKey)}`).then((t) => live && setTemplates(t)).catch(() => live && setTemplates([]));
    return () => { live = false; };
  }, [mode, pickedKey]);

  async function make() {
    setBusy(true); setErr(null); setStarted(null);
    try {
      if (mode === "template") {
        await api("/api/reels/templates", { method: "POST", json: { clipIds: [...picked], templateIds: [...tpl], hook: note.trim() || undefined } });
        setStarted(`Rendering ${tpl.size} video${tpl.size > 1 ? "s" : ""}. They land on Launch when done.`);
        setRuns(await api<Creation[]>("/api/make").catch(() => runs));
        return;
      }
      const c = await api<Creation & { runs?: Creation[] }>("/api/make", { method: "POST", json: { mode, idea_id: idea || undefined, note, clip_ids: [...picked], count } });
      const made = c.runs ?? [c];
      setRuns((xs) => [...made, ...xs.filter((x) => !made.some((m) => m.id === x.id))]);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  async function upload(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      const r = await fetch(`/api/reels/clips?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      if (!r.ok) { setErr(`${f.name}: ${(await r.json().catch(() => ({}))).error ?? r.status}`); continue; }
      const c = await r.json();
      setClips((xs) => [{ id: c.id, file: c.file, kind: c.kind, star: false, duration: c.duration, rating: null, subject: "new: Claude reads it shortly" }, ...xs]);
      setPicked((s) => new Set(s).add(c.id));
    }
  }
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const needsIdea = mode !== "footage" && mode !== "template";
  const ready = mode === "template" ? picked.size > 0 && tpl.size > 0 : needsIdea ? !!idea || !!note.trim() : picked.size > 0;

  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_380px]">
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {MODES.map((m) => (
            <button key={m.key} onClick={() => setMode(m.key)} className={`rounded-md border p-3 text-left transition-colors ${mode === m.key ? "border-primary bg-primary/10" : "bg-card/90 hover:bg-accent"}`}>
              <div className="flex items-center gap-2 text-[13px] font-medium"><m.icon className="h-4 w-4 text-primary" />{m.title}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{m.sub}</div>
            </button>
          ))}
        </div>
        {mode === "story_doc" ? <StoryDocs onRun={(c) => setRuns((xs) => [c, ...xs.filter((x) => x.id !== c.id)])} /> : (<>
        <Card>
          <CardBody className="space-y-2.5 py-3">
            {needsIdea && (
              <div>
                <div className="label mb-1">Idea</div>
                <Select value={idea} onChange={(e) => setIdea(e.target.value)} className="w-full">
                  <option value="">Choose an idea (or describe one below)</option>
                  {ideas.map((i) => <option key={i.id} value={i.id}>{i.rank ? `#${i.rank} ` : "new · "}{i.title} · {i.where.join(", ")}</option>)}
                </Select>
                {chosen && <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><WhereMarks where={chosen.where} />{chosen.hook && <>&ldquo;{chosen.hook}&rdquo;</>}</p>}
              </div>
            )}
            <div>
              <div className="label mb-1">{needsIdea ? "Anything to add (optional)" : mode === "template" ? "Your own hook (optional; otherwise the template's)" : "What it's about (optional)"}</div>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder={isApp(mode) ? "e.g. show the free hidden gem after typing Lisbon; end on the App Store" : mode === "template" ? "e.g. The best part was never on the itinerary." : mode === "raw" ? "e.g. use the Florence footage; keep it under 15 s" : "e.g. a calm sunrise reel, no text"} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mode !== "template" && (
                <Select value={count} onChange={(e) => setCount(Number(e.target.value))} className="h-8 w-28 text-xs">
                  {[1, 2, 3].map((n) => <option key={n} value={n}>{n} version{n > 1 ? "s" : ""}</option>)}
                </Select>
              )}
              <Button onClick={make} disabled={busy || !ready}>
                <Film className="h-4 w-4" />{busy ? "Starting…" : "Make video"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {mode === "template" ? `${picked.size} clip${picked.size === 1 ? "" : "s"}, ${tpl.size} template${tpl.size === 1 ? "" : "s"}` : mode === "footage" ? `${picked.size} clip${picked.size === 1 ? "" : "s"} picked` : picked.size ? `+ ${picked.size} clip${picked.size === 1 ? "" : "s"} you picked` : "Uses your library and best clips"}
              </span>
              {err && <span className="text-xs text-destructive">{err}</span>}
              {started && <span className="text-xs text-success">{started} <Link href="/launch" className="underline">Launch →</Link></span>}
            </div>
            {isApp(mode) && count > 1 && <p className="text-[11px] text-muted-foreground">/brag runs one ad at a time, so {count} versions take a while.</p>}
          </CardBody>
        </Card>
        {mode === "template" && (
          <Card>
            <CardHeader title="Templates" description={picked.size ? "How well each suits the clips you picked." : "Pick clips below first; each template says what footage it needs."} />
            <CardBody>
              {!templates ? <p className="text-xs text-muted-foreground">Loading templates…</p> : !templates.length ? <Empty>No templates yet. Add reference reels under Advanced tools.</Empty> : (
                <div className="grid max-h-[36rem] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {templates.map((t) => (
                    <button key={t.id} onClick={() => setTpl((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })}
                      className={`rounded-md border p-3 text-left text-xs transition-colors ${tpl.has(t.id) ? "border-primary bg-primary/5" : "hover:bg-accent/40"} ${picked.size && !t.fit.ok ? "opacity-60" : ""}`}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium">{t.name} <span className="font-normal text-muted-foreground">· {t.purpose ?? (t.literal ? "your reference" : "learned style")}</span></span>
                        <input type="checkbox" readOnly checked={tpl.has(t.id)} className="pointer-events-none mt-0.5 shrink-0" />
                      </div>
                      {t.literal ? <TemplateMakeup t={t} /> : (
                        <>
                          <p className="mt-1 text-[11px] text-muted-foreground">{t.blurb}</p>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Badge tone="outline">{t.format} · {t.pacing}</Badge><Badge tone="outline">{t.grade}{t.grain ? " + grain" : ""}</Badge>
                            <Badge tone="outline">~{t.duration}s</Badge><Badge tone="outline">text: {t.text.replace("_", " ")}</Badge>
                            {t.fx === "playful" && <Badge tone="outline">mask · squares · wipe</Badge>}
                            {t.buildDrop && <Badge tone="outline">quiet → drop</Badge>}
                            {t.letterbox && <Badge tone="outline">letterbox</Badge>}
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">from {t.refs.length} reference{t.refs.length === 1 ? "" : "s"}</div>
                        </>
                      )}
                      <div className={`mt-2 text-[11px] ${t.fit.needs ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                        {picked.size ? (t.fit.needs ? `Footage: ${t.fit.note}` : t.fit.note) : "Pick clips to see if it fits."}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title={mode === "footage" || mode === "template" ? "Pick your clips" : "Add clips (optional)"} description="Best-rated first (Claude's read of each clip). Upload more and they're picked."
            action={<label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"><Upload className="h-3.5 w-3.5" />Upload<input type="file" accept="video/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} /></label>} />
          <CardBody>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clips (place, subject)" className="mb-2 h-7 text-xs" />
            {!shownClips.length ? <Empty>No clips yet. Upload some.</Empty> : (
              <div className="grid max-h-80 gap-1 overflow-y-auto sm:grid-cols-2">
                {shownClips.map((c) => (
                  <button key={c.id} onClick={() => toggle(c.id)} className={`flex items-center gap-2 rounded border px-2 py-1.5 text-left text-xs ${picked.has(c.id) ? "border-primary bg-primary/10" : "hover:bg-accent"}`}>
                    <input type="checkbox" readOnly checked={picked.has(c.id)} className="pointer-events-none" />
                    <span role="button" tabIndex={0} title="Preview" onClick={(e) => { e.stopPropagation(); setPreview(c); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setPreview(c); } }}
                      className="group relative h-12 w-[27px] shrink-0 overflow-hidden rounded bg-muted">
                      <img src={clipMedia(c.id, "thumb")} alt="" loading="lazy" className="h-full w-full object-cover" />
                      <Play className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 fill-white/90 text-white/90 opacity-80 group-hover:opacity-100" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{c.star && <Star className="mr-1 inline h-3 w-3 fill-warning text-warning" />}{c.file}</div>
                      <div className="truncate text-[10px] text-muted-foreground">{c.subject || c.kind || ""}</div>
                    </div>
                    {c.rating != null && <span className="font-mono text-[10px] text-muted-foreground">{Math.round(c.rating * 100)}</span>}
                  </button>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
        </>)}
        {preview && <ClipPreview clip={preview} picked={picked.has(preview.id)} onPick={() => toggle(preview.id)} onClose={() => setPreview(null)} />}
      </div>
      <div className="space-y-3">
        <Card>
          <CardHeader title="Making" description="Claude writes each one, then the engine renders it." />
          <CardBody className="space-y-2">
            {!runs.length ? <Empty>Nothing in progress.</Empty> : runs.map((r) => (
              <div key={r.id} className="rounded border p-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge tone={r.status === "done" ? "success" : r.status === "error" ? "danger" : "warning"}>{r.status}</Badge>
                  <span className="truncate text-muted-foreground">{r.ask.split("\n")[0].slice(0, 80)}</span>
                  {r.id.startsWith("brag-") && (r.status === "thinking" || r.status === "rendering") && (
                    <button type="button" className="ml-auto shrink-0 rounded border px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        if (!window.confirm("Cancel this one? It stops now and nothing goes to Launch.")) return;
                        await fetch(`/api/make?id=${encodeURIComponent(r.id)}`, { method: "DELETE" });
                        setRuns(await api<Creation[]>("/api/make").catch(() => runs));
                      }}>Cancel</button>
                  )}
                </div>
                {r.plan && <p className="mt-1">{r.plan}</p>}
                {!!r.needs?.length && <p className="mt-1 text-muted-foreground">Would be better with: {r.needs.join("; ")}</p>}
                {r.note && <p className="mt-1 text-muted-foreground">{r.note}</p>}
                {r.error && <p className="mt-1 text-destructive">{r.error}</p>}
                {r.status === "done" && <Link href="/launch" className="mt-1 inline-block text-primary hover:underline">Ready on Launch →</Link>}
              </div>
            ))}
          </CardBody>
        </Card>
        <ImportCard ideas={ideas} />
        <Card>
          <CardHeader title="Latest videos" action={<Link href="/launch" className="label hover:text-foreground">Launch →</Link>} />
          <CardBody className="grid grid-cols-3 gap-1.5">
            {recent.map((v) => (
              <Link key={`${v.job_id}/${v.variant_id}`} href="/launch" title={v.title} className="relative block overflow-hidden rounded bg-muted" style={{ aspectRatio: "9 / 16" }}>
                {v.poster && <img src={fileUrl(v.job_id, v.poster)} alt="" className="h-full w-full object-cover" loading="lazy" />}
                {v.launched && <span className="absolute left-1 top-1 rounded-sm bg-black/60 px-1 text-[9px] uppercase text-white">{v.launched}</span>}
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/** Made it with /brag (or anywhere else)? Bring it in with its script so it can be launched. */
function ImportCard({ ideas }: { ideas: IdeaOption[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [script, setScript] = useState("");
  const [caption, setCaption] = useState("");
  const [idea, setIdea] = useState("");
  const [brag, setBrag] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    if (!file) return;
    setBusy(true); setMsg(null);
    const f = new FormData();
    f.set("video", file); f.set("script", script); f.set("caption", caption); f.set("idea_id", idea); f.set("made_by", brag ? "brag" : "import");
    const r = await fetch("/api/make/import", { method: "POST", body: f });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg(r.ok ? "Imported. It's on Launch." : j.error ?? `Failed (${r.status})`);
    if (r.ok) { setFile(null); setScript(""); setCaption(""); }
  }
  return (
    <Card>
      <CardHeader title="Import a video" description="A /brag render or any finished edit, with its script, so it can be launched." />
      <CardBody className="space-y-2">
        <input type="file" accept="video/mp4,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs" />
        <Textarea rows={3} value={script} onChange={(e) => setScript(e.target.value)} placeholder="Script: hook, on-screen lines, CTA (one per line)" />
        <Textarea rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption" />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={idea} onChange={(e) => setIdea(e.target.value)} className="h-8 flex-1 text-xs">
            <option value="">Idea it&apos;s for (optional)</option>
            {ideas.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
          </Select>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={brag} onChange={(e) => setBrag(e.target.checked)} />made with /brag</label>
          <Button size="sm" onClick={send} disabled={!file || busy}><Upload className="h-3.5 w-3.5" />{busy ? "Importing…" : "Import"}</Button>
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardBody>
    </Card>
  );
}

const clipMedia = (id: string, as: "thumb" | "preview") => `/api/reels/clips/${encodeURIComponent(id)}/media?${as}=1`;

/** A clip, big and playing, without leaving the picker: Esc or a click outside closes it. */
function ClipPreview({ clip, picked, onPick, onClose }: { clip: ClipOption; picked: boolean; onPick: () => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-sm space-y-2" onClick={(e) => e.stopPropagation()}>
        <video key={clip.id} src={clipMedia(clip.id, "preview")} poster={clipMedia(clip.id, "thumb")} autoPlay loop muted playsInline controls
          className="max-h-[75vh] w-full rounded-lg bg-black object-contain" />
        <div className="flex items-center gap-2 rounded-lg bg-background p-2 text-xs">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{clip.file}{clip.duration != null && <span className="text-muted-foreground"> · {Math.round(clip.duration)}s</span>}</div>
            <div className="truncate text-[11px] text-muted-foreground">{clip.subject}</div>
          </div>
          <Button size="sm" variant={picked ? "outline" : undefined} onClick={onPick}>{picked ? "Picked" : "Pick it"}</Button>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}

/** Story docs: each city's spoken script, its pictures, and the narration upload that renders the trial reel + ad. */
function StoryDocs({ onRun }: { onRun: (c: Creation) => void }) {
  const [docs, setDocs] = useState<StoryDoc[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  useEffect(() => { api<StoryDoc[]>("/api/make/storydoc").then(setDocs).catch(() => setDocs([])); }, []);
  const [hookFor, setHookFor] = useState<string | null>(null);
  const [hook, setHook] = useState("");
  // his recording (a file), the whole script in our voice model, or a new hook in our voice on his recording (Nov 20 2026)
  async function send(slug: string, f: File | "voice" | { hook: string } | undefined) {
    if (!f) return;
    setBusy(slug); setMsg((m) => ({ ...m, [slug]: "" }));
    try {
      const body = new FormData(); body.set("slug", slug);
      if (f === "voice") body.set("voice", "1"); else if (f instanceof File) body.set("audio", f); else body.set("hook", f.hook);
      const r = await fetch("/api/make/storydoc", { method: "POST", body });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.status);
      onRun(j as Creation);
      setMsg((m) => ({ ...m, [slug]: f instanceof File ? "Rendering the trial reel and the ad (a few minutes). Both land on Launch." : "Narrating in our voice, then rendering the trial reel and the ad (a few minutes). Both land on Launch." }));
      setHookFor(null); setHook("");
    } catch (x) { setMsg((m) => ({ ...m, [slug]: (x as Error).message })); } finally { setBusy(null); }
  }
  if (!docs) return <Card><CardBody><p className="text-xs text-muted-foreground">Loading story docs…</p></CardBody></Card>;
  if (!docs.length) return <Card><CardBody><Empty>No story docs yet. Scripts live in services/reel-engine/knowledge/story-docs.</Empty></CardBody></Card>;
  return (
    <Card>
      <CardHeader title="Story docs" description="Upload your recording, or have our voice model read the script. A new hook reads just the opening in our voice and keeps your recording for the rest. Nothing posts until you approve it on Launch." />
      <CardBody className="space-y-2">
        {docs.map((d) => (
          <div key={d.slug} className="rounded border p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{d.title}</span>
              <Badge tone="outline">{d.words} words · ~{d.seconds}s</Badge>
              <Badge tone={d.ready ? "outline" : "warning"}>{d.ready ? `${d.images} pictures` : d.missing}</Badge>
              {d.audio && <Badge tone="success">narration in</Badge>}
              <div className="ml-auto flex items-center gap-2">
                <button className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(open === d.slug ? null : d.slug)}>{open === d.slug ? "Hide script" : "Script"}</button>
                <button className="text-muted-foreground hover:text-foreground" onClick={() => navigator.clipboard?.writeText(d.script)}>Copy</button>
                <button className={`text-muted-foreground hover:text-foreground ${!d.ready || busy ? "pointer-events-none opacity-50" : ""}`} onClick={() => send(d.slug, "voice")}>Narrate in our voice</button>
                {d.audio && <button className={`text-muted-foreground hover:text-foreground ${!d.ready || busy ? "pointer-events-none opacity-50" : ""}`} onClick={() => { setHookFor(hookFor === d.slug ? null : d.slug); setHook(d.script.split("\n")[0]); }}>New hook</button>}
                <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 hover:bg-accent ${!d.ready || busy ? "pointer-events-none opacity-50" : ""}`}>
                  <Upload className="h-3.5 w-3.5" />{busy === d.slug ? "Uploading…" : d.audio ? "New narration" : "Upload narration"}
                  <input type="file" accept="audio/*,.wav,.mp3,.m4a,.flac" className="hidden" onChange={(e) => send(d.slug, e.target.files?.[0])} />
                </label>
              </div>
            </div>
            <p className="mt-1 truncate text-muted-foreground">{d.script.split("\n")[0]}</p>
            {hookFor === d.slug && (
              <div className="mt-2 space-y-1.5">
                <Textarea rows={2} value={hook} onChange={(e) => setHook(e.target.value)} placeholder="The new opening, as it should be said" />
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={!hook.trim() || !!busy} onClick={() => send(d.slug, { hook })}>Voice it and render</Button>
                  <span className="text-muted-foreground">Read in our voice, then your recording from the second paragraph on.</span>
                </div>
              </div>
            )}
            {open === d.slug && <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-sans text-[12px] leading-relaxed">{d.script}</pre>}
            {msg[d.slug] && <p className="mt-1 text-muted-foreground">{msg[d.slug]}</p>}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
