"use client";
import type { GrowthTest, TestCandidate } from "@engine/db/types";
import { FlaskConical, Plus, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Select, Table, Td, Th, type Tone } from "@/components/ui";
import { cn, fmt } from "@/lib/utils";

export interface ReelOption { job_id: string; variant_id: string; label: string; poster: string | null; caption: string; picked: boolean }
type Money = { free: number | null; committed: number; currency: string; balance: number | null; capRoom: number | null } | null;

const STAGES: GrowthTest["stage"][] = ["trial", "screen", "scale", "done"];
const STAGE_LABEL = { trial: "Trial reels", screen: "Ads screen", scale: "Scale winners", done: "Done" };
const poster = (r: { job_id: string; poster: string | null }) => (r.poster ? `/api/reels/files/${encodeURIComponent(r.job_id)}/${encodeURIComponent(r.poster)}` : null);
const STATUS_TONE: Record<TestCandidate["status"], Tone> = { active: "outline", advanced: "success", dropped: "danger" };

export function Lab({ tests, reels, ideas, money, plan }: {
  tests: GrowthTest[]; reels: ReelOption[]; ideas: { id: string; title: string; color: string }[]; money: Money; plan: GrowthTest["plan"] | null;
}) {
  const [creating, setCreating] = useState(!tests.length);
  return (
    <div className="space-y-3">
      <Funds money={money} plan={plan} />
      {creating ? <NewTest reels={reels} ideas={ideas} onDone={() => setCreating(false)} />
        : <Button variant="outline" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New test</Button>}
      {tests.length ? tests.map((t) => <TestCard key={t.id} t={t} />) : !creating && <Empty>No tests yet.</Empty>}
    </div>
  );
}

function Funds({ money, plan }: { money: Money; plan: GrowthTest["plan"] | null }) {
  const cur = money?.currency ?? plan?.currency ?? "USD";
  return (
    <Card className="grid grid-cols-2 divide-x divide-y divide-border/70 sm:grid-cols-4 lg:grid-cols-7 lg:divide-y-0">
      {[
        ["Free to spend", money?.free != null ? `${money.free.toFixed(0)} ${cur}` : "—", "balance or spend-cap room, minus live campaigns"],
        ["Prepaid balance", money?.balance != null ? `${money.balance.toFixed(0)} ${cur}` : "—", ""],
        ["Spend-cap room", money?.capRoom != null ? `${money.capRoom.toFixed(0)} ${cur}` : "—", ""],
        ["Committed", money ? `${money.committed.toFixed(0)} ${cur}` : "—", "still to spend on live campaigns"],
        ["Screen (8 reels)", plan ? `${plan.screen_daily}/day × ${plan.screen_days}d` : "—", plan ? `top ${plan.advance_trial} of the trial` : ""],
        ["Scale", plan ? `${plan.scale_total} ${cur}` : "—", plan ? `top ${plan.advance_screen} for ${plan.scale_days} days` : ""],
        ["Reserve", plan ? `${plan.reserve} ${cur}` : "—", "for a second version of the winner"],
      ].map(([k, v, hint]) => (
        <div key={k} className="px-3 py-2.5" title={hint}>
          <div className="label">{k}</div>
          <div className="num mt-1 font-mono text-[16px] font-semibold">{v}</div>
          {hint && <div className="truncate text-[10.5px] text-muted-foreground">{hint}</div>}
        </div>
      ))}
    </Card>
  );
}

