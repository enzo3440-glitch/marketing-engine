"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReelHook, ReelJob } from "@engine/db/types";
import { Check, ExternalLink, FlaskConical, Loader2, Star, Wand2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

/** Copy of a trend / reference edit structure, from engine/edit_rules.py. */
interface LibTemplate {
  id: string; name: string; vibe: string; trend: string; audio: "clip_music" | "own_or_trending" | "trending";
  pacing: string; grade: string; fx: string; shots: number; hooks: string[]; needs_sound: boolean; build_drop?: boolean; letterbox?: boolean;
}
/** A reference video you dropped, copied literally: its cuts, words and sound. */
interface RefTemplate {
  id: string; name: string; blurb: string; fit: { ok: boolean; note: string; needs?: string }; purpose?: string | null;
  literal?: { refId: string; slots: number[]; lines: { shot: number; t?: number; text: string; pos?: string }[]; song: string | null; file: string | null; url: string | null };
}
/** A reference link's style copy: closest library structure + its own hook, look and song. */
interface StyleTemplate { id: string; refId: string; name: string; base: string; url: string | null; hook: string | null; look: string | null; song: string | null; notes: string | null; format: string; thin: boolean }

/** One style per distinct edit: thin link copies of the same structure and look collapse to one. */
function distinctStyles(styles: StyleTemplate[]): StyleTemplate[] {
  const seen = new Set<string>();
  return styles.filter((t) => {
    const key = t.thin ? `${t.base}|${t.look ?? ""}` : t.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
interface Library { templates: LibTemplate[]; rules: Record<string, string[]>; sounds: { path: string; label: string; source: string }[] }

const AUDIO_LABEL: Record<LibTemplate["audio"], string> = {
  clip_music: "live music from your clips",
  own_or_trending: "the shot's own sound, else a trending sound",
  trending: "trending sound",
};
const TEST_SETS = [
  { n: 1, label: "A only", note: "one version per template" },
  { n: 2, label: "A + B", note: "B swaps the opening (hook) shot" },
  { n: 3, label: "A + B + C", note: "C swaps the hook text" },
];

/** A link template's rhythm at a glance: one bar per shot, as wide as it's long. */
export function CutStrip({ slots }: { slots: number[] }) {
  const total = slots.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="flex h-36 w-[80px] shrink-0 flex-col gap-px overflow-hidden rounded bg-black p-1" title={slots.map((s) => `${s.toFixed(2)}s`).join(" · ")}>
      {slots.map((s, i) => <div key={i} className={cn("w-full rounded-sm", i % 2 ? "bg-primary/60" : "bg-primary")} style={{ height: `${(100 * s) / total}%`, minHeight: 1 }} />)}
    </div>
  );
}

export function RefPreview({ refId }: { refId: string }) {
  return (
    <video src={`/api/reels/refs/${encodeURIComponent(refId)}/video`} muted loop playsInline preload="metadata"
      onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()}
      className="h-36 w-[80px] shrink-0 rounded bg-black object-cover" />
  );
}

/**
 * Make test batches: the director judges the checked clips (live music, steady hero shots, details, motion, people)
 * and casts them into trend templates. Each template gets a test set (A baseline, B other opening shot, C other hook)
 * so trial reels show which formula sticks.
 */
export function TemplateMaker({ clipIds, hooks, onCreated, soundDrop }: { clipIds: string[]; hooks: ReelHook[]; onCreated: (jobId: string) => void; soundDrop: React.ReactNode }) {
  const qc = useQueryClient();
  const lib = useQuery({ queryKey: ["direct-lib"], queryFn: () => api<Library>("/api/reels/direct") });
  const key = [...clipIds].sort().join(",");
  const refs = useQuery({ queryKey: ["templates", key], queryFn: () => api<RefTemplate[]>(`/api/reels/templates?clips=${encodeURIComponent(key)}`) });
  const refTemplates = (refs.data ?? []).filter((t) => t.literal);
  const styles = useQuery({ queryKey: ["style-templates"], queryFn: () => api<StyleTemplate[]>("/api/reels/templates?kind=style") });
  const baseName = (id: string) => lib.data?.templates.find((t) => t.id === id)?.name ?? id;
  const thinCount = styles.data?.filter((t) => t.thin).length ?? 0;
  const [vibe, setVibe] = useState("all");
  const [picked, setPicked] = useState<string[]>(["natural-score", "hero-oneshot", "slow-travel-diary", "beat-photo-dump"]);
  const [perTemplate, setPerTemplate] = useState(3);
  const [hook, setHook] = useState("");
  const [place, setPlace] = useState("");
  const [save, setSave] = useState(true);
  const [showRules, setShowRules] = useState(false);

  const sounds = lib.data?.sounds ?? [];
  const templates = (lib.data?.templates ?? []).filter((t) => vibe === "all" || t.vibe === vibe);
  const showRefs = vibe === "all" || vibe === "your references";
  const vibes = ["all", ...new Set((lib.data?.templates ?? []).map((t) => t.vibe)), "your references"];
  const libPicked = picked.filter((p) => !p.startsWith("ref-"));
  const refPicked = picked.filter((p) => p.startsWith("ref-"));
  const videos = libPicked.length * perTemplate + refPicked.length;
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  const saved = hooks.filter((h) => h.status === "winner" || h.source === "owner").filter((h) => h.status !== "retired").slice(0, 12);
  const make = useMutation({
    mutationFn: async () => {
      const text = hook.trim();
      if (text && save && !hooks.some((h) => h.text.toLowerCase() === text.toLowerCase())) {
        await api("/api/reels/hooks", { method: "POST", json: { text, source: "owner" } }).catch(() => null);
      }
      let last: ReelJob | null = null;
      if (libPicked.length) {
        last = await api<ReelJob>("/api/reels/direct", { method: "POST", json: { clipIds, templateIds: libPicked, perTemplate, hook: text || undefined, place: place || undefined } });
      }
      if (refPicked.length) {
        last = await api<ReelJob>("/api/reels/templates", { method: "POST", json: { clipIds, templateIds: refPicked, hook: text || undefined, place: place || undefined } });
      }
      return last!;
    },
    onSuccess: (j) => { onCreated(j.job_id); qc.invalidateQueries({ queryKey: ["jobs"] }); qc.invalidateQueries({ queryKey: ["hooks"] }); },
  });
  const markWorks = useMutation({
    mutationFn: (h: ReelHook) => api("/api/reels/hooks", { method: "PATCH", json: { id: h.id, status: h.status === "winner" ? "testing" : "winner" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hooks"] }),
  });

  return (
    <Card id="templates" className="xl:col-span-3">
      <CardHeader title="Make test batches"
        description="The director judges every checked clip (live music, steady hero shots, details, motion, people) and casts them into viral edit templates. Each template gets a test set so trial reels show which formula sticks." />
      <CardBody className="space-y-4 text-sm">
        <div className={cn("rounded-md border px-3 py-2 text-xs", sounds.length ? "" : "border-warning/40 bg-warning/5")}>
          <span className="font-medium">Sound library: </span>
          {sounds.length ? sounds.map((s) => s.label).join(" · ") : "empty. Templates marked “trending sound” need one: drop the song below. Reference templates use their reel's own song, added in Instagram."}
          <span className="text-muted-foreground"> · No stock music: clips with live music can carry an edit on their own.</span>
          <div className="mt-2">{soundDrop}</div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {vibes.map((v) => (
            <button key={v} type="button" onClick={() => setVibe(v)} className={cn("rounded border px-2 py-0.5 text-xs capitalize", vibe === v ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>{v}</button>
          ))}
          <button type="button" onClick={() => setShowRules((x) => !x)} className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{showRules ? "Hide" : "Show"} editing rules</button>
        </div>
        {showRules && lib.data && (
          <div className="grid gap-3 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-2">
            {Object.entries(lib.data.rules).map(([k, list]) => (
              <div key={k}><div className="mb-1 font-medium capitalize">{k}</div><ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{list.map((r) => <li key={r}>{r}</li>)}</ul></div>
            ))}
          </div>
        )}

        {lib.isLoading ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading templates…</p> : (
          <div className="grid gap-2 sm:grid-cols-2">
            {templates.map((t) => {
              const on = picked.includes(t.id);
              const blocked = t.needs_sound && !sounds.length;
              return (
                <button key={t.id} type="button" onClick={() => toggle(t.id)}
                  className={cn("rounded-md border p-3 text-left transition-colors", on ? "border-primary bg-primary/5" : "hover:bg-accent/40", blocked && "opacity-60")}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{t.name}</span>
                    <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="h-3 w-3" />}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{t.trend}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge tone="primary">{t.vibe}</Badge><Badge tone={blocked ? "warning" : "outline"}>♪ {AUDIO_LABEL[t.audio]}</Badge>
                    <Badge tone="outline">{t.shots} shots · {t.pacing}</Badge><Badge tone="outline">{t.grade}</Badge>
                    {t.fx === "playful" && <Badge tone="outline">mask · squares · wipe</Badge>}
                    {t.build_drop && <Badge tone="outline">quiet → drop</Badge>}
                  </div>
                  <p className="mt-2 truncate text-[11px] italic text-muted-foreground" title={t.hooks.join("\n")}>“{t.hooks[0]}”{t.hooks.length > 1 ? ` +${t.hooks.length - 1} hooks` : ""}</p>
                </button>
              );
            })}
            {showRefs && refTemplates.map((t) => {
              const on = picked.includes(t.id);
              return (
                <button key={t.id} type="button" onClick={() => toggle(t.id)}
                  className={cn("rounded-md border p-3 text-left transition-colors", on ? "border-primary bg-primary/5" : "hover:bg-accent/40", !t.fit.ok && "opacity-60")}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{t.name} <span className="font-normal text-muted-foreground">· {t.purpose ?? "your reference"}</span></span>
                    <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="h-3 w-3" />}</span>
                  </div>
                  {t.literal && (
                    <div className="mt-2 flex gap-2">
                      {t.literal.file ? <RefPreview refId={t.literal.refId} /> : <CutStrip slots={t.literal.slots} />}
                      <div className="min-w-0 flex-1 space-y-1 text-[11px]">
                        <div className="text-muted-foreground">{t.literal.slots.length === 1 ? "one held shot" : `${t.literal.slots.length} cuts`} over {t.literal.slots.reduce((a, b) => a + b, 0).toFixed(1)}s{t.literal.lines.length ? ", its text at the same moments:" : ", no on-screen text"}</div>
                        {t.literal.lines.slice(0, 5).map((l, i) => <div key={i} className="truncate" title={l.text}>{l.t != null && <span className="text-muted-foreground">{l.t.toFixed(1)}s </span>}&ldquo;{l.text}&rdquo;</div>)}
                        <div className="flex items-center justify-between gap-1 pt-1 text-muted-foreground">
                          <span className="truncate">♪ {t.literal.song ?? (t.literal.file ? "its own sound" : "add its sound in Instagram")}</span>
                          {t.literal.url && <a href={t.literal.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 hover:text-foreground" title="Watch the original"><ExternalLink className="h-3 w-3" /></a>}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className={cn("mt-2 text-[11px]", t.fit.needs ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}
                    title={t.fit.needs ? "It still renders (shots repeat or the hold is cut short); this footage would make it match the reel" : undefined}>
                    {t.fit.needs ? `Footage: ${t.fit.note}` : t.fit.note}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {showRefs && (styles.data?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">From your references <span className="font-normal text-muted-foreground">· {styles.data!.length} styles, {distinctStyles(styles.data!).length} distinct edits{thinCount ? ` · ${thinCount} not read yet (they're being watched; each becomes an exact template above when done)` : ""}</span></span>
              <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" title="One per distinct edit, so the batch isn't the same structure many times" onClick={() => {
                const ids = distinctStyles(styles.data!).map((t) => t.id);
                setPicked((x) => (ids.every((i) => x.includes(i)) ? x.filter((i) => !ids.includes(i)) : [...new Set([...x, ...ids])]));
              }}>select distinct</button>
            </div>
            <div className="grid max-h-96 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {styles.data!.map((t) => {
                const on = picked.includes(t.id);
                return (
                  <button key={t.id} type="button" onClick={() => toggle(t.id)}
                    className={cn("rounded-md border p-2 text-left text-[11px] transition-colors", on ? "border-primary bg-primary/5" : "hover:bg-accent/40")}>
                    <div className="flex items-start justify-between gap-1">
                      <span className="line-clamp-1 font-medium" title={t.name}>{t.name}</span>
                      <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="h-2.5 w-2.5" />}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground">{baseName(t.base)}{t.look ? ` · ${t.look}` : ""}</div>
                    {t.thin && <div className="mt-1 inline-block rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400" title="Until the reel reader has watched it, this is the closest base edit with this reference's name.">not read yet</div>}
                    {t.hook && <div className="mt-1 line-clamp-2 italic">&ldquo;{t.hook}&rdquo;</div>}
                    {t.notes && !t.hook && <div className="mt-1 line-clamp-2 text-muted-foreground">{t.notes}</div>}
                    <div className="mt-1 flex items-center justify-between text-muted-foreground">
                      <span className="truncate">♪ {t.song ?? "add its song in the reference"}</span>
                      {t.url && <a href={t.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 hover:text-foreground"><ExternalLink className="h-3 w-3" /></a>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><FlaskConical className="h-3 w-3" />Test set per template</label>
            <div className="flex gap-1">
              {TEST_SETS.map((t) => (
                <button key={t.n} type="button" title={t.note} onClick={() => setPerTemplate(t.n)}
                  className={cn("rounded border px-2 py-0.5 text-xs", perTemplate === t.n ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>{t.label}</button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{TEST_SETS.find((t) => t.n === perTemplate)?.note}. Every version is tagged with what changed.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Place (optional, used only where a hook names it)</label>
            <Input placeholder="e.g. Vienna" value={place} onChange={(e) => setPlace(e.target.value)} />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Hook (optional) · empty: each template uses its own trend hooks and your best-ranked ones</label>
          <div className="flex gap-2">
            <Input placeholder="e.g. Some places you hear before you see." value={hook} onChange={(e) => setHook(e.target.value)} />
            <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />save it</label>
          </div>
          {saved.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {saved.map((h) => (
                <span key={h.id} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]">
                  <button type="button" onClick={() => setHook(h.text)} className="hover:text-primary">{h.text}</button>
                  <button type="button" onClick={() => markWorks.mutate(h)} title={h.status === "winner" ? "Marked as working" : "Mark as a hook that works"}>
                    <Star className={cn("h-3 w-3", h.status === "winner" ? "fill-warning text-warning" : "text-muted-foreground")} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-xs text-muted-foreground">{clipIds.length} clips · {picked.length} template{picked.length === 1 ? "" : "s"} → about {videos} video{videos === 1 ? "" : "s"}</span>
          <Button disabled={make.isPending || !clipIds.length || !picked.length} onClick={() => make.mutate()}>
            {make.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}Make {videos || ""} video{videos === 1 ? "" : "s"}
          </Button>
        </div>
        {make.error && <p className="text-xs text-destructive">{(make.error as Error).message}</p>}

      </CardBody>
    </Card>
  );
}
