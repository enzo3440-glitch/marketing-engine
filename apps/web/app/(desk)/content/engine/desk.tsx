"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { REEL_FORMATS, REEL_GRADES, REF_ASPECTS, REF_FORMATS, type ReelClip, type ReelHook, type ReelJob, type ReelPost, type ReelRef, type ReelVariant } from "@engine/db/types";
import type { Leaderboard, NextMatrix } from "@engine/db/learn";
import { ChevronDown, Copy, Download, ExternalLink, Film, Link2, Loader2, Play, Plus, Send, Sparkles, Star, Trash2, Upload, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Select, statusTone, Table, Td, Th } from "@/components/ui";
import { cn, fmt } from "@/lib/utils";
import { Autopilot } from "./autopilot";
import { CreateBox } from "./create-box";
import { TemplateMaker } from "./templates-panel";

interface EngineInfo { stub: boolean; status: string; detail?: string }
interface JobDetail { job: ReelJob; variants: ReelVariant[]; posts: ReelPost[] }

const musicLabel = (m: string) => (m.startsWith("synth:") ? m : m.startsWith("music/") ? m.slice(6).replace(/\.\w+$/, "") : m.replace(/^assets\/music\/happy-beats-business-moves-(vol-\d+).*$/, "Sascha Ende · $1"));

