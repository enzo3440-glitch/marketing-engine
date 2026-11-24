"use client";
import { Check, ExternalLink, FlaskConical, Megaphone, Play, Rocket, Search, Trash2, Upload, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, Empty, Input, Textarea } from "@/components/ui";
import type { CampaignChoice, ReadyVideo } from "@/lib/launch";

type Dest = "post" | "trial" | "ad";
type Money = { free: number | null; committed: number; currency: string } | null;
const DESTS: { key: Dest; label: string; sub: string }[] = [
  { key: "trial", label: "Trial reel", sub: "Free · non-followers only · off your grid" },
  { key: "post", label: "Post", sub: "To your grid and followers" },
  { key: "ad", label: "Ad", sub: "Ads-only, to the App Store, with a budget" },
];
const fileUrl = (job: string, n: string | null) => (n ? `/api/reels/files/${encodeURIComponent(job)}/${encodeURIComponent(n)}` : undefined);
const key = (v: ReadyVideo) => `${v.job_id}|${v.variant_id}`;
const STREAMS = [
  { key: "ig" as const, title: "Instagram", sub: "Trial reels and posts: analog, real, not an ad. As many as Instagram allows.", empty: "Nothing waiting. The autopilot makes the day's reels, or upload one above." },
  { key: "ad" as const, title: "Ads", sub: "Meta campaigns: the commercial driver, app on screen, built for installs.", empty: "No ads waiting. Make one on Make." },
];
const pct = (x: number | null) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
type Member = { id: string; title: string; as: "ad" | "trial"; status: string };
type Choices = { open: CampaignChoice[]; member: Record<string, Member[]> };
// A–Z ignores leading quotes and punctuation, so a title that starts with a quote mark sorts under its first letter
const sortKey = (v: ReadyVideo) => v.title.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();

