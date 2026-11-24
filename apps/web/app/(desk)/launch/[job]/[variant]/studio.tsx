"use client";
import { ArrowLeft, Loader2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Textarea } from "@/components/ui";
import type { ReadyVideo } from "@/lib/launch";

type Version = ReadyVideo & { ask: string | null; summary: string | null };
type Change = { status: "working" | "thinking" | "rendering" | "done" | "error"; ask: string; summary?: string; error?: string; job_id?: string; id?: string } | null;

const fileUrl = (job: string, n: string | null) => (n ? `/api/reels/files/${encodeURIComponent(job)}/${encodeURIComponent(n)}` : undefined);
const href = (v: { job_id: string; variant_id: string }) => `/launch/${encodeURIComponent(v.job_id)}/${encodeURIComponent(v.variant_id)}`;
// the changes asked for most; one tap fills the box, then edit it before sending
const QUICK = [
  "Use fewer shots of the person, more of the places",
  "Hold the app screen longer so it can be read",
  "Make the music softer and calmer",
  "Make the opening line land faster",
  "Make the on-screen text bigger and easier to read",
  "Make it shorter, about 12 seconds",
];
const working = (c: Change) => !!c && (c.status === "working" || c.status === "thinking" || c.status === "rendering");

export function VideoStudio({ video: v, versions }: { video: ReadyVideo; versions: Version[] }) {
  const router = useRouter();
  const [ask, setAsk] = useState("");
  const [change, setChange] = useState<Change>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = `job_id=${encodeURIComponent(v.job_id)}&variant_id=${encodeURIComponent(v.variant_id)}`;

  useEffect(() => { api<Change>(`/api/launch/tweak?${q}`).then(setChange).catch(() => null); }, [q]);
  // while a change is being made, check every few seconds; when it lands, show the new version
  useEffect(() => {
    if (!working(change)) return;
    const t = setInterval(async () => {
      const c = await api<Change>(`/api/launch/tweak?${q}`).catch(() => null);
      setChange(c);
      if (c?.status === "done") router.refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [change, q, router]);

  async function send() {
    setErr(null);
    try {
      setChange(await api<Change>("/api/launch/tweak", { method: "POST", json: { job_id: v.job_id, variant_id: v.variant_id, ask } }));
      setAsk("");
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      <Link href="/launch" className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" />Launch</Link>
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <div className="mx-auto w-full max-w-[min(100%,calc(78vh*9/16))]">
          <video key={`${v.job_id}/${v.variant_id}`} src={fileUrl(v.job_id, v.file)} poster={fileUrl(v.job_id, v.poster)} controls autoPlay playsInline
            className="w-full rounded-lg bg-black" style={{ aspectRatio: "9 / 16", maxHeight: "78vh" }} />
        </div>
        <div className="min-w-0 space-y-3">
          <div>
            <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
              <span>{v.made_by}</span>{v.duration != null && <span>· {Math.round(v.duration)}s</span>}
              {v.launched && <Badge tone={v.launch_status === "failed" ? "danger" : "success"}>{v.launched} · {v.launch_status}</Badge>}
            </div>
            <h1 className="mt-0.5 text-lg font-semibold leading-snug">{v.title}</h1>
          </div>

          <Card>
            <CardHeader title="Tweak it" description="Say what to change. The new cut comes back next to this one, which stays as it is." />
            <CardBody className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {QUICK.map((x) => (
                  <button key={x} onClick={() => setAsk((a) => (a ? `${a}. ${x}` : x))} className="rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent">{x}</button>
                ))}
              </div>
              <Textarea rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. Swap the second line for 'Some places you can't search for.' and end on the bar for longer" className="text-sm" />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={send} disabled={ask.trim().length < 3 || working(change)}><Wand2 className="h-3.5 w-3.5" />Make the change</Button>
                {working(change) && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Working on “{change!.ask}” (a few minutes)</span>}
              </div>
              {change?.status === "done" && <p className="text-xs text-primary">Done: {change.summary || "the new version is below."}</p>}
              {change?.status === "error" && <p className="text-xs text-destructive">{change.error}</p>}
              {err && <p className="text-xs text-destructive">{err}</p>}
            </CardBody>
          </Card>

          {versions.length > 1 && (
            <Card>
              <CardHeader title={`Versions · ${versions.length}`} description="Open one to watch it big; launch the one you like from Launch." />
              <CardBody className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                {versions.map((x, i) => {
                  const here = x.job_id === v.job_id && x.variant_id === v.variant_id;
                  return (
                    <Link key={`${x.job_id}/${x.variant_id}`} href={href(x)} title={x.summary ?? x.ask ?? "Original"} className={`block overflow-hidden rounded border ${here ? "border-primary ring-1 ring-primary" : "hover:border-foreground/40"}`}>
                      {x.poster && <img src={fileUrl(x.job_id, x.poster)} alt="" className="w-full object-cover" style={{ aspectRatio: "9 / 16" }} loading="lazy" />}
                      <div className="truncate px-1.5 py-1 text-[10px]">{i === 0 ? "Original" : `v${i + 1}: ${x.summary || x.ask || ""}`}</div>
                    </Link>
                  );
                })}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Script" />
            <CardBody>
              {v.script.length ? <ol className="list-decimal space-y-0.5 pl-4 text-sm">{v.script.map((l, i) => <li key={i}>{l}</li>)}</ol>
                : <p className="text-xs text-muted-foreground">No script saved for this one.</p>}
              {v.caption && <><div className="label mt-3">Caption</div><p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{v.caption}</p></>}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