function NewTest({ reels, ideas, onDone }: { reels: ReelOption[]; ideas: { id: string; title: string; color: string }[]; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(`Round 1 · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
  const [picks, setPicks] = useState<Record<string, { caption: string; content_id: string }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = (r: ReelOption) => `${r.job_id}|${r.variant_id}`;
  const toggle = (r: ReelOption) => setPicks((p) => {
    const n = { ...p };
    if (n[key(r)]) delete n[key(r)]; else n[key(r)] = { caption: r.caption || r.label, content_id: "" };
    return n;
  });
  async function create() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/lab", { method: "POST", json: { name, picks: Object.entries(picks).map(([k, v]) => { const [job_id, variant_id] = k.split("|"); return { job_id, variant_id, caption: v.caption, content_id: v.content_id || null }; }) } });
      onDone();
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const n = Object.keys(picks).length;
  return (
    <Card>
      <CardHeader title="New test" description="Pick 2–15 finished reels. Each becomes a trial reel with its caption; link a plan idea so its pillar is tracked and its Tested check is ticked automatically." action={
        <div className="flex items-center gap-2">
          <Input className="h-8 w-56" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" disabled={busy || n < 2} onClick={create}><FlaskConical className="h-3.5 w-3.5" />Create test ({n})</Button>
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      } />
      <CardBody>
        {err && <p className="mb-2 text-xs text-destructive">{err}</p>}
        {reels.length ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
            {reels.map((r) => {
              const p = picks[key(r)];
              return (
                <div key={key(r)} className={cn("overflow-hidden rounded-md border bg-background/60", p && "border-primary ring-1 ring-primary/50")}>
                  <button onClick={() => toggle(r)} className="relative block aspect-[9/16] max-h-56 w-full bg-muted/50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {poster(r) && <img src={poster(r)!} alt="" loading="lazy" className="h-full w-full object-cover" />}
                    <span className={cn("absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-sm border bg-background/80 font-mono text-[11px]", p && "border-primary bg-primary text-primary-foreground")}>{p ? "✓" : ""}</span>
                    {r.picked && <span className="absolute right-1.5 top-1.5 text-[12px]">★</span>}
                  </button>
                  <div className="space-y-1 p-1.5">
                    <div className="line-clamp-2 text-[11.5px] leading-snug">{r.label}</div>
                    {p && (
                      <>
                        <textarea value={p.caption} rows={3} onChange={(e) => setPicks((x) => ({ ...x, [key(r)]: { ...p, caption: e.target.value } }))}
                          className="w-full rounded-sm border bg-transparent p-1 text-[11px]" placeholder="Caption" />
                        <Select className="h-7 w-full text-[11px]" value={p.content_id} onChange={(e) => setPicks((x) => ({ ...x, [key(r)]: { ...p, content_id: e.target.value } }))}>
                          <option value="">No plan idea</option>
                          {ideas.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
                        </Select>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <Empty>No finished reels yet. Render some in the Video Engine first.</Empty>}
      </CardBody>
    </Card>
  );
}

export function TestCard({ t }: { t: GrowthTest }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cur = t.plan.currency;
  async function act(action: "improve" | "measure") {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ proposals?: { title: string }[]; notes?: string[] }>(`/api/lab/${t.id}`, { method: "POST", json: { action } });
      setNotes(action === "measure" ? ["Results refreshed."] : [...(r.notes ?? []), ...(r.proposals ?? []).map((p) => `Sent to Decide: ${p.title}`)]);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title={t.name} description={
        <span className="flex flex-wrap items-center gap-1.5">
          {STAGES.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase", s === t.stage ? "bg-primary/15 text-primary" : STAGES.indexOf(t.stage) > i ? "text-success" : "text-muted-foreground")}>{STAGE_LABEL[s]}</span>
              {i < STAGES.length - 1 && <span className="text-muted-foreground">→</span>}
            </span>
          ))}
        </span>
      } action={
        <div className="flex gap-1.5">
          <Button size="sm" disabled={busy} onClick={() => act("improve")}><Sparkles className="h-3.5 w-3.5" />Improve</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act("measure")}>Refresh results</Button>
          {!t.candidates.some((c) => c.trial?.media_id || c.screen?.ad_campaign_id) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { await api(`/api/lab/${t.id}`, { method: "DELETE" }); router.refresh(); }}><Trash2 className="h-3.5 w-3.5" /></Button>
          )}
        </div>
      } />
      {(notes || err) && (
        <div className="border-b px-3.5 py-2 text-[12px]">
          {err && <p className="text-destructive">{err}</p>}
          {notes?.map((n) => <p key={n}>{n.startsWith("Sent to Decide") ? <Link href="/command#decide" className="text-primary hover:underline">{n} →</Link> : n}</p>)}
        </div>
      )}
      <Table>
        <thead><tr>
          <Th>Reel</Th><Th>Status</Th>
          <Th className="text-right">Trial reach</Th><Th className="text-right">Saves+shares</Th><Th className="text-right">Score</Th><Th className="text-right">Avg watch</Th>
          <Th className="text-right">Ad spend</Th><Th className="text-right">Clicks</Th><Th className="text-right">Hook rate</Th>
        </tr></thead>
        <tbody>{t.candidates.map((c) => {
          const tm = c.trial?.metrics, sm = c.scale?.metrics ?? c.screen?.metrics;
          return (
            <tr key={c.id} className={cn(c.status === "dropped" && "opacity-50")}>
              <Td className="max-w-xs">
                <div className="truncate text-[12.5px]">{c.label}</div>
                <div className="flex gap-2 text-[10.5px] text-muted-foreground">
                  {c.trial?.permalink && <a className="hover:text-foreground" href={c.trial.permalink} target="_blank" rel="noreferrer">trial reel ↗</a>}
                  {c.screen?.ad_campaign_id && <Link className="hover:text-foreground" href="/calendar">ad campaign →</Link>}
                  {c.trial?.error && <span className="truncate text-destructive" title={c.trial.error}>{c.trial.error}</span>}
                </div>
              </Td>
              <Td><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></Td>
              <Td className="num text-right font-mono text-[12px]">{tm?.reach != null ? fmt.compact(tm.reach) : "—"}</Td>
              <Td className="num text-right font-mono text-[12px]">{tm ? `${tm.saves ?? 0}+${tm.shares ?? 0}` : "—"}</Td>
              <Td className="num text-right font-mono text-[12px] text-primary">{c.trial?.score != null ? fmt.pct(c.trial.score, 2) : "—"}</Td>
              <Td className="num text-right font-mono text-[12px]">{tm?.avg_watch_ms != null ? `${(tm.avg_watch_ms / 1000).toFixed(1)}s` : "—"}</Td>
              <Td className="num text-right font-mono text-[12px]">{sm?.spend != null ? `${sm.spend.toFixed(2)} ${cur}` : "—"}</Td>
              <Td className="num text-right font-mono text-[12px]">{sm?.clicks ?? "—"}</Td>
              <Td className="num text-right font-mono text-[12px]">{sm?.impressions ? fmt.pct((sm.video_views ?? 0) / sm.impressions, 1) : "—"}</Td>
            </tr>
          );
        })}</tbody>
      </Table>
      <CardBody className="py-2">
        <details className="text-[11.5px] text-muted-foreground">
          <summary className="cursor-pointer">Log · plan: screen {t.plan.screen_daily} {cur}/day × {t.plan.screen_days}d, scale {t.plan.scale_total} {cur}, reserve {t.plan.reserve} {cur}</summary>
          <ul className="mt-1 space-y-0.5">{[...t.log].reverse().map((l, i) => <li key={i}><span className="font-mono">{fmt.dateTime(l.at)}</span> · {l.text}</li>)}</ul>
        </details>
      </CardBody>
    </Card>
  );
}
