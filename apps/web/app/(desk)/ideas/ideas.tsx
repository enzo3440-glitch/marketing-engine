"use client";
import { Archive, ArchiveRestore, Film, ListOrdered, Plus, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, Empty, Input, Select } from "@/components/ui";
import type { Idea, IdeaSource, Where } from "@/lib/ideas";

const SOURCES: { key: IdeaSource | "all"; label: string }[] = [
  { key: "all", label: "All" }, { key: "slate", label: "Slate" }, { key: "generated", label: "Generated" },
  { key: "yours", label: "Yours" }, { key: "plan", label: "Plan" }, { key: "map", label: "Map" },
];
const TIERS = ["all", "entertain", "educate", "sell"] as const;
const TIER_TONE: Record<string, string> = { entertain: "text-info", educate: "text-success", sell: "text-warning" };
const WHERE: { key: Where; label: string; cls: string }[] = [
  { key: "ads", label: "Ads", cls: "border-warning/50 text-warning" },
  { key: "ig", label: "IG", cls: "border-[#d62976]/50 text-[#d62976]" },
  { key: "tiktok", label: "TikTok", cls: "border-info/50 text-info" },
];
export function WhereMarks({ where }: { where: Where[] }) {
  return <>{WHERE.filter((w) => where.includes(w.key)).map((w) => <span key={w.key} className={`rounded-sm border px-1 text-[9px] font-medium uppercase ${w.cls}`}>{w.label}</span>)}</>;
}

