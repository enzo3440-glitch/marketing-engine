"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, Square } from "lucide-react";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Input, statusTone } from "@/components/ui";
import { cn } from "@/lib/utils";

interface Story { id: string; title: string; clips: number; status: string; kept?: number; score?: number; night?: boolean; jobs?: string[] }
interface RunState {
  status: string; run_id?: string; videos?: number; started?: number; finished?: number; error?: string;
  cfg?: { folder: string; budget_minutes: number; max_videos: number; styles?: { label?: string }[] };
  stories?: Story[]; log?: string[]; defaultFolder?: string;
}

/** Overnight runs: a footage folder -> one hook test per trip story, until the time budget or cap. */
export function Autopilot({ stub }: { stub: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["autopilot"], queryFn: () => api<RunState>("/api/reels/autopilot"),
    refetchInterval: (x) => (["scanning", "rendering", "starting"].includes(x.state.data?.status ?? "") ? 5000 : false),
  });
  const [folder, setFolder] = useState("");
  const [hours, setHours] = useState(8);
  const [maxVideos, setMaxVideos] = useState(60);
  const start = useMutation({
    mutationFn: () => api("/api/reels/autopilot", { method: "POST", json: { folder: folder || q.data?.defaultFolder, hours, maxVideos } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopilot"] }),
  });
  const stop = useMutation({
    mutationFn: () => api("/api/reels/autopilot", { method: "POST", json: { action: "stop" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autopilot"] }),
  });
  const s = q.data;
  const running = ["scanning", "rendering", "starting"].includes(s?.status ?? "");
  const done = s?.stories?.filter((x) => x.status.startsWith("done")).length ?? 0;
  const eta = s?.started && s.cfg ? new Date((s.started + s.cfg.budget_minutes * 60) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Moon className="h-4 w-4" />Autopilot</span>}
        description="Point it at a footage folder and let it run overnight. It groups clips into trips by GPS + date, drops weak and duplicate shots, and renders one hook test per trip, styled after your references and using the best-evidence hooks. Results land in Jobs below; nothing posts."
        action={s && <Badge tone={statusTone(running ? "running" : s.status === "finished" ? "done" : s.status)}>{s.status}</Badge>}
      />
      <CardBody className="space-y-3 text-sm">
        {stub ? (
          <p className="text-xs text-warning">Autopilot runs on the Reel Engine. Start it (services/reel-engine/run-local.cmd) and set VIDEO_ENGINE_URL.</p>
        ) : !running ? (
          <div className="grid gap-2 md:grid-cols-[1fr_110px_120px_auto]">
            <Input placeholder={s?.defaultFolder || "Footage folder (must be under AUTOPILOT_ROOTS)"} value={folder} onChange={(e) => setFolder(e.target.value)} />
            <label className="flex items-center gap-1 text-xs text-muted-foreground"><Input type="number" min={0.1} max={14} step={0.5} value={hours} onChange={(e) => setHours(Number(e.target.value))} />h</label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground"><Input type="number" min={1} max={400} value={maxVideos} onChange={(e) => setMaxVideos(Number(e.target.value))} />max</label>
            <Button onClick={() => start.mutate()} disabled={start.isPending}><Moon className="h-4 w-4" />Start</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
            <span>{s?.videos ?? 0} videos · {done}/{s?.stories?.length ?? 0} trips · runs until {eta} or {s?.cfg?.max_videos} videos</span>
            <Button size="sm" variant="outline" onClick={() => stop.mutate()}><Square className="h-3.5 w-3.5" />Stop after current</Button>
          </div>
        )}
        {(start.error || s?.error) && <p className="text-xs text-destructive">{(start.error as Error)?.message ?? s?.error}</p>}
        {s?.cfg?.styles && <p className="text-[11px] text-muted-foreground">Styles: {s.cfg.styles.map((x) => x.label).join(" → ")}</p>}
        {!!s?.stories?.length && (
          <div className="max-h-64 overflow-y-auto rounded-md border">
            {s.stories.map((st) => (
              <div key={st.id} className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs last:border-0">
                <span className="truncate">{st.title} <span className="text-muted-foreground">· {st.kept ?? st.clips} clips{st.night ? " · night" : ""}</span></span>
                <span className={cn("shrink-0", st.status.startsWith("done") ? "text-success" : st.status.startsWith("render") || st.status.startsWith("analys") ? "text-warning" : "text-muted-foreground")}>{st.status}</span>
              </div>
            ))}
          </div>
        )}
        {!!s?.log?.length && <pre className="max-h-24 overflow-y-auto rounded bg-muted/40 p-2 text-[10px] leading-snug text-muted-foreground">{s.log.slice(-6).join("\n")}</pre>}
      </CardBody>
    </Card>
  );
}