function Chips<T extends string>({ all, value, onChange, label = (x: T) => x }: { all: readonly T[]; value: T[]; onChange: (v: T[]) => void; label?: (x: T) => string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((x) => {
        const on = value.includes(x);
        return (
          <button key={x} type="button" onClick={() => onChange(on ? value.filter((y) => y !== x) : [...value, x])}
            className={cn("rounded border px-2 py-0.5 text-xs", on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {label(x)}
          </button>
        );
      })}
    </div>
  );
}

type Pacing = "fast" | "medium" | "cinematic";

type HookInfo = Record<string, { rank: number; tag: string }>;
const HOOK_TAG_TONE: Record<string, "primary" | "success" | "warning" | "outline"> = { winner: "success", trending: "primary", "your ref": "warning", evidence: "outline", testing: "outline" };

export function EngineDesk({ initialClips, initialHooks, initialJobs, initialRefs, hookInfo, engine }: { initialClips: ReelClip[]; initialHooks: ReelHook[]; initialJobs: ReelJob[]; initialRefs: ReelRef[]; hookInfo: HookInfo; engine: EngineInfo }) {
  const qc = useQueryClient();
  const clips = useQuery({ queryKey: ["clips"], queryFn: () => api<ReelClip[]>("/api/reels/clips"), initialData: initialClips });
  const hooks = useQuery({ queryKey: ["hooks"], queryFn: () => api<ReelHook[]>("/api/reels/hooks"), initialData: initialHooks });
  const jobs = useQuery({
    queryKey: ["jobs"], queryFn: () => api<ReelJob[]>("/api/reels/jobs"), initialData: initialJobs,
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "queued" || j.status === "rendering") ? 2500 : false),
  });
  const [jobId, setJobId] = useState<string | null>(initialJobs[0]?.job_id ?? null);

  // Builder state ------------------------------------------------------------------------------
  const [clipIds, setClipIds] = useState<string[]>(initialClips.map((c) => c.id));
  const [formats, setFormats] = useState<string[]>(["montage"]);
  const rankOf = (h: ReelHook) => hookInfo[h.id]?.rank ?? 9;
  const [hookIds, setHookIds] = useState<string[]>(() => [...initialHooks].filter((h) => h.status !== "retired" && !/\[[^\]]+\]/.test(h.text)).sort((a, z) => rankOf(a) - rankOf(z)).slice(0, 3).map((h) => h.id));
  const [grades, setGrades] = useState<string[]>([]);
  const [music, setMusic] = useState<string[]>([]);
  const [duration, setDuration] = useState(12);
  const [max, setMax] = useState(12);
  const [buildDrop, setBuildDrop] = useState(false);
  const [hashtags, setHashtags] = useState("");
  const [newHook, setNewHook] = useState("");
  const [pacing, setPacing] = useState<Pacing>("fast");
  const [styleRef, setStyleRef] = useState<ReelRef | null>(null);
  const combos = Math.min(formats.length * hookIds.length, max);

  const createJob = useMutation({
    mutationFn: () => api<ReelJob>("/api/reels/jobs", { method: "POST", json: { clipIds, formats, hookIds, grades, music, duration, max, pacing, buildDrop, referenceId: styleRef?.id, hashtags: hashtags.split(/[\s,#]+/).filter(Boolean) } }),
    onSuccess: (j) => { setJobId(j.job_id); qc.invalidateQueries({ queryKey: ["jobs"] }); },
  });
  const addHook = useMutation({
    mutationFn: (text: string) => api<ReelHook>("/api/reels/hooks", { method: "POST", json: { text, source: "owner" } }),
    onSuccess: (h) => { setHookIds((x) => [...new Set([...x, h.id])]); setNewHook(""); qc.invalidateQueries({ queryKey: ["hooks"] }); },
  });

  /** Take format + rhythm from a style reference (measured files) or its format (links). */
  function useStyle(r: ReelRef) {
    const fmt = (REEL_FORMATS as readonly string[]).includes(r.format) ? r.format : "montage";
    setFormats([fmt]);
    setPacing((r.metrics.pacing as Pacing) ?? (fmt === "cinematic" || fmt === "oneshot" ? "cinematic" : "fast"));
    if (r.metrics.duration) setDuration(Math.min(30, Math.max(6, Math.round(r.metrics.duration))));
    if (r.metrics.look) setGrades([r.metrics.look]);
    setStyleRef(r);
    document.getElementById("builder")?.closest("details")?.setAttribute("open", "");
    document.getElementById("builder")?.scrollIntoView({ behavior: "smooth" });
  }

  function applyNext(n: NextMatrix) {
    setFormats(n.formats.filter((f) => (REEL_FORMATS as readonly string[]).includes(f)));
    setHookIds(n.hooks.map((h) => h.id));
    setMax(n.max);
    document.getElementById("builder")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <div className="space-y-5">
      <div className={cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm", engine.stub ? "border-warning/40 bg-warning/5" : "")}>
        <Film className="h-4 w-4" />
        <span className="font-medium">Reel Engine</span>
        <Badge tone={engine.stub ? "warning" : statusTone(engine.status)}>{engine.stub ? "stub" : engine.status}</Badge>
        <span className="text-xs text-muted-foreground">{engine.stub ? "VIDEO_ENGINE_URL unset: jobs, variants and the learn loop work end to end, but no media is rendered. Run services/reel-engine and set VIDEO_ENGINE_URL + REEL_TOKEN." : engine.detail}</span>
      </div>

      <CreateBox checked={clipIds} stub={engine.stub} onOpen={(id) => { setJobId(id); qc.invalidateQueries({ queryKey: ["jobs"] }); }} />

      <References initial={initialRefs} stub={engine.stub} onUse={useStyle} />

      <Autopilot stub={engine.stub} />

      <div className="grid gap-5 xl:grid-cols-5">
        <ClipBin clips={clips.data} selected={clipIds} setSelected={setClipIds} stub={engine.stub} onAutoJob={setJobId} />
        <TemplateMaker clipIds={clipIds} hooks={hooks.data} onCreated={setJobId}
          soundDrop={<MusicChips value={music} onChange={setMusic} />} />
      </div>

      <details className="group rounded-lg border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          Advanced: hook &amp; format tests <span className="font-normal text-muted-foreground">· formats × hooks × looks, to A/B one thing at a time</span>
        </summary>
        <Card id="builder" className="rounded-none border-0 border-t">
          <CardHeader title="Batch builder" description="Formats × hooks × looks → test variants. A hook test changes only the first 2s text, so keep one format to isolate the hook." />
          <CardBody className="space-y-4 text-sm">
            <Field label="Formats"><Chips all={REEL_FORMATS} value={formats as never[]} onChange={(v) => setFormats(v)} /></Field>
            <Field label={`Hooks · ${hookIds.length} selected · ranked: winners, trending now, your references, best evidence`}>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {[...hooks.data].filter((h) => h.status !== "retired").sort((a, z) => rankOf(a) - rankOf(z)).map((h) => (
                  <label key={h.id} className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={hookIds.includes(h.id)} onChange={(e) => setHookIds((x) => (e.target.checked ? [...x, h.id] : x.filter((y) => y !== h.id)))} />
                    <span className="num w-8 shrink-0 text-muted-foreground">{h.id}</span>
                    <span className="flex-1">{h.text}</span>
                    {/\[[^\]]+\]/.test(h.text) && <Badge tone="warning" title="Has a blank like [city]: add your filled-in version with + Add">template</Badge>}
                    {hookInfo[h.id]?.tag && <Badge tone={HOOK_TAG_TONE[hookInfo[h.id].tag] ?? "outline"}>{hookInfo[h.id].tag}</Badge>}
                    <Badge tone={statusTone(h.status)}>{h.status}</Badge>
                  </label>
                ))}
              </div>
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newHook.trim()) addHook.mutate(newHook); }}>
                <Input placeholder="Write a hook: name the place, the thing, the feeling" value={newHook} onChange={(e) => setNewHook(e.target.value)} />
                <Button variant="outline" disabled={addHook.isPending}><Plus className="h-4 w-4" />Add</Button>
              </form>
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Looks · leave empty to use each format's best reference"><Chips all={REEL_GRADES} value={grades as never[]} onChange={(v) => setGrades(v)} /></Field>
              <Field label="Music · hover to preview · drop your own songs below"><MusicChips value={music} onChange={setMusic} /><TrendingSounds /></Field>
            </div>
            {styleRef && (
              <div className="flex items-center justify-between rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
                <span><span className="text-muted-foreground">Styled after </span>{styleRef.title} · {styleRef.format}{styleRef.metrics.look ? ` · ${styleRef.metrics.look} look` : ""}{styleRef.metrics.avg_shot ? ` · ${styleRef.metrics.shots} shots, ${styleRef.metrics.avg_shot}s avg` : ""}</span>
                <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setStyleRef(null)}>clear</button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Pacing">
                <Select value={pacing} onChange={(e) => setPacing(e.target.value as Pacing)} className="w-full">
                  <option value="fast">Fast (1-2 beat cuts)</option><option value="medium">Medium</option><option value="cinematic">Cinematic (long holds)</option>
                </Select>
              </Field>
              <Field label="Duration (s)"><Input type="number" min={5} max={60} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></Field>
              <Field label="Max variants"><Input type="number" min={1} max={48} value={max} onChange={(e) => setMax(Number(e.target.value))} /></Field>
              <Field label="Hashtags (3-5)"><Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} /></Field>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={buildDrop} onChange={(e) => setBuildDrop(e.target.checked)} />
              <span><span className="font-medium">Quiet start, then the drop</span> <span className="text-muted-foreground">· the song plays muffled under the first shot and its drop hits on the reveal</span></span>
            </label>
            <div className="flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">{clipIds.length} clips · {combos} variants{formats.length > 1 && hookIds.length > 1 ? " · mixing formats and hooks: compare hooks within one format" : ""}</span>
              <Button disabled={createJob.isPending || !clipIds.length || !hookIds.length || !formats.length} onClick={() => createJob.mutate()}>
                {createJob.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Render batch
              </Button>
            </div>
            {createJob.error && <p className="text-xs text-destructive">{(createJob.error as Error).message}</p>}
          </CardBody>
        </Card>
      </details>

      <Card>
        <CardHeader title="Jobs" description="Polled while rendering. Star the videos you like; clear the rest." action={<ClearOld onCleared={() => { setJobId(null); qc.invalidateQueries({ queryKey: ["jobs"] }); }} />} />
        <div className="flex gap-2 overflow-x-auto p-3">
          {jobs.data.length ? jobs.data.map((j) => (
            <button key={j.job_id} onClick={() => setJobId(j.job_id)} className={cn("shrink-0 rounded-md border px-3 py-2 text-left text-xs", jobId === j.job_id && "border-primary")}>
              <div className="font-mono">{j.job_id}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                {j.stub && <Badge tone="outline">stub</Badge>}
                <span className="text-muted-foreground">{fmt.ago(j.created_at)}</span>
              </div>
            </button>
          )) : <Empty>No jobs yet.</Empty>}
        </div>
      </Card>

      {jobId && <Gallery jobId={jobId} stub={engine.stub} onGone={() => { setJobId(null); qc.invalidateQueries({ queryKey: ["jobs"] }); }} />}
      <LearnPanel onNext={applyNext} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>{children}</div>;
}

const AUTO_TEMPLATES = ["natural-score", "hero-oneshot", "slow-travel-diary", "beat-photo-dump", "memory-film", "transition-chain"];
const AUTO_REF_TEMPLATES = 4;
interface RefTemplateFit { id: string; fit: { ok: boolean; needs?: string }; literal?: { lines: unknown[]; audio: string | null } }

function ClipBin({ clips, selected, setSelected, stub, onAutoJob }: { clips: ReelClip[]; selected: string[]; setSelected: (v: string[]) => void; stub: boolean; onAutoJob: (jobId: string) => void }) {
  // new clips go straight through the pipeline: a director test batch + your best reference templates (on unless turned off)
  const [auto, setAutoState] = useState(true);
  useEffect(() => { try { if (localStorage.getItem("auto-make") === "0") setAutoState(false); } catch {} }, []);
  const setAuto = (v: boolean) => { setAutoState(v); try { localStorage.setItem("auto-make", v ? "1" : "0"); } catch {} };
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function upload(files: FileList | File[]) {
    setErr(null);
    const added: string[] = [];
    for (const f of Array.from(files)) {
      setUploading((u) => [...u, f.name]);
      try {
        const c = await api<ReelClip>(`/api/reels/clips?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream" } });
        added.push(c.id);
      } catch (e) {
        setErr(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((u) => u.filter((x) => x !== f.name));
      }
    }
    qc.invalidateQueries({ queryKey: ["clips"] });
    if (!added.length) return;
    setSelected(auto ? added : [...new Set([...selected, ...added])]);
    if (auto) {  // the clips just dumped in become their own test batch, every trend template that fits
      setAutoMsg(`Judging ${added.length} clips and starting a test batch…`);
      try {
        const j = await api<ReelJob>("/api/reels/direct", { method: "POST", json: { clipIds: added, templateIds: AUTO_TEMPLATES, perTemplate: 2 } });
        // and the reference templates these clips fit best: ones with their reel's sound, text-led first
        const refs = (await api<RefTemplateFit[]>(`/api/reels/templates?clips=${encodeURIComponent(added.join(","))}`))
          .filter((t) => t.literal && t.fit.ok && !t.fit.needs && t.literal.audio)  // ones your footage fully covers
          .sort((a, z) => (z.literal!.lines.length ? 1 : 0) - (a.literal!.lines.length ? 1 : 0)).slice(0, AUTO_REF_TEMPLATES);
        let r: ReelJob | null = null;
        if (refs.length) r = await api<ReelJob>("/api/reels/templates", { method: "POST", json: { clipIds: added, templateIds: refs.map((t) => t.id) } });
        setAutoMsg(`Started ${j.job_id} (${AUTO_TEMPLATES.length} trend templates × A/B)${r ? ` and ${r.job_id} (${refs.length} of your reference templates)` : ""}.`);
        onAutoJob(r?.job_id ?? j.job_id);
        qc.invalidateQueries({ queryKey: ["jobs"] });
      } catch (e) {
        setAutoMsg(`Auto-make failed: ${(e as Error).message}`);
      }
    }
  }
  async function patch(c: ReelClip, body: Partial<ReelClip>) {
    await api(`/api/reels/clips/${c.id}`, { method: "PATCH", json: body });
    qc.invalidateQueries({ queryKey: ["clips"] });
  }
  const [arm, setArm] = useState(false); // two-step clear: browser confirm() dialogs are blocked in the app's browser pane
  async function clear(keep: string[]) {
    await api("/api/reels/clips", { method: "DELETE", json: { keep } });
    setSelected(keep);
    qc.invalidateQueries({ queryKey: ["clips"] });
  }

  return (
    <Card className="xl:col-span-2">
      <CardHeader title="Clip bin" description="Stars mark heroes: a starred clip gets the hook shot and the final shot."
        action={clips.length > 0 && (
          <div className="flex gap-1 text-xs">
            {selected.length > 0 && selected.length < clips.length && (
              <Button variant="ghost" size="sm" onClick={() => clear(selected)} title="Remove every clip you haven't checked">Keep checked only</Button>
            )}
            <Button variant={arm ? "destructive" : "ghost"} size="sm" onBlur={() => setArm(false)}
              title="Removes clips from the bin; footage files and finished videos are kept"
              onClick={() => (arm ? (setArm(false), void clear([])) : setArm(true))}>
              <Trash2 className="h-3.5 w-3.5" />{arm ? `Clear all ${clips.length}? Click to confirm` : "Clear bin"}
            </Button>
          </div>
        )} />
      <CardBody className="space-y-3">
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
          onClick={() => input.current?.click()}
          className={cn("flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-5 text-center text-xs text-muted-foreground", drag && "border-primary bg-primary/5")}
        >
          <Upload className="mb-1 h-5 w-5" />
          Drop footage here (one-shots, b-roll, talking, podcast takes)
          <label onClick={(e) => e.stopPropagation()} className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Auto-make test batches from whatever I drop (trend + your reference templates)
          </label>
          {stub && <span className="mt-1 text-[11px] text-warning">Stub mode: files are recorded, not stored.</span>}
          <input ref={input} type="file" accept="video/*" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
        </div>
        {autoMsg && <p className="text-xs text-primary">{autoMsg}</p>}
        {uploading.map((u) => <div key={u} className="flex items-center gap-2 text-xs"><Loader2 className="h-3 w-3 animate-spin" />{u}</div>)}
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="space-y-1">
          {clips.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs">
              <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} aria-label={`Use ${c.file}`} />
              <button onClick={() => patch(c, { star: !c.star })} aria-label="Star">
                <Star className={cn("h-3.5 w-3.5", c.star ? "fill-warning text-warning" : "text-muted-foreground")} />
              </button>
              <span className="min-w-0 flex-1 truncate" title={c.read ? `${c.file} · ${c.read.scene}${c.read.moments.length ? ` · use ${c.read.moments.map((m) => `${m.t0.toFixed(1)}–${m.t1.toFixed(1)}s (${m.why})`).join(", ")}` : ""}${c.read.flaws ? ` · ${c.read.flaws}` : ""}` : c.read_error ?? c.file}>
                {c.read ? c.read.subject : <span className="font-mono">{c.file}</span>}
              </span>
              {c.read && (
                <span className={cn("num", c.read.skip || c.read.rating < 0.35 ? "text-muted-foreground" : c.read.rating >= 0.75 ? "text-primary" : "text-foreground")}
                  title="How striking Claude rates this clip for a reel (0–10)">
                  {c.read.skip ? "skip" : (c.read.rating * 10).toFixed(0)}
                </span>
              )}
              {c.duration != null && <span className="num text-muted-foreground">{c.duration.toFixed(0)}s</span>}
              <Badge tone="outline" title="Detected automatically. Renders use every checked clip regardless of kind.">{c.kind ?? "detecting…"}</Badge>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

/** Clear every finished video that isn't starred or posted. Two clicks: the first shows what would go. */
function ClearOld({ onCleared }: { onCleared: () => void }) {
  const [plan, setPlan] = useState<{ videos: number; kept: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function click() {
    setMsg(null);
    if (!plan) {
      setBusy(true);
      try { setPlan(await api<{ videos: number; kept: number }>("/api/reels/jobs/clear")); } finally { setBusy(false); }
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ deleted: number; kept: number; failed: string[] }>("/api/reels/jobs/clear", { method: "POST" });
      setMsg(`Deleted ${r.deleted} videos, kept ${r.kept}${r.failed.length ? ` (${r.failed.length} batches still rendering)` : ""}.`);
      setPlan(null);
      onCleared();
    } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      {msg && <span className="text-primary">{msg}</span>}
      {plan && !busy && <button type="button" onClick={() => setPlan(null)} className="text-muted-foreground hover:text-foreground">Cancel</button>}
      <Button size="sm" variant={plan ? "destructive" : "outline"} disabled={busy || (plan?.videos === 0)} onClick={click}
        title="Deletes every finished video made here (test batches, templates) that isn't starred or posted, files included. Starred, posted and imported batches (brag remixes, autopilot) stay.">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        {plan ? (plan.videos ? `Delete ${plan.videos} videos, keep ${plan.kept}?` : "Nothing to clear") : "Clear old videos"}
      </Button>
    </div>
  );
}

// the caption faces the engine can set (engine/common.py FONT), named like the text tools that use them
const CAPTION_FONTS: [string, string][] = [
  ["inter", "Sans (Classic)"], ["inter600", "Sans semibold"], ["inter700", "Sans bold"], ["mont800", "Montserrat bold"], ["mont900", "Montserrat black"],
  ["anton", "Condensed (Anton)"], ["bebas", "Condensed caps (Bebas)"], ["archivo", "Heavy (Archivo)"],
  ["garamond", "Serif (Garamond)"], ["garamond_it", "Serif italic (Garamond)"], ["baskerville", "Serif (Baskerville)"], ["baskerville_it", "Serif italic (Baskerville)"],
  ["serif", "Display serif"], ["serif_it", "Display serif italic"], ["playfair_it", "Playfair italic"], ["typewriter", "Typewriter"], ["hand", "Handwritten"], ["pacifico", "Script"],
];
const hex = (c: number[]) => `#${c.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("")}`;

/** The caption look the reader measured, with a way to correct it: typeface and colour for all of the reel's lines. */
function TextLookEditor({ look, onChange }: { look: { font: string; fill: number[] } | null; onChange: (v: { font?: string; fill?: [number, number, number] }) => void }) {
  return (
    <div className="flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground" title="Measured from the reel; change it if it doesn't look right">
      <span>Text:</span>
      <select aria-label="Caption typeface" value={look?.font ?? ""} onChange={(e) => onChange({ font: e.target.value })} className="min-w-0 flex-1 rounded bg-muted px-1">
        {!look && <option value="">not measured</option>}
        {CAPTION_FONTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      <input type="color" aria-label="Caption colour" value={hex(look?.fill ?? [255, 255, 255])}
        onChange={(e) => { const h = e.target.value; onChange({ fill: [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number] }); }}
        className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0" />
    </div>
  );
}

function Gallery({ jobId, stub, onGone }: { jobId: string; stub: boolean; onGone: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["job", jobId], queryFn: () => api<JobDetail>(`/api/reels/jobs/${encodeURIComponent(jobId)}`),
    refetchInterval: (x) => (x.state.data && ["queued", "rendering"].includes(x.state.data.job.status) ? 2500 : false),
  });
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [arm, setArm] = useState<string | null>(null);  // video (or "job") armed for delete: a second click deletes
  const status = q.data?.job.status;
  useEffect(() => { if (status === "done") qc.invalidateQueries({ queryKey: ["jobs"] }); }, [status, qc]);
  // Claude revisions of this batch's videos, polled while one is thinking or rendering
  const revs = useQuery({
    queryKey: ["revisions", jobId], queryFn: () => api<Record<string, Revision>>(`/api/reels/variants/revise?job_id=${encodeURIComponent(jobId)}`),
    enabled: status === "done", refetchInterval: (x) => (Object.values(x.state.data ?? {}).some((r) => r.status === "thinking" || r.status === "rendering") ? 3000 : false),
  });
  const finished = Object.values(revs.data ?? {}).filter((r) => r.status === "done").length;
  useEffect(() => { if (finished) qc.invalidateQueries({ queryKey: ["job", jobId] }); }, [finished, jobId, qc]);
  if (!q.data) return <Card><CardBody><Loader2 className="h-4 w-4 animate-spin" /></CardBody></Card>;
  const { job, variants, posts } = q.data;
  const file = (n: string | null) => (n ? `/api/reels/files/${encodeURIComponent(job.job_id)}/${encodeURIComponent(n)}` : null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["job", jobId] });

  async function remove(variant?: string) {
    if (arm !== (variant ?? "job")) { setArm(variant ?? "job"); return; }
    setArm(null);
    try {
      const r = await api<{ deleted: number; kept: number; job_deleted: boolean }>(`/api/reels/jobs/${encodeURIComponent(jobId)}${variant ? `?variant=${encodeURIComponent(variant)}` : ""}`, { method: "DELETE" });
      if (r.job_deleted) return onGone();
      setNote(r.deleted ? "Deleted." : "Kept: it's been posted, so its results stay.");
      refresh();
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  async function act(v: ReelVariant, body: Record<string, unknown>, msg: string) {
    await api("/api/reels/variants", { method: "POST", json: { job_id: v.job_id, id: v.id, ...body } });
    setNote(msg);
    refresh();
  }

  return (
    <Card>
      <CardHeader title={<span className="font-mono">{job.job_id}</span>} description={`${variants.length} variants · ${job.status}${job.error ? ` · ${job.error}` : ""}`}
        action={<div className="flex items-center gap-2 text-xs">{note && <span className="text-primary">{note}</span>}
          {(job.status === "done" || job.status === "error") && <Button size="sm" variant={arm === "job" ? "destructive" : "ghost"} onClick={() => remove()} onBlur={() => setArm(null)}
            title="Delete this whole batch, files included (posted videos stay)"><Trash2 className="h-3.5 w-3.5" />{arm === "job" ? "Delete batch?" : ""}</Button>}</div>} />
      {job.status !== "done" ? (
        job.status === "error" ? (
          <CardBody className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-destructive">{job.error}</span>
            <Button size="sm" variant="outline" onClick={async () => { await api(`/api/reels/jobs/${encodeURIComponent(job.job_id)}/retry`, { method: "POST" }); refresh(); qc.invalidateQueries({ queryKey: ["jobs"] }); }}>Retry</Button>
          </CardBody>
        ) : (
          <CardBody className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Rendering… analysis is cached per clip, ~20-40s per 12s variant on 4 cores.</CardBody>
        )
      ) : (
        <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {variants.map((v) => (
            <div key={v.id} className={cn("overflow-hidden rounded-md border text-xs", v.picked && "border-primary")}>
              <div className={cn("relative bg-gradient-to-b from-muted to-background", v.format === "carousel" ? "aspect-[4/5]" : "aspect-[9/16]")}>
                {playing === v.id && file(v.file) ? (
                  <video src={file(v.file)!} poster={file(v.poster) ?? undefined} controls autoPlay className="h-full w-full object-cover" />
                ) : (
                  <>
                    {/* Engine posters are proxied private media; next/image optimization would need the token. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {!job.stub && file(v.poster) && <img src={file(v.poster)!} alt={v.hook ?? v.id} className="absolute inset-0 h-full w-full object-cover" />}
                    {/* Hook on frame 0, inside the safe zone (top 12% → bottom 24% kept clear). */}
                    {(job.stub || !v.poster) && <div className="absolute inset-x-[6%] top-[14%] text-center text-[13px] font-extrabold leading-tight text-white [text-shadow:0_1px_6px_rgba(0,0,0,.8)]">{v.hook}</div>}
                    {!job.stub && v.file && <button onClick={() => setPlaying(v.id)} className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100" aria-label="Play"><Play className="h-10 w-10 fill-white text-white" /></button>}
                    {job.stub && <div className="absolute bottom-[26%] inset-x-0 text-center text-[10px] text-muted-foreground">stub · no media</div>}
                  </>
                )}
                <button onClick={() => act(v, { action: "pick", picked: !v.picked }, v.picked ? "Unstarred." : "Starred as a keeper.")} className="absolute right-1.5 top-1.5 rounded bg-black/40 p-1" aria-label="Star keeper">
                  <Star className={cn("h-3.5 w-3.5", v.picked ? "fill-warning text-warning" : "text-white")} />
                </button>
                <button onClick={() => remove(v.id)} onBlur={() => setArm(null)} className={cn("absolute left-1.5 top-1.5 rounded p-1 text-[10px] font-medium text-white", arm === v.id ? "bg-destructive" : "bg-black/40")}
                  aria-label="Delete video" title="Delete this video (click again to confirm)">
                  {arm === v.id ? "Delete?" : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
              <div className="space-y-1.5 p-2">
                <div className="flex flex-wrap gap-1"><Badge>{v.format}</Badge><Badge tone="outline">{v.grade}</Badge><Badge tone="outline">{v.duration}s</Badge><Badge tone="outline">{v.hook_id}</Badge></div>
                {v.warnings.length > 0 && <div className="text-[10px] text-warning">{v.warnings.length} text warning(s)</div>}
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => { navigator.clipboard.writeText(v.caption ?? ""); setNote("Caption copied."); }}><Copy className="h-3 w-3" /></Button>
                  {!job.stub && v.file && <a href={file(v.file)!} download className="inline-flex h-6 items-center rounded px-1.5 hover:bg-accent" title="Download (music baked)"><Download className="h-3 w-3" /></a>}
                  {!job.stub && v.bare && <a href={file(v.bare)!} download className="inline-flex h-6 items-center rounded px-1.5 text-[10px] hover:bg-accent" title="No music: add the trending sound in-app">bare</a>}
                  <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => act(v, { action: "approve" }, "Sent to the approval queue.")} title="Send to approval"><Send className="h-3 w-3" /></Button>
                </div>
                <MarkPosted v={v} onDone={refresh} />
                {v.tags?.revision_of && <div className="line-clamp-3 text-[10px] text-muted-foreground" title={`${v.tags.revision_ask}

${v.tags.revision_summary ?? ""}`}>Revised from {v.tags.revision_of}{v.tags.revision_summary ? `: ${v.tags.revision_summary}` : ""}</div>}
                {v.tags?.slides && <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">Slides:
                  {v.tags.slides.split(",").map((s, i) => <a key={s} href={file(s)!} download className="rounded border px-1 hover:bg-accent">{i + 1}</a>)}</div>}
                {!job.stub && v.format !== "carousel" && <ReviseBox v={v} rev={revs.data?.[v.id]} onSent={() => qc.invalidateQueries({ queryKey: ["revisions", jobId] })} />}
              </div>
            </div>
          ))}
        </div>
      )}
      {posts.length > 0 && <PostsTable posts={posts} variants={variants} onSaved={refresh} />}
    </Card>
  );
}

interface Revision { status: "thinking" | "rendering" | "done" | "error"; ask: string; id?: string; summary?: string; error?: string }

/** Ask Claude to change this one video; the change renders as a new copy beside it (lib/reel-revise.ts). */
function ReviseBox({ v, rev, onSent }: { v: ReelVariant; rev?: Revision; onSent: () => void }) {
  const [ask, setAsk] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const busy = rev?.status === "thinking" || rev?.status === "rendering";
  async function send() {
    setErr(null);
    try {
      await api("/api/reels/variants/revise", { method: "POST", json: { job_id: v.job_id, id: v.id, ask } });
      setAsk("");
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="space-y-1 border-t pt-1.5">
      <div className="flex items-start gap-1">
        <textarea value={ask} onChange={(e) => setAsk(e.target.value)} rows={2} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && ask.trim().length > 2) { e.preventDefault(); send(); } }}
          placeholder="Ask Claude to change this video…" className="min-h-[2.25rem] w-full resize-y rounded border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary" />
        <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={busy || ask.trim().length < 3} onClick={send} title="Claude edits it and renders a new copy beside this one">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
        </Button>
      </div>
      {err && <div className="text-[10px] text-destructive">{err}</div>}
      {rev && (
        <div className={cn("line-clamp-3 text-[10px]", rev.status === "error" ? "text-destructive" : "text-muted-foreground")} title={`${rev.ask}

${rev.summary ?? rev.error ?? ""}`}>
          {rev.status === "thinking" && "Claude is working out the edit…"}
          {rev.status === "rendering" && `Rendering ${rev.id}…${rev.summary ? ` ${rev.summary}` : ""}`}
          {rev.status === "done" && (rev.id ? `Added ${rev.id}. ${rev.summary ?? ""}` : rev.summary)}
          {rev.status === "error" && rev.error}
        </div>
      )}
    </div>
  );
}

function MarkPosted({ v, onDone }: { v: ReelVariant; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<"ig" | "tiktok">("ig");
  const [url, setUrl] = useState("");
  const [sound, setSound] = useState("");
  if (!open) return <button onClick={() => setOpen(true)} className="text-[11px] text-muted-foreground hover:text-foreground">Mark posted…</button>;
  return (
    <form className="space-y-1" onSubmit={async (e) => { e.preventDefault(); await api("/api/reels/posts", { method: "POST", json: { job_id: v.job_id, variant_id: v.id, platform, url, sound } }); setOpen(false); onDone(); }}>
      <Select className="h-6 w-full px-1 text-[11px]" value={platform} onChange={(e) => setPlatform(e.target.value as "ig")}><option value="ig">Instagram</option><option value="tiktok">TikTok</option></Select>
      <Input className="h-6 px-1.5 text-[11px]" placeholder="Post URL" value={url} onChange={(e) => setUrl(e.target.value)} />
      <Input className="h-6 px-1.5 text-[11px]" placeholder="Trending sound (if bare)" value={sound} onChange={(e) => setSound(e.target.value)} />
      <Button size="sm" className="h-6 w-full">Save</Button>
    </form>
  );
}

const METRICS = ["views", "avg_watch_s", "likes", "comments", "shares", "saves", "follows"] as const;

function PostsTable({ posts, variants, onSaved }: { posts: ReelPost[]; variants: ReelVariant[]; onSaved: () => void }) {
  const [edit, setEdit] = useState<Record<number, Partial<ReelPost>>>({});
  return (
    <div className="border-t">
      <div className="px-4 pt-3 text-xs text-muted-foreground">Posted variants. Log numbers after 48-72h, then run the learn loop.</div>
      <Table>
        <thead><tr><Th>Variant</Th><Th>Platform</Th><Th>Sound</Th>{METRICS.map((m) => <Th key={m} className="text-right">{m.replace("_s", " (s)").replace("_", " ")}</Th>)}<Th /></tr></thead>
        <tbody>{posts.map((p) => {
          const v = variants.find((x) => x.id === p.variant_id);
          const cur = { ...p, ...edit[p.id] };
          return (
            <tr key={p.id}>
              <Td className="max-w-[14rem]"><div className="truncate font-mono text-xs">{p.variant_id}</div><div className="truncate text-[11px] text-muted-foreground">{v?.hook}</div></Td>
              <Td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer" className="text-primary">{p.platform}</a> : p.platform}</Td>
              <Td className="max-w-[8rem] truncate text-[11px] text-muted-foreground">{p.sound ?? "baked"}</Td>
              {METRICS.map((m) => (
                <Td key={m} className="p-1"><Input className="h-7 w-20 px-1.5 text-right text-xs" inputMode="decimal" value={cur[m] ?? ""} onChange={(e) => setEdit((x) => ({ ...x, [p.id]: { ...x[p.id], [m]: e.target.value } }))} /></Td>
              ))}
              <Td>{edit[p.id] && <Button size="sm" onClick={async () => { await api("/api/reels/posts", { method: "PATCH", json: { id: p.id, ...edit[p.id] } }); setEdit((x) => { const y = { ...x }; delete y[p.id]; return y; }); onSaved(); }}>Save</Button>}</Td>
            </tr>
          );
        })}</tbody>
      </Table>
    </div>
  );
}

function LearnPanel({ onNext }: { onNext: (n: NextMatrix) => void }) {
  const qc = useQueryClient();
  const learn = useMutation({
    mutationFn: () => api<{ leaderboard: Leaderboard; next: NextMatrix; source: string; rows: number; changed: string[] }>("/api/reels/learn", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hooks"] }),
  });
  const d = learn.data;
  const dims = useMemo(() => (d ? Object.entries(d.leaderboard).filter(([, v]) => v.length) : []), [d]);
  return (
    <Card>
      <CardHeader
        title="What's winning"
        description="Retention first, then shares/saves, z-scored per platform with shrinkage. Hooks retire after 3 posts below median and win after 2 above."
        action={<Button size="sm" onClick={() => learn.mutate()} disabled={learn.isPending}>{learn.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Run learn loop</Button>}
      />
      <CardBody>
        {!d ? <Empty>Run the learn loop to rank hooks, formats and looks from logged post metrics.</Empty> : (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">{d.rows} posts scored via {d.source === "engine" ? "engine POST /learn" : "local port of learn.py"}.{d.changed.length ? ` Hook updates: ${d.changed.join(", ")}.` : ""}</div>
            <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
              {dims.map(([dim, rows]) => (
                <div key={dim} className="rounded-md border">
                  <div className="border-b px-2 py-1.5 text-xs font-medium">{dim}</div>
                  {rows.map((r) => (
                    <div key={r.value} className="flex justify-between gap-2 px-2 py-1 text-xs">
                      <span className="truncate">{musicLabel(r.value)}</span>
                      <span className={cn("num", r.shrunk > 0 ? "text-success" : "text-muted-foreground")}>{r.shrunk.toFixed(2)} <span className="text-muted-foreground">n{r.n}</span></span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/40 p-3 text-xs">
              <div>
                <div className="font-medium">Next batch</div>
                <div className="text-muted-foreground">Formats {d.next.formats.join(", ")} · winning hooks {d.next.rationale.winning_hooks.join(", ") || "none yet"} · exploring {d.next.rationale.exploring.join(", ")}</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => onNext(d.next)}>Load into builder</Button>
            </div>
          </div>
        )}
        {learn.error && <p className="mt-2 text-xs text-destructive">{(learn.error as Error).message}</p>}
      </CardBody>
    </Card>
  );
}

function References({ initial, stub, onUse }: { initial: ReelRef[]; stub: boolean; onUse: (r: ReelRef) => void }) {
  const qc = useQueryClient();
  // links are read in the background after they're added: poll until each has been read
  const refs = useQuery({
    queryKey: ["refs"], queryFn: () => api<ReelRef[]>("/api/reels/refs"), initialData: initial,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.url && !r.metrics.read_at && r.source !== "watchlist") ? 5000 : false),
  });
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(true);
  useEffect(() => { try { if (localStorage.getItem("refs-open") === "0") setOpen(false); } catch {} }, []);
  function toggle() {
    setOpen((o) => { try { localStorage.setItem("refs-open", o ? "0" : "1"); } catch {} return !o; });
  }
  const [format, setFormat] = useState("montage");
  const [look, setLook] = useState("");
  const [hook, setHook] = useState("");
  const [notes, setNotes] = useState("");
  // what to take from it: a fixed template (default) or only some parts. Unset = decided from the note.
  const [intent, setIntent] = useState<"" | "template" | "both" | "learn">("");
  const [aspects, setAspects] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const refresh = () => qc.invalidateQueries({ queryKey: ["refs"] });

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await api("/api/reels/refs", { method: "POST", json: {
        url: url.trim(), format, notes, look: look || undefined, hook: hook || undefined,
        ...(intent ? { intent, learn: intent === "template" ? [] : aspects } : {}),
      } });
      setUrl("");
      setNotes("");
      setHook("");
      setIntent("");
      setAspects([]);
      refresh();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function addFiles(files: FileList | File[]) {
    setErr(null);
    for (const f of Array.from(files)) {
      setBusy((b) => [...b, f.name]);
      try {
        await api(`/api/reels/refs?name=${encodeURIComponent(f.name)}&notes=${encodeURIComponent(notes)}${intent ? `&intent=${intent}` : ""}`, { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream" } });
      } catch (x) {
        setErr(`${f.name}: ${(x as Error).message}`);
      } finally {
        setBusy((b) => b.filter((n) => n !== f.name));
      }
    }
    refresh();
  }
  async function retag(id: string, body: { format?: string; look?: string | null; hook?: string; song?: string; reread?: boolean; intent?: string; learn?: string[]; textLook?: { font?: string; fill?: [number, number, number] } }) {
    await api("/api/reels/refs", { method: "PATCH", json: { id, ...body } });
    refresh();
  }
  async function remove(id: string) {
    await api(`/api/reels/refs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    refresh();
  }
  // A reel link can be dragged in from the browser's address bar too.
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) return addFiles(e.dataTransfer.files);
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (text) setUrl(text.split("\n")[0].trim());
  }

  const list = refs.data.filter((r) => filter === "all" || r.format === filter || r.source === filter);
  const chips = ["all", "file", "instagram", "tiktok", "watchlist", ...REF_FORMATS];
  return (
    <Card>
      <CardHeader
        title={<button type="button" onClick={toggle} aria-expanded={open} className="inline-flex items-center gap-1.5 hover:text-primary">
          <ChevronDown className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")} />Style references
          {!open && <span className="text-xs font-normal text-muted-foreground">· {refs.data.length}</span>}
        </button>}
        description={open ? "What good looks like. Paste or drag a reel link: it's watched and read automatically (its cuts, on-screen text and color), then becomes a template your clips are fitted to, or only teaches the parts you ask for. Video files work too." : undefined}
      />
      {open && <CardBody className="space-y-3">
        <div className="grid gap-3 lg:grid-cols-[1fr_1.4fr]">
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={() => input.current?.click()}
            className={cn("flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-5 text-center text-xs text-muted-foreground", drag && "border-primary bg-primary/5")}
          >
            <Upload className="mb-1 h-5 w-5" />
            Drop a reference video, or drag a reel link here
            <span className="mt-1 text-[11px]">{stub ? "Engine offline: files are recorded but not measured." : "Measured: shots, cuts per 10s, opening hold, suggested pacing."}</span>
            <input ref={input} type="file" accept="video/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </div>
          <form onSubmit={addLink} className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {([["template", "Make a template from it"], ["both", "Template + learn"], ["learn", "Just learn from it"]] as const).map(([k, label]) => {
                const on = intent === k || (!intent && k === "template");
                return <button key={k} type="button" onClick={() => setIntent(k)} className={cn("rounded-md border px-2 py-1", on ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground hover:bg-accent/40")}>{label}</button>;
              })}
              {(intent === "learn" || intent === "both") && REF_ASPECTS.map((a) => (
                <button key={a} type="button" onClick={() => setAspects((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a]))}
                  className={cn("rounded px-1.5 py-0.5", aspects.includes(a) ? "bg-accent text-foreground" : "text-muted-foreground")}>{a === "cuts" ? "editing / cuts" : a}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input placeholder="https://www.instagram.com/reel/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <Select value={format} onChange={(e) => setFormat(e.target.value)} title="Edit structure">{REF_FORMATS.map((f) => <option key={f}>{f}</option>)}</Select>
              <Select value={look} onChange={(e) => setLook(e.target.value)} title="Color look">
                <option value="">look…</option>{REEL_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground"><b>Format</b> is the edit: montage = beat cuts, cinematic = few long holds + letterbox, oneshot = one take. <b>Look</b> is the color: pick film/golden/moody for a cinematic feel on a fast edit.</p>
            <Input placeholder="Its hook: the opening text, word for word (joins your hook pool)" value={hook} onChange={(e) => setHook(e.target.value)} />
            <Input placeholder="Your note: e.g. 'make a template' or 'just learn the color and editing technique'" value={notes} onChange={(e) => setNotes(e.target.value)} />
            {!intent && <p className="text-[11px] text-muted-foreground">Not picked: your note decides. It makes a template unless the note says to only learn something (color, editing, text, music).</p>}
            <Button variant="outline" disabled={!url.trim()}><Link2 className="h-4 w-4" />Add link</Button>
            {busy.map((b) => <div key={b} className="flex items-center gap-2 text-xs"><Loader2 className="h-3 w-3 animate-spin" />Measuring {b}…</div>)}
            {err && <p className="text-xs text-destructive">{err}</p>}
          </form>
        </div>
        <div className="flex flex-wrap gap-1 text-xs">
          {chips.map((f) => {
            const n = f === "all" ? refs.data.length : refs.data.filter((r) => r.format === f || r.source === f).length;
            return n ? <button key={f} onClick={() => setFilter(f)} className={cn("rounded px-2 py-0.5", filter === f ? "bg-accent text-foreground" : "text-muted-foreground")}>{f} {n}</button> : null;
          })}
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {list.map((r) => (
            <div key={r.id} className="flex flex-col rounded-md border p-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium" title={r.metrics.caption ?? r.title ?? ""}>{r.title ?? r.url ?? r.file}</div>
                  {(r.metrics.purpose || r.metrics.account) && (
                    <div className="truncate text-[11px] text-muted-foreground">{r.metrics.purpose}{r.metrics.account ? `${r.metrics.purpose ? " · " : ""}@${r.metrics.account}` : ""}</div>
                  )}
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <Badge tone="outline">{r.source}</Badge>
                    <select aria-label="Format" value={r.format} onChange={(e) => retag(r.id, { format: e.target.value })} className="rounded bg-muted px-1 text-[11px]">{REF_FORMATS.map((f) => <option key={f}>{f}</option>)}</select>
                    <select aria-label="Look" value={r.metrics.look ?? ""} onChange={(e) => retag(r.id, { look: e.target.value || null })} className="rounded bg-muted px-1 text-[11px]"><option value="">no look</option>{REEL_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</select>
                    {r.metrics.pacing && <Badge tone="primary">{r.metrics.pacing}</Badge>}
                    {r.url && <select aria-label="Use" value={r.metrics.intent === "learn" ? "learn" : r.metrics.learn?.length ? "both" : "template"} onChange={(e) => retag(r.id, { intent: e.target.value, learn: r.metrics.learn })}
                      className="rounded bg-muted px-1 text-[11px]" title="Template: your clips are fitted to its cuts, text and song. Learn: its parts feed your other edits. Both: a template that also teaches.">
                      <option value="template">template</option><option value="both">template + learn</option><option value="learn">learn{r.metrics.learn?.length ? `: ${r.metrics.learn.join(", ")}` : ""}</option>
                    </select>}
                  </div>
                  {r.url && !r.metrics.read_at && r.source !== "watchlist" && <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Watching the reel: cuts, text, color…</div>}
                  {r.metrics.read_error && <div className="mt-1 text-[11px] text-destructive" title={r.metrics.read_error}>Couldn&apos;t read it: {r.metrics.read_error.slice(0, 80)}</div>}
                </div>
                <button onClick={() => remove(r.id)} className="text-muted-foreground hover:text-destructive" aria-label="Remove reference"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              {r.metrics.shots != null && (
                <div className="mt-1.5 grid grid-cols-4 gap-1 text-center">
                  {([["shots", String(r.metrics.shots)], ["avg shot", `${r.metrics.avg_shot}s`], ["cuts/10s", String(r.metrics.cuts_per_10s)], ["opens", `${r.metrics.opening_hold}s`]] as const).map(([k, v]) => (
                    <div key={k} className="rounded bg-muted/50 py-1"><div className="num font-medium">{v}</div><div className="text-[10px] text-muted-foreground">{k}</div></div>
                  ))}
                </div>
              )}
              {r.metrics.likes != null && <div className="mt-1 text-[11px] text-muted-foreground">{r.metrics.likes} likes{r.metrics.observed_at ? ` · seen ${fmt.date(r.metrics.observed_at)}` : ""}</div>}
              <input defaultValue={r.metrics.hook ?? ""} placeholder="+ its hook (opening text)" aria-label="Reference hook"
                onBlur={(e) => { if (e.target.value.trim() !== (r.metrics.hook ?? "")) retag(r.id, { hook: e.target.value }); }}
                className="mt-1.5 w-full rounded border border-transparent bg-muted/40 px-1.5 py-0.5 text-[11px] italic placeholder:not-italic hover:border-input focus:border-input focus:outline-none" />
              <input defaultValue={r.metrics.song ?? ""} placeholder="+ its song (e.g. Someone New · Hozier)" aria-label="Reference song"
                onBlur={(e) => { if (e.target.value.trim() !== (r.metrics.song ?? "")) retag(r.id, { song: e.target.value }); }}
                className="mt-1 w-full rounded border border-transparent bg-muted/40 px-1.5 py-0.5 text-[11px] placeholder:text-muted-foreground hover:border-input focus:border-input focus:outline-none" />
              {r.metrics.lines?.length ? (
                <div className="mt-1 space-y-0.5 text-[11px]" title="On-screen text, read from the video">
                  {r.metrics.lines.slice(0, 4).map((l, i) => <div key={i} className="truncate"><span className="text-muted-foreground">{l.t != null ? `${l.t.toFixed(1)}s` : `shot ${l.shot + 1}`}: </span>{l.text}</div>)}
                  {r.metrics.lines.length > 4 && <div className="text-muted-foreground">+{r.metrics.lines.length - 4} more</div>}
                  <TextLookEditor look={r.metrics.lines.find((l) => l.look)?.look ?? null} onChange={(textLook) => retag(r.id, { textLook })} />
                </div>
              ) : null}
              {(r.file || r.metrics.read_at) && (
                <button type="button" onClick={() => retag(r.id, { reread: true })} className="mt-1 self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{r.url ? "Read it again" : "Read its on-screen text"}</button>
              )}
              {r.notes && <p className="mt-1 line-clamp-3 whitespace-pre-line text-[11px] text-muted-foreground" title={r.notes}>{r.notes}</p>}
              <div className="mt-auto flex gap-1.5 pt-2">
                <Button size="sm" variant="outline" onClick={() => onUse(r)}><Wand2 className="h-3.5 w-3.5" />Use as style</Button>
                {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1 rounded px-2 text-muted-foreground hover:bg-accent"><ExternalLink className="h-3.5 w-3.5" />Open</a>}
              </div>
            </div>
          ))}
        </div>
      </CardBody>}
    </Card>
  );
}

interface TrendSound { id: string; title: string; why: string | null; seen: string | null; url: string | null; source: string }

/**
 * Sounds trending in travel / cinematic short-form right now. Licensed platform audio can't be baked into a render,
 * so these are added in Instagram/TikTok on the variant's _bare cut (same cut points, music-free).
 */
function TrendingSounds() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["reel-trends"], queryFn: () => api<{ sounds: TrendSound[]; canRefresh: boolean }>("/api/reels/trends") });
  const refresh = useMutation({
    mutationFn: () => api<{ sounds: number; hooks: number }>("/api/reels/trends", { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["reel-trends"] }); qc.invalidateQueries({ queryKey: ["hooks"] }); },
  });
  const sounds = q.data?.sounds ?? [];
  return (
    <div className="mt-2 rounded-md border border-dashed p-2 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium">Trending sounds <span className="font-normal text-muted-foreground">· add in-app on the _bare cut</span></span>
        <button type="button" disabled={!q.data?.canRefresh || refresh.isPending} onClick={() => refresh.mutate()}
          title={q.data?.canRefresh ? "Search the web for sounds and hooks trending this month" : "Needs ANTHROPIC_API_KEY"}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50">
          {refresh.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}Refresh
        </button>
      </div>
      {refresh.error && <p className="text-destructive">{(refresh.error as Error).message}</p>}
      {refresh.data && <p className="text-muted-foreground">Found {refresh.data.sounds} sounds, {refresh.data.hooks} new hooks.</p>}
      {sounds.length === 0 ? <p className="text-muted-foreground">None yet. Refresh, or let the CMO watchlist flag some.</p> : (
        <ul className="space-y-1">
          {sounds.slice(0, 8).map((x) => (
            <li key={x.id} className="flex items-start justify-between gap-2">
              <span><span className="font-medium">{x.title}</span>{x.why && <span className="text-muted-foreground"> · {x.why}</span>}{x.seen && <span className="text-muted-foreground"> · {x.seen}</span>}</span>
              {x.url && <a href={x.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground"><ExternalLink className="h-3 w-3" /></a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Music picker: hovering a bundled track plays it (from 20s in, where these tracks get going). */
function MusicChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["music"], queryFn: () => api<{ path: string; label: string; source: "song" | "reel"; refId?: string }[]>("/api/reels/music") });
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sounds = list.data ?? [];
  const tracks = sounds.map((t) => t.path);
  const byPath = new Map(sounds.map((t) => [t.path, t]));
  async function upload(files: FileList) {
    setErr(null);
    for (const f of Array.from(files)) {
      setUploading(f.name);
      const r = await fetch(`/api/reels/music?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Upload failed");
      else onChange([`music/${f.name}`, ...value.filter((v) => v !== `music/${f.name}`)]);
    }
    setUploading(null);
    qc.invalidateQueries({ queryKey: ["music"] });
  }
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  function play(m: string) {
    const t = byPath.get(m);
    audio.current?.pause();
    const a = new Audio(t?.refId ? `/api/reels/refs/${encodeURIComponent(t.refId)}/video` : `/api/reels/music/${encodeURIComponent(m.split("/").pop()!)}`);
    a.volume = 0.6;
    a.play().then(() => setPlaying(m)).catch(() => setPlaying(null));
    audio.current = a;
  }
  function stop() {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }
  useEffect(() => stop, []);
  return (
    <div className="space-y-2">
    {!tracks.length && <p className="text-xs text-muted-foreground">No trending sounds yet. Drop the song file, or a screen recording of a reel that uses it into Style references.</p>}
    <div className="flex flex-wrap gap-1">
      {tracks.map((m) => {
        const on = value.includes(m);
        return (
          <button key={m} type="button" onMouseEnter={() => play(m)} onMouseLeave={stop} onFocus={() => play(m)} onBlur={stop}
            title={byPath.get(m)?.source === "reel" ? "The sound of a reference reel you dropped: hover to hear it" : "Hover to preview"}
            onClick={() => onChange(on ? value.filter((y) => y !== m) : [...value, m])}
            className={cn("rounded border px-2 py-0.5 text-xs", on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground", playing === m && "ring-1 ring-primary")}>
            {playing === m ? "♪ " : ""}{byPath.get(m)?.label ?? musicLabel(m)}
          </button>
        );
      })}
    </div>
    <label
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
      className={cn("flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground", drag && "border-primary bg-primary/5")}>
      {uploading ? <><Loader2 className="h-3 w-3 animate-spin" />Uploading {uploading}…</> : <><Upload className="h-3 w-3" />Drop trending sounds here (mp3, m4a, wav)</>}
      <input type="file" accept="audio/*" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
    </label>
    {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
