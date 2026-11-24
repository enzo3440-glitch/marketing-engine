"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReelClip } from "@engine/db/types";
import { Loader2, Paperclip, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Select } from "@/components/ui";
import { cn } from "@/lib/utils";

type Kind = "auto" | "ad" | "reel" | "carousel";
interface Creation {
  id: string; ask: string; kind: Kind; at: number; status: "thinking" | "rendering" | "done" | "error";
  plan?: string; needs?: string[]; note?: string; job_id?: string; error?: string; made?: number;
}

const KINDS: { k: Kind; label: string }[] = [{ k: "auto", label: "Auto" }, { k: "ad", label: "Ad" }, { k: "reel", label: "Reel" }, { k: "carousel", label: "Carousel" }];
const STATUS: Record<Creation["status"], string> = { thinking: "Claude is writing it…", rendering: "Rendering…", done: "Done", error: "Failed" };

/**
 * Say what you want made. Claude writes it from what we know (knowledge, references, templates, your clips, the
 * library and our phone) and the engine renders it as a new batch (lib/reel-create.ts).
 */
export function CreateBox({ checked, stub, onOpen }: { checked: string[]; stub: boolean; onOpen: (jobId: string) => void }) {
  const qc = useQueryClient();
  const [ask, setAsk] = useState("");
  const [kind, setKind] = useState<Kind>("auto");
  const [count, setCount] = useState(1);
  const [useChecked, setUseChecked] = useState(false);
  const [attached, setAttached] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ["creations"], queryFn: () => api<Creation[]>("/api/reels/create"),
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === "thinking" || c.status === "rendering") ? 3000 : false),
  });
  const send = useMutation({
    mutationFn: () => api<Creation>("/api/reels/create", { method: "POST", json: { ask, kind, count, clipIds: useChecked ? checked : [], attached: attached.map((a) => a.id) } }),
    onSuccess: () => { setAsk(""); setAttached([]); setErr(null); qc.invalidateQueries({ queryKey: ["creations"] }); },
    onError: (e) => setErr((e as Error).message),
  });
  // a batch that just started rendering shows up in Jobs, and its videos once it's done
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const c of list.data ?? []) {
      if (!c.job_id || seen.current.has(`${c.job_id}:${c.status}`)) continue;
      seen.current.add(`${c.job_id}:${c.status}`);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      if (c.status === "done") qc.invalidateQueries({ queryKey: ["job", c.job_id] });
    }
  }, [list.data, qc]);

  async function attach(files: FileList) {
    setErr(null);
    for (const f of Array.from(files)) {
      setUploading((u) => [...u, f.name]);
      try {
        const c = await api<ReelClip>(`/api/reels/clips?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream" } });
        setAttached((a) => [...a, { id: c.id, name: f.name }]);
      } catch (e) {
        setErr(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((u) => u.filter((x) => x !== f.name));
      }
    }
    qc.invalidateQueries({ queryKey: ["clips"] });
  }

  const ready = ask.trim().length >= 4 && !uploading.length && !send.isPending && !stub;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />Make something</span>}
        description="Say what you want: an ad, a reel or a carousel. Claude writes it from what we've learned, your references and templates, your clips and the library, with our phone for app moments, and the engine renders it as a new batch." />
      <CardBody className="space-y-2">
        <textarea value={ask} onChange={(e) => setAsk(e.target.value)} rows={3}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) send.mutate(); }}
          placeholder={"e.g. An ad about the problem the product solves, using the newest footage.\nA 5-slide carousel: 3 tips for your audience.\nA reel of my weekend clips on the best trend template."}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex gap-1">
            {KINDS.map(({ k, label }) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={cn("rounded border px-2 py-0.5", kind === k ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>{label}</button>
            ))}
          </div>
          <Select value={String(count)} onChange={(e) => setCount(Number(e.target.value))} className="h-7 w-auto text-xs" aria-label="How many">
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} {n > 1 ? "pieces" : "piece"}</option>)}
          </Select>
          <label className="flex items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={useChecked} onChange={(e) => setUseChecked(e.target.checked)} />
            build from my {checked.length} checked clips
          </label>
          <button type="button" onClick={() => input.current?.click()} className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-muted-foreground hover:text-foreground">
            <Paperclip className="h-3 w-3" />Attach videos
          </button>
          <input ref={input} type="file" accept="video/*" multiple className="hidden" onChange={(e) => { if (e.target.files) attach(e.target.files); e.target.value = ""; }} />
          {attached.map((a) => (
            <Badge key={a.id} tone="outline" className="gap-1">{a.name}
              <button type="button" onClick={() => setAttached((x) => x.filter((y) => y.id !== a.id))} aria-label={`Remove ${a.name}`}><X className="h-3 w-3" /></button>
            </Badge>
          ))}
          {uploading.map((n) => <Badge key={n} tone="outline"><Loader2 className="mr-1 h-3 w-3 animate-spin" />{n}</Badge>)}
          <Button size="sm" className="ml-auto" disabled={!ready} onClick={() => send.mutate()}>
            {send.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Make it
          </Button>
        </div>
        {stub && <div className="text-xs text-warning">Needs the engine running.</div>}
        {err && <div className="text-xs text-destructive">{err}</div>}
        {(list.data ?? []).length > 0 && (
          <div className="divide-y rounded-md border text-xs">
            {list.data!.map((c) => (
              <div key={c.id} className="space-y-1 p-2">
                <div className="flex items-start gap-2">
                  <Badge tone={c.status === "error" ? "danger" : c.status === "done" ? "success" : "outline"}>
                    {(c.status === "thinking" || c.status === "rendering") && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{STATUS[c.status]}
                  </Badge>
                  <span className="flex-1 font-medium">{c.ask}</span>
                  {c.job_id && <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => onOpen(c.job_id!)}>Open batch</Button>}
                </div>
                {c.plan && <div className="text-muted-foreground">{c.plan}{c.made ? ` (${c.made} in the batch)` : ""}</div>}
                {c.needs && c.needs.length > 0 && <div className="text-muted-foreground"><span className="font-medium text-foreground">Would be better with:</span> {c.needs.join(" · ")}</div>}
                {c.note && <div className="text-warning">{c.note}</div>}
                {c.error && <div className="text-destructive">{c.error}</div>}
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