export function Launcher({ videos, money, cap, choices }: { videos: ReadyVideo[]; money: Money; cap: number; choices: Choices }) {
  const router = useRouter();
  const [show, setShow] = useState<"ready" | "launched">("ready");
  const [inTest, setInTest] = useState<Set<string>>(new Set());
  const [testName, setTestName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = useMemo(() => videos.filter((v) => !v.launched || v.launch_status === "failed"), [videos]);
  const launched = useMemo(() => videos.filter((v) => v.launched && v.launch_status !== "failed"), [videos]);
  const [sort, setSort] = useState<"newest" | "az" | "best">("newest");
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (v: ReadyVideo) => { const t = `${v.title} ${v.script.join(" ")} ${v.caption}`.toLowerCase(); return words.every((w) => t.includes(w)); };
    const xs = (show === "ready" ? ready : launched).filter(hit);
    const score = (v: ReadyVideo) => (v.results?.act ?? -1) * 10 + (v.results?.watch ?? 0);
    if (sort === "best") return [...xs].sort((a, b) => score(b) - score(a) || b.made_at.localeCompare(a.made_at));
    return sort === "az" ? [...xs].sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || b.made_at.localeCompare(a.made_at)) : xs;
  }, [show, ready, launched, q, sort]);

  async function startTest() {
    setBusy(true); setMsg(null);
    try {
      const picks = ready.filter((v) => inTest.has(key(v))).map((v) => ({ job_id: v.job_id, variant_id: v.variant_id, caption: v.caption, content_id: v.idea?.startsWith("map:") ? null : v.idea }));
      const r = await api<{ detail: string }>("/api/launch", { method: "POST", json: { action: "test", name: testName, picks } });
      setMsg(r.detail); setInTest(new Set()); router.refresh();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["ready", "launched"] as const).map((k) => (
          <button key={k} onClick={() => setShow(k)} className={`rounded-sm border px-2.5 py-1 text-xs ${show === k ? "border-primary bg-primary/10" : "text-muted-foreground hover:text-foreground"}`}>
            {k === "ready" ? `Ready · ${ready.length}` : `Launched · ${launched.length}`}
          </button>
        ))}
        <div className="flex overflow-hidden rounded-sm border text-xs">
          {(["newest", "az", "best"] as const).map((k) => (
            <button key={k} onClick={() => setSort(k)} className={`px-2.5 py-1 ${sort === k ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{k === "newest" ? "Newest" : k === "az" ? "A–Z" : "Best results"}</button>
          ))}
        </div>
        <label className="flex items-center gap-1 rounded-sm border px-2 text-xs text-muted-foreground"><Search className="h-3 w-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a video (line, place…)" className="h-7 w-48 bg-transparent text-foreground outline-none" />
        </label>
        {money?.free != null && <span className="ml-auto text-xs text-muted-foreground">Ad funds free: <span className="num font-mono text-foreground">{Math.floor(money.free)} {money.currency}</span> · committed {Math.round(money.committed)}</span>}
      </div>
      <UploadCard />
      {inTest.size > 0 && (
        <Card className="mb-3 border-primary/50">
          <CardBody className="flex flex-wrap items-center gap-2 py-2.5">
            <FlaskConical className="h-4 w-4 text-primary" />
            <span className="text-xs">{inTest.size} video{inTest.size > 1 ? "s" : ""} in the test</span>
            <Input value={testName} onChange={(e) => setTestName(e.target.value)} placeholder="Test name, e.g. FOMO hooks" className="h-8 w-56 text-xs" />
            <Button size="sm" onClick={startTest} disabled={busy || inTest.size < 2}><Check className="h-3.5 w-3.5" />{inTest.size < 2 ? "Pick at least 2" : `Approve test · post ${inTest.size} trial reels`}</Button>
            <button onClick={() => setInTest(new Set())} className="text-[11px] text-muted-foreground hover:text-foreground">clear</button>
          </CardBody>
        </Card>
      )}
      {msg && <p className="mb-2 text-xs text-primary">{msg}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {STREAMS.map((st) => {
          const col = list.filter((v) => v.stream === st.key);
          return (
            <section key={st.key} className="min-w-0">
              <div className="mb-2 flex items-baseline gap-2 border-b pb-1.5">
                <h2 className="text-sm font-semibold">{st.title}</h2>
                <span className="text-xs text-muted-foreground">{col.length}</span>
                <span className="ml-auto truncate text-[11px] text-muted-foreground" title={st.sub}>{st.sub}</span>
              </div>
              {!col.length ? <Empty>{q ? "No video matches that." : show === "ready" ? st.empty : "Nothing launched here yet."}</Empty> : (
                <div className="grid gap-2.5">
                  {col.map((v) => <VideoCard key={key(v)} v={v} money={money} cap={cap} inTest={inTest.has(key(v))} open={choices.open} member={choices.member[key(v)] ?? []}
                    toggleTest={() => setInTest((s) => { const n = new Set(s); if (n.has(key(v))) n.delete(key(v)); else n.add(key(v)); return n; })} />)}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function VideoCard({ v, money, cap, inTest, toggleTest, open, member }: { v: ReadyVideo; money: Money; cap: number; inTest: boolean; toggleTest: () => void; open: CampaignChoice[]; member: Member[] }) {
  const router = useRouter();
  const page = `/launch/${encodeURIComponent(v.job_id)}/${encodeURIComponent(v.variant_id)}`;
  const [dest, setDest] = useState<Dest>(v.stream === "ad" ? "ad" : "trial");

  async function move() {
    setBusy(true); setMsg(null);
    try { await api("/api/launch", { method: "POST", json: { action: "stream", job_id: v.job_id, variant_id: v.variant_id, stream: v.stream === "ad" ? "ig" : "ad" } }); router.refresh(); }
    catch (e) { setMsg((e as Error).message); setBusy(false); }
  }
  const [caption, setCaption] = useState(v.caption);
  const [budget, setBudget] = useState(10);
  const [days, setDays] = useState(5);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const done = !!v.launched && v.launch_status !== "failed";
  const total = budget * days;
  const over = dest === "ad" && (budget > cap || (money?.free != null && total > money.free));

  const [playing, setPlaying] = useState(false);
  async function remove() {
    // every delete is a taste note: what's wrong with it (optional) goes to the editor's knowledge
    const why = window.prompt(`Delete "${v.title}"? It comes off Launch and its files are deleted (can't be undone).\nWhat's wrong with it? (optional; the editor learns from it)`, "");
    if (why === null) return;
    setBusy(true); setMsg(null);
    try {
      await api("/api/launch", { method: "POST", json: { action: "delete", job_id: v.job_id, variant_id: v.variant_id, why } });
      router.refresh();
    } catch (e) { setMsg((e as Error).message); setBusy(false); }
  }

  async function assign(campaign_id: string, as: "ad" | "trial" | "none") {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ detail: string }>("/api/launch", { method: "POST", json: { action: "assign", job_id: v.job_id, variant_id: v.variant_id, campaign_id, as } });
      setMsg(r.detail); router.refresh();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  async function approve() {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ detail: string }>("/api/launch", { method: "POST", json: { action: "launch", job_id: v.job_id, variant_id: v.variant_id, dest, caption, daily_budget: budget, days } });
      setMsg(r.detail); router.refresh();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Card className={inTest ? "border-primary/60" : ""}>
      <div className="flex gap-3 p-3">
        <div className="relative w-32 shrink-0 overflow-hidden rounded bg-muted" style={{ aspectRatio: "9 / 16" }}>
          {playing ? (
            // plays right here (founder, Nov 15: watch and delete junk without opening each one)
            <video src={fileUrl(v.job_id, v.file)} poster={v.poster ? fileUrl(v.job_id, v.poster) : undefined} controls autoPlay playsInline className="h-full w-full bg-black object-contain" />
          ) : (
            <button onClick={() => setPlaying(true)} className="group block h-full w-full" aria-label="Play here">
              {v.poster && <img src={fileUrl(v.job_id, v.poster)} alt="" className="h-full w-full object-cover" loading="lazy" />}
              <Play className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 fill-white/90 text-white/90 drop-shadow group-hover:scale-110" />
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="uppercase">{v.made_by}</span>
            {v.duration != null && <span>· {Math.round(v.duration)}s</span>}
            {v.launched && <Badge tone={v.launch_status === "failed" ? "danger" : v.launch_status === "live" ? "success" : "warning"} className="ml-auto">{v.launched} · {v.launch_status}</Badge>}
            {!done && <button onClick={remove} disabled={busy} title="Delete this video everywhere" aria-label="Delete this video" className={`${v.launched ? "" : "ml-auto "}rounded p-0.5 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50`}><Trash2 className="h-3.5 w-3.5" /></button>}
          </div>
          <Link href={page} className="mt-0.5 line-clamp-2 text-[13px] font-medium leading-snug hover:underline">{v.title}</Link>
          <Link href={page} className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"><Wand2 className="h-3 w-3" />Watch big &amp; tweak</Link>
          <div className="label mt-2">Script</div>
          {v.script.length ? (
            <ol className="mt-0.5 max-h-28 list-decimal space-y-0.5 overflow-y-auto pl-4 text-[11px] text-muted-foreground">{v.script.map((l, i) => <li key={i}>{l}</li>)}</ol>
          ) : <p className="text-[11px] text-muted-foreground">No script saved for this one.</p>}
          {v.results && (
            <div className="mt-1.5 rounded-sm border px-1.5 py-1 text-[10px] text-muted-foreground" title={v.results.why ?? undefined}>
              <span className="text-foreground">{v.results.reach ?? "–"}</span> reach · watched <span className="text-foreground">{pct(v.results.watch)}</span> · saved/shared <span className="text-foreground">{pct(v.results.act)}</span>
              {v.results.verdict && <Badge tone={v.results.verdict === "winner" ? "success" : v.results.verdict === "hold" ? "default" : "warning"} className="ml-1">{v.results.verdict === "hook" ? "weak opening" : v.results.verdict === "payoff" ? "weak payoff" : v.results.verdict}</Badge>}
            </div>
          )}
          {!done && <button onClick={move} disabled={busy} className="mt-1 text-[10px] text-muted-foreground hover:text-foreground">move to {v.stream === "ad" ? "Instagram" : "Ads"} →</button>}
          {member.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {member.map((m) => (
                <span key={m.id + m.as} className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px]" title={`Campaign is ${m.status.replace("_", " ")}`}>
                  <Megaphone className="h-3 w-3" />{m.title} · {m.as}
                  {["planned", "rejected"].includes(m.status) && <button onClick={() => assign(m.id, "none")} disabled={busy} className="text-muted-foreground hover:text-destructive" aria-label={`Take out of ${m.title}`}>×</button>}
                </span>
              ))}
            </div>
          )}
          {v.permalink && <a href={v.permalink} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">open on Instagram <ExternalLink className="h-3 w-3" /></a>}
          {v.launch_error && <p className="mt-1 text-[11px] text-destructive">{v.launch_error}</p>}
        </div>
      </div>
      {!done && (
        <CardBody className="space-y-2 border-t pt-2.5">
          <Textarea rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} className="text-xs" />
          <div className="grid grid-cols-3 gap-1">
            {DESTS.map((d) => (
              <button key={d.key} onClick={() => setDest(d.key)} title={d.sub} className={`rounded border px-1.5 py-1 text-left text-xs ${dest === d.key ? "border-primary bg-primary/10" : "hover:bg-accent"}`}>
                <div className="font-medium">{d.label}</div><div className="truncate text-[10px] text-muted-foreground">{d.sub}</div>
              </button>
            ))}
          </div>
          {dest === "ad" && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1">Daily <Input type="number" min={1} max={cap} value={budget} onChange={(e) => setBudget(Number(e.target.value))} className="h-7 w-16 text-xs" /></label>
              <label className="flex items-center gap-1">Days <Input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-7 w-14 text-xs" /></label>
              <span className={over ? "text-destructive" : "text-muted-foreground"}>up to {total} {money?.currency ?? ""}{money?.free != null ? ` of ${Math.floor(money.free)} free` : ""}{budget > cap ? ` · cap ${cap}/day` : ""}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={approve} disabled={busy || over}><Rocket className="h-3.5 w-3.5" />{busy ? "Working…" : `Approve as ${DESTS.find((d) => d.key === dest)!.label.toLowerCase()}`}</Button>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={inTest} onChange={toggleTest} />add to a test instead</label>
          </div>
          {open.length > 0 && (
            <select value="" disabled={busy} onChange={(e) => { const [id, as] = e.target.value.split("|"); if (id) void assign(id, as as "ad" | "trial"); }}
              className="h-7 w-full rounded-sm border bg-background px-1.5 text-[11px] text-muted-foreground">
              <option value="">Add to a campaign…</option>
              {open.map((c) => (
                <optgroup key={c.id} label={c.title}>
                  <option value={`${c.id}|ad`}>{c.title} · as an ad</option>
                  <option value={`${c.id}|trial`}>{c.title} · as a trial reel</option>
                </optgroup>
              ))}
            </select>
          )}
          {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
        </CardBody>
      )}
    </Card>
  );
}

/** A finished video made outside the desk (CapCut, your phone, an editor): it lands on Launch like anything made here. */
function UploadCard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const f = new FormData();
      f.append("video", file);
      // the first script line is the video's name on Launch
      f.append("script", [title.trim() || file.name.replace(/\.[^.]+$/, ""), script.trim()].filter(Boolean).join("\n"));
      f.append("caption", caption);
      const r = await fetch("/api/make/import", { method: "POST", body: f });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Upload failed (${r.status})`);
      setMsg("Uploaded: it's on Launch now."); setFile(null); setTitle(""); setScript(""); setCaption(""); setOpen(false); router.refresh();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  if (!open) return (
    <div className="mb-3 flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Upload className="h-3.5 w-3.5" />Upload a finished video</Button>
      {msg && <span className="text-xs text-primary">{msg}</span>}
    </div>
  );
  return (
    <Card className="mb-3">
      <CardBody className="space-y-2 py-2.5">
        <div className="flex items-center gap-2 text-xs font-medium"><Upload className="h-3.5 w-3.5" />Upload a finished video <span className="font-normal text-muted-foreground">· .mp4 or .mov, up to 500 MB, vertical 9:16 for reels and ads</span></div>
        <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, "")); }} className="block text-xs" />
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Its name on Launch: the opening line works best" className="h-8 text-xs" />
        <Textarea rows={2} value={script} onChange={(e) => setScript(e.target.value)} placeholder="The other on-screen lines, one per line (optional)" className="text-xs" />
        <Textarea rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption (optional, you can change it when you launch)" className="text-xs" />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={upload} disabled={busy || !file}><Upload className="h-3.5 w-3.5" />{busy ? "Uploading…" : "Add to Launch"}</Button>
          <button onClick={() => setOpen(false)} className="text-[11px] text-muted-foreground hover:text-foreground">cancel</button>
          {msg && <span className="text-[11px] text-destructive">{msg}</span>}
        </div>
      </CardBody>
    </Card>
  );
}