export function IdeasBoard({ initial, rankedAt }: { initial: Idea[]; rankedAt: string | null }) {
  const [ideas, setIdeas] = useState(initial);
  const [where, setWhere] = useState<Where | "all">("all");
  const [showDups, setShowDups] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [ranked, setRanked] = useState(rankedAt);
  const [source, setSource] = useState<(typeof SOURCES)[number]["key"]>("all");
  const [tier, setTier] = useState<(typeof TIERS)[number]>("all");
  const [q, setQ] = useState("");
  const [title, setTitle] = useState("");
  const [hook, setHook] = useState("");
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<"add" | "gen" | "rank" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const live = useMemo(() => ideas.filter((i) => (showDups || !i.dupOf) && i.archived === showArchived), [ideas, showDups, showArchived]);
  const shown = useMemo(() => live.filter((i) => (source === "all" || i.source === source) && (tier === "all" || i.tier === tier)
    && (where === "all" || i.where.includes(where)) && (!q || `${i.title} ${i.hook}`.toLowerCase().includes(q.toLowerCase()))), [live, source, tier, where, q]);
  const count = (k: string) => (k === "all" ? live.length : live.filter((i) => i.source === k).length);
  const dupCount = ideas.filter((i) => i.dupOf).length;
  const archivedCount = ideas.filter((i) => i.archived).length;
  const titleOf = (id: string | null) => ideas.find((i) => i.id === id)?.title ?? id;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy("add"); setErr(null);
    try {
      const i = await api<Idea>("/api/ideas", { method: "POST", json: { action: "add", title, hook } });
      setIdeas((xs) => [i, ...xs]); setTitle(""); setHook("");
    } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }
  async function generate() {
    setBusy("gen"); setErr(null);
    try {
      const made = await api<Idea[]>("/api/ideas", { method: "POST", json: { action: "generate", focus, count: 5 } });
      setIdeas((xs) => [...made, ...xs]); setSource("generated");
    } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }

  async function act(i: Idea, action: "archive" | "unarchive" | "delete") {
    if (action === "delete" && !window.confirm(`Delete "${i.title}"? The desk remembers it as an idea you didn't like.`)) return;
    setErr(null);
    try {
      await api("/api/ideas", { method: "POST", json: { action, id: i.id } });
      setIdeas((xs) => action === "delete" ? xs.filter((x) => x.id !== i.id) : xs.map((x) => x.id === i.id ? { ...x, archived: action === "archive" } : x));
    } catch (x) { setErr((x as Error).message); }
  }

  async function rerank() {
    setBusy("rank"); setErr(null);
    try {
      const r = await api<{ ideas: Idea[] }>("/api/ideas", { method: "POST", json: { action: "rerank" } });
      setIdeas(r.ideas); setRanked(new Date().toISOString());
    } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }

  return (
    <>
      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <Card><CardBody className="py-3">
          <div className="label mb-1.5">Generate ideas</div>
          <div className="flex gap-2">
            <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Optional focus, e.g. FOMO and limited vacation days, food in Lisbon…" />
            <Button onClick={generate} disabled={busy === "gen"}><Sparkles className="h-4 w-4" />{busy === "gen" ? "Thinking (1–3 min)…" : "Generate 5"}</Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Claude on your Max login, following the marketing guide (entertain, educate, sell) and the map&apos;s taglines.</p>
        </CardBody></Card>
        <Card><CardBody className="py-3">
          <div className="label mb-1.5">Add your own</div>
          <form onSubmit={add} className="flex gap-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Idea" className="flex-1" />
            <Input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="Hook (optional)" className="flex-1" />
            <Button variant="outline" disabled={busy === "add"}><Plus className="h-4 w-4" />Add</Button>
          </form>
        </CardBody></Card>
      </div>
      {err && <p className="mb-2 text-xs text-destructive">{err}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {SOURCES.map((s) => (
          <button key={s.key} onClick={() => setSource(s.key)} className={`rounded-sm border px-2 py-0.5 text-xs ${source === s.key ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {s.label} <span className="font-mono text-[10px] opacity-70">{count(s.key)}</span>
          </button>
        ))}
        <Select value={tier} onChange={(e) => setTier(e.target.value as (typeof TIERS)[number])} className="ml-2 h-7 w-32 text-xs">
          {TIERS.map((t) => <option key={t} value={t}>{t === "all" ? "Any tier" : t}</option>)}
        </Select>
        <Select value={where} onChange={(e) => setWhere(e.target.value as Where | "all")} className="h-7 w-32 text-xs">
          <option value="all">Anywhere</option>
          {WHERE.map((w) => <option key={w.key} value={w.key}>For {w.label}</option>)}
        </Select>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />archived {archivedCount}</label>
        {dupCount > 0 && <label className="flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={showDups} onChange={(e) => setShowDups(e.target.checked)} />show {dupCount} duplicates</label>}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="ml-auto h-7 w-48 text-xs" />
        <Button size="sm" variant="outline" onClick={rerank} disabled={busy === "rank"} title={ranked ? `Last ranked ${new Date(ranked).toLocaleString()}` : "Not ranked yet"}>
          <ListOrdered className="h-3.5 w-3.5" />{busy === "rank" ? "Ranking (2–5 min)…" : "Re-rank"}
        </Button>
      </div>
      <p className="-mt-1.5 mb-3 text-[11px] text-muted-foreground">Best first. Duplicates are folded into the best version of each idea. New ideas sit at the top until you re-rank. Ranking and new ideas learn from what each idea&apos;s videos did on Instagram (weighted heavily) and from ideas you delete (a light dislike). Archive just tidies: it teaches nothing.</p>
      {!shown.length ? <Empty>No ideas match.</Empty> : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((i) => (
            <Card key={i.id} className="flex flex-col">
              <CardBody className="flex flex-1 flex-col py-3">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className={`font-mono text-[11px] font-semibold ${i.rank ? "text-foreground" : "text-primary"}`}>{i.dupOf ? "dup" : i.rank ? `#${i.rank}` : "new"}</span>
                  {i.color && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: i.color }} />}
                  <span className="uppercase">{i.source}</span>
                  <WhereMarks where={i.where} />
                  {i.tier && <span className={`ml-auto font-medium capitalize ${TIER_TONE[i.tier] ?? ""}`}>{i.tier}</span>}
                </div>
                <div className="text-[13px] font-medium leading-snug">{i.title}</div>
                {i.hook && <div className="mt-1 text-xs text-muted-foreground">&ldquo;{i.hook}&rdquo;</div>}
                {i.outcome && (i.outcome.killed > 0 || i.outcome.worked > 0) && (
                  <div className="mt-1 text-[11px]">
                    {i.outcome.worked > 0 && <span className="text-success">{i.outcome.worked} worked{i.outcome.best ? ` (${i.outcome.best.toLocaleString()} reach)` : ""}</span>}
                    {i.outcome.worked > 0 && i.outcome.killed > 0 && <span className="text-muted-foreground"> · </span>}
                    {i.outcome.killed > 0 && <span className="text-destructive" title={i.outcome.why ?? ""}>{i.outcome.killed} killed on Instagram</span>}
                  </div>
                )}
                {i.hookWas && <div className="mt-1 text-[11px] text-muted-foreground">Hook adjusted from what failed · was &ldquo;{i.hookWas}&rdquo;</div>}
                {i.dupOf && <div className="mt-1 text-[11px] text-muted-foreground">Repeats <span className="text-foreground">{titleOf(i.dupOf)}</span></div>}
                {!i.dupOf && i.rankWhy && <div className="mt-1 text-[11px] text-muted-foreground">{i.rankWhy}{i.dups > 0 && <span className="opacity-70"> · {i.dups} duplicate{i.dups > 1 ? "s" : ""} folded in</span>}</div>}
                {open === i.id && (
                  <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                    {i.beats.length > 0 && <ol className="list-decimal pl-4">{i.beats.map((b, n) => <li key={n}>{b}</li>)}</ol>}
                    {i.cta && <div><span className="label">Payoff</span> {i.cta}</div>}
                    {i.why && <div><span className="label">Why</span> {i.why}</div>}
                  </div>
                )}
                <div className="mt-auto flex items-center gap-2 pt-3">
                  <Link href={`/make?idea=${encodeURIComponent(i.id)}`}><Button size="sm"><Film className="h-3.5 w-3.5" />Make video</Button></Link>
                  {(i.beats.length > 0 || i.why) && <button onClick={() => setOpen(open === i.id ? null : i.id)} className="text-[11px] text-muted-foreground hover:text-foreground">{open === i.id ? "less" : "details"}</button>}
                  {i.made > 0 && <Badge tone="outline" className="ml-auto">{i.made} made</Badge>}
                  <span className={`${i.made > 0 ? "" : "ml-auto "}flex items-center gap-0.5`}>
                    <button onClick={() => act(i, i.archived ? "unarchive" : "archive")} title={i.archived ? "Put back" : "Archive (just tidying, no dislike)"} className="rounded-sm p-1 text-muted-foreground hover:text-foreground">
                      {i.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </button>
                    <button onClick={() => act(i, "delete")} title="Delete (remembered as disliked)" className="rounded-sm p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                  </span>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
