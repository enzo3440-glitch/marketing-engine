"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Instagram, Megaphone, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Textarea, type Tone } from "@/components/ui";
import type { LiveBoard, LiveCampaign, LivePill, LiveVideo } from "@/lib/live";
import { cn, fmt } from "@/lib/utils";

/**
 * Command → Live: what's out right now, Instagram reels and ad campaigns, each with its numbers and the optimizer's
 * read. Click a row for the video, its stats, the verdict, the planned re-cut and the founder's controls. Money only
 * ever becomes a pending approval in Decide.
 */

const PILL: Record<LivePill, { label: string; tone: Tone }> = {
  good: { label: "running", tone: "success" }, winner: { label: "winner", tone: "primary" }, fixing: { label: "being re-cut", tone: "warning" }, review: { label: "ready for your OK", tone: "primary" },
  waiting: { label: "waiting for a fair read", tone: "outline" }, killed: { label: "killed", tone: "danger" }, replaced: { label: "replaced by re-cut", tone: "outline" },
  paused: { label: "paused", tone: "outline" }, benched: { label: "waiting its turn", tone: "outline" },
};
// v1, v2, v3 of one original, and how this version did against the one before it (founder, Nov 18 2026)
const ARROW: Record<string, string> = { better: "↑", worse: "↓", same: "=", early: "…" };
const VTONE: Record<string, Tone> = { better: "success", worse: "danger", same: "outline", early: "outline" };
function VersionBadge({ v }: { v: LiveVideo }) {
  const x = v.version;
  if (!x || x.of < 2) return null;
  return <Badge tone={x.verdict ? VTONE[x.verdict] : "outline"} className="px-1 py-0" title={x.vs ?? undefined}>v{x.n}{x.verdict ? ` ${ARROW[x.verdict]}` : ""}</Badge>;
}

const KIND: Record<LiveVideo["kind"], string> = { trial: "trial reel", post: "post", ad: "ad" };
const age = (iso: string | null) => {
  if (!iso) return "—";
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  return h < 1 ? "<1h" : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};
const pct = (x: number | null | undefined, d = 1) => fmt.pct(x ?? null, d);
const money = (x: number | null | undefined, cur: string) => (x == null ? "—" : `${x.toFixed(2)} ${cur}`);

type Sel = { type: "reel"; key: string } | { type: "ad"; campaign: string; key: string } | { type: "campaign"; id: string } | null;

/** Older trial-reel versions a newer one replaced. Instagram doesn't let apps delete reels: open, ··· → Delete, then tick it here. */
function DeleteList({ items, done }: { items: LiveBoard["to_delete"]; done: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const mark = async (key: string) => {
    setBusy(key);
    try { await api("/api/live", { method: "POST", json: { action: "deleted", key } }); done(); } finally { setBusy(null); }
  };
  return (
    <div className="rounded-sm border border-warning/50 bg-warning/5 p-2.5 lg:col-span-2">
      <div className="label mb-1">Old versions leaving Instagram · {items.length}</div>
      <p className="mb-2 text-[11.5px] text-muted-foreground">A newer version of each is out, so these stop competing with it. Old ads are paused and old trial reels are deleted from Instagram automatically (about 30 minutes after the new version goes out). One that couldn&apos;t be deleted shows why: delete it by hand and mark it here.</p>
      <ul className="space-y-1">
        {items.map((x) => (
          <li key={x.key} className="flex items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate">{x.title}{x.version && <span className="font-mono text-[10.5px] text-muted-foreground"> · {x.version}</span>}{x.error && <span className="block truncate text-[10.5px] text-destructive">{x.error}</span>}</span>
            {x.permalink && <a href={x.permalink} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">Open on Instagram</a>}
            <Button size="sm" variant="ghost" disabled={busy === x.key} onClick={() => mark(x.key)}>Deleted</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const running = (a: LiveVideo) => !["killed", "paused", "replaced", "benched"].includes(a.pill);

export function LiveSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["live"], queryFn: () => api<LiveBoard>("/api/live"), refetchInterval: 5 * 60_000 });
  const [sel, setSel] = useState<Sel>(null);
  const b = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["live"] });

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setSel(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const camp = b && sel && sel.type !== "reel" ? b.campaigns.find((c) => c.id === (sel.type === "ad" ? sel.campaign : sel.id)) ?? null : null;
  const video = !b || !sel ? null : sel.type === "reel" ? b.reels.find((r) => r.key === sel.key) ?? null
    : sel.type === "ad" ? camp?.groups.flatMap((g) => g.ads).find((a) => a.key === sel.key) ?? null : null;
  // only ads Meta is actually spending on count; paused, killed, replaced and benched ones are folded away (Nov 20 2026)
  const [showOff, setShowOff] = useState(false);
  const liveAds = b?.campaigns.reduce((n, c) => n + c.groups.reduce((m, g) => m + g.ads.filter(running).length, 0), 0) ?? 0;

  return (
    <Card id="live" className="mt-3 scroll-mt-16">
      <CardHeader
        title={<span className="flex items-center gap-2">Live <span className="num font-mono text-primary">{b ? b.reels.length + liveAds : "…"}</span>
          {b && <Badge tone={b.optimize_on ? "success" : "outline"}>optimize {b.optimize_on ? "on" : "off"}</Badge>}</span>}
        description={b ? <span className="block space-y-0.5"><span className="block">{b.goal.ads}</span><span className="block">{b.goal.reels}</span></span>
          : "Ads optimize for installs; reels for follows and virality (shares + saves)."}
        action={<Button size="sm" variant="ghost" onClick={refresh} disabled={q.isFetching}><RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} />Refresh</Button>} />
      <CardBody className="grid gap-3 lg:grid-cols-2">
        {q.error && <p className="text-xs text-destructive lg:col-span-2">{(q.error as Error).message}</p>}
        {b?.error && <p className="text-xs text-warning lg:col-span-2">Meta: {b.error}</p>}
        {b && b.to_delete.length > 0 && <DeleteList items={b.to_delete} done={refresh} />}
        <div className="min-w-0">
          <div className="label mb-1.5 flex items-center gap-1.5"><Instagram className="h-3.5 w-3.5" />Instagram reels · {b?.reels.length ?? "…"}</div>
          {!b ? <Empty>Loading…</Empty> : b.reels.length ? (
            <div className="divide-y divide-border/60 rounded-sm border">
              {b.reels.map((r) => <Row key={r.key} v={r} active={sel?.type === "reel" && sel.key === r.key} onClick={() => setSel({ type: "reel", key: r.key })} currency={b.currency} />)}
            </div>
          ) : <Empty>No trial reels or posts live.</Empty>}
        </div>
        <div className="min-w-0">
          <div className="label mb-1.5 flex items-center gap-1.5"><Megaphone className="h-3.5 w-3.5" />Ads · {b?.campaigns.length ?? "…"} campaign{b?.campaigns.length === 1 ? "" : "s"}</div>
          {!b ? <Empty>Loading…</Empty> : b.campaigns.length ? (
            <div className="space-y-2.5">
              {b.campaigns.map((c) => (
                <div key={c.id} className="rounded-sm border">
                  <button className={cn("flex w-full items-center gap-2 border-b bg-muted/40 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-accent", sel?.type === "campaign" && sel.id === c.id && "bg-accent")}
                    onClick={() => setSel({ type: "campaign", id: c.id })}>
                    <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
                    <span className="num font-mono text-[10.5px] text-muted-foreground">{c.groups.reduce((n, g) => n + g.ads.filter(running).length, 0)} running</span>
                    <Badge tone={c.status === "live" ? "success" : "warning"}>{c.status}</Badge>
                    <span className="num font-mono text-[10.5px] text-muted-foreground">{c.daily_budget}/d · {c.days_left}d left</span>
                  </button>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground">
                    <span>spent <b className="text-foreground">{money(c.spend, c.currency)}</b></span>
                    <span>installs <b className="text-foreground">{c.installs}</b></span>
                    <span>per install <b className="text-foreground">{money(c.cpi, c.currency)}</b></span>
                    <span>opening <b className="text-foreground">{pct(c.hook, 0)}</b></span>
                    <span>CTR <b className="text-foreground">{pct(c.ctr, 2)}</b></span>
                    {c.pending.length > 0 && <span className="text-warning">{c.pending.length} waiting in Decide</span>}
                  </div>
                  {c.groups.map((g) => (
                    <div key={g.name}>
                      <div className="flex items-center gap-2 px-2.5 pt-1.5 text-[11px]">
                        <span className="label">{g.name}</span>
                        {g.daily != null && <span className="font-mono text-[10px] text-muted-foreground">{g.daily}/d</span>}
                        <span className="font-mono text-[10px] text-muted-foreground">{g.ads.filter(running).length} running</span>
                        {g.verdict && g.verdict !== "early" && <Badge tone={g.verdict === "leading" || g.verdict === "winners" ? "success" : g.verdict === "behind" ? "danger" : "outline"} className="px-1 py-0">{g.verdict}</Badge>}
                      </div>
                      <div className="divide-y divide-border/60">
                        {g.ads.filter((a) => running(a) || showOff).map((a) => <Row key={`${g.name}:${a.key}`} v={a} active={sel?.type === "ad" && sel.key === a.key && sel.campaign === c.id}
                          onClick={() => setSel({ type: "ad", campaign: c.id, key: a.key })} currency={c.currency} />)}
                      </div>
                      {!showOff && g.ads.some((a) => !running(a)) && (
                        <button className="px-2.5 py-1 font-mono text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setShowOff(true)}>
                          + {g.ads.filter((a) => !running(a)).length} paused or replaced (no money, no eyes)
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : <Empty>No ad campaigns live. Fire one off from Launch.</Empty>}
        </div>
      </CardBody>
      {b && sel && (video || camp) && <Drawer video={video} camp={camp} currency={camp?.currency ?? b.currency} onClose={() => setSel(null)} onChanged={refresh} />}
    </Card>
  );
}

function Row({ v, active, onClick, currency }: { v: LiveVideo; active: boolean; onClick: () => void; currency: string }) {
  const stats = v.kind === "ad"
    ? [["spend", money(v.spend, currency)], ["seen", fmt.compact(v.impressions ?? 0)], ["opening", pct(v.hook, 0)], ["CTR", pct(v.ctr, 2)], ["installs", String(v.installs ?? 0)], ["per inst.", money(v.cpi, currency)]]
    : [["reach", fmt.compact(v.reach ?? null)], ["saves+shares", pct(v.act, 2)], ["follows", v.follows == null ? "—" : String(v.follows)], ["watched", pct(v.watch, 0)]];
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-accent", active && "bg-accent")}>
      <Thumb src={v.poster} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{v.title}</span>
          <VersionBadge v={v} />
          <Badge tone={PILL[v.pill].tone} className="px-1 py-0">{PILL[v.pill].label}</Badge>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2.5 font-mono text-[10.5px] text-muted-foreground">
          <span>{KIND[v.kind]} · {age(v.since)}</span>
          {stats.map(([k, x]) => <span key={k}>{k} <span className="text-foreground">{x}</span></span>)}
        </div>
      </div>
    </button>
  );
}

const Thumb = ({ src, className }: { src: string | null; className?: string }) => (
  <div className={cn("h-12 w-[27px] shrink-0 overflow-hidden rounded-sm bg-muted", className)}>
    {src && /* eslint-disable-next-line @next/next/no-img-element */ <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />}
  </div>
);

function Stat({ k, v }: { k: string; v: string }) {
  return <div className="rounded-sm border px-2 py-1"><div className="label">{k}</div><div className="num font-mono text-[13px]">{v}</div></div>;
}

function Drawer({ video, camp, currency, onClose, onChanged }: { video: LiveVideo | null; camp: LiveCampaign | null; currency: string; onClose: () => void; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [daily, setDaily] = useState("");
  const [days, setDays] = useState("3");
  const [fresh, setFresh] = useState<{ reach: number; saves: number; shares: number; act: number | null; watch: number | null; at: string } | null>(null);
  const reelKey = video && video.kind !== "ad" ? video.key : null;

  useEffect(() => {
    setMsg(null); setErr(null); setNote(""); setFresh(null);
    setDaily(camp ? String(Math.round(camp.daily_budget * 1.3)) : "10"); setDays(camp ? "3" : "4");
    if (!reelKey) return;
    let gone = false;
    api<{ fresh: typeof fresh }>(`/api/live?reel=${encodeURIComponent(reelKey)}`).then((r) => !gone && setFresh(r.fresh)).catch(() => null);
    return () => { gone = true; };
  }, [reelKey, camp?.id, video?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(json: Record<string, unknown>) {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api<{ detail: string }>("/api/live", { method: "POST", json });
      setMsg(r.detail); if (json.action === "note") setNote("");
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const v = video;
  const reach = fresh?.reach ?? v?.reach ?? null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/60 backdrop-blur-[1px]" onClick={onClose}>
      <aside className="h-full w-full max-w-[560px] overflow-y-auto border-l bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="label">{v ? `${KIND[v.kind]}${v.ad_set ? ` · ${v.ad_set}` : ""} · ${v.feature_name}` : "Ad campaign"}</div>
            <h3 className="text-[15px] font-semibold leading-snug">{v?.title ?? camp?.title}</h3>
            {v && camp && <div className="text-[11.5px] text-muted-foreground">in {camp.title}</div>}
          </div>
          {v && <Badge tone={PILL[v.pill].tone}>{PILL[v.pill].label}</Badge>}
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>

        {v && (
          <div className="mb-3 flex gap-3">
            <div className="aspect-[9/16] w-[180px] shrink-0 overflow-hidden rounded-md bg-black">
              {v.video ? <video key={v.key} src={v.video} poster={v.poster ?? undefined} controls autoPlay muted loop playsInline className="h-full w-full object-cover" />
                : v.poster ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={v.poster} alt="" className="h-full w-full object-cover" /> : null}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                {v.kind === "ad" ? <>
                  <Stat k="spend" v={money(v.spend, currency)} /><Stat k="impressions" v={fmt.num(v.impressions ?? 0)} />
                  <Stat k="opening (3-s)" v={pct(v.hook, 0)} /><Stat k="click-through" v={pct(v.ctr, 2)} />
                  <Stat k="installs" v={String(v.installs ?? 0)} /><Stat k="cost / install" v={money(v.cpi, currency)} />
                </> : <>
                  <Stat k="reach" v={fmt.num(reach)} /><Stat k="saves + shares" v={`${fresh ? fresh.saves + fresh.shares : (v.saves ?? 0) + (v.shares ?? 0)} · ${pct(fresh?.act ?? v.act, 2)}`} />
                  <Stat k="follows" v={v.follows == null ? "—" : String(v.follows)} /><Stat k="watched" v={pct(fresh?.watch ?? v.watch, 0)} />
                </>}
              </div>
              <div className="font-mono text-[10.5px] text-muted-foreground">
                live {age(v.since)}{fresh ? ` · Instagram read ${fmt.ago(fresh.at)}` : ""}{v.fixes ? ` · re-cut ${v.fixes}×` : ""}
              </div>
              {v.permalink && <a href={v.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline">Open on Instagram <ExternalLink className="h-3 w-3" /></a>}
            </div>
          </div>
        )}

        {v?.pending && (
          <Section title="Ready for your OK">
            <div className="flex gap-3">
              {v.pending.video && (
                <div className="aspect-[9/16] w-[150px] shrink-0 overflow-hidden rounded-md bg-black">
                  <video key={v.pending.video} src={v.pending.video} poster={v.pending.poster ?? undefined} controls playsInline className="h-full w-full object-cover" />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1.5 text-[12px]">
                <p><span className="label">What it did</span><br />{v.pending.what}</p>
                <p><span className="label">Why</span><br />{v.pending.why}</p>
                {v.pending.test && <p><span className="label">What it&apos;s testing</span><br />{v.pending.test}</p>}
                <div className="flex gap-1.5 pt-1">
                  <Button size="sm" disabled={busy} onClick={() => send({ action: "approve", key: v.key })}>{v.pending.kind === "kill" ? "Approve: pause it" : "Approve: push it out"}</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => send({ action: "reject", key: v.key })}>Turn down</Button>
                </div>
                <p className="font-mono text-[10.5px] text-muted-foreground">made {fmt.ago(v.pending.at)} · nothing reaches Meta or Instagram until you approve</p>
              </div>
            </div>
          </Section>
        )}

        {v?.version && v.version.of > 1 && (
          <Section title={`Version ${v.version.n} of ${v.version.of}`}>
            {v.version.verdict && <p className="text-[12.5px]"><Badge tone={VTONE[v.version.verdict]} className="mr-1 px-1 py-0">{v.version.verdict === "early" ? "too early" : v.version.verdict === "same" ? "about the same" : v.version.verdict}</Badge>{v.version.vs}</p>}
            {v.version.reason && <p className="mt-1 text-[11.5px] text-muted-foreground">Why it was re-cut: {v.version.reason}</p>}
            {v.version.change && <p className="mt-1 text-[11.5px] text-muted-foreground">What changed: {v.version.change}</p>}
            <ul className="mt-1.5 space-y-0.5 font-mono text-[10.5px]">
              {v.version.lineage.map((x) => <li key={x.key} className={x.current ? "text-foreground" : "text-muted-foreground"}>v{x.n} · {x.status} · {x.metric}{x.current ? "  ← this one" : ""}</li>)}
            </ul>
          </Section>
        )}

        {v && (
          <Section title="How it's doing">
            <p className="text-[12.5px]">{v.recommendation}</p>
            {v.why && <p className="mt-1 text-[11.5px] text-muted-foreground">Optimizer: {v.why}</p>}
          </Section>
        )}

        {v && (
          <Section title="Next iteration">
            {v.fix && v.pill === "fixing" ? <>
              <p className="text-[12.5px]">Re-cutting the {v.fix.verdict === "payoff" ? "payoff and end card" : v.fix.verdict === "fresh" ? "opening (fresh start)" : "opening"} · started {fmt.ago(v.fix.started_at)}</p>
              <p className="mt-1 line-clamp-6 text-[11px] text-muted-foreground" title={v.fix.ask}>Ask: {v.fix.ask}</p>
            </> : v.next ? <p className="text-[12.5px]">{v.next}</p>
              : <p className="text-[12.5px] text-muted-foreground">{v.pill === "killed" ? "None: it's done." : v.kind === "ad" ? "None planned: it's good as is unless the numbers drop." : "None yet: re-cut or killed as soon as its reach stops growing short of viral."}</p>}
          </Section>
        )}

        {camp && (
          <Section title={v ? "Campaign" : "How it's doing"}>
            <div className="mb-1.5 grid grid-cols-3 gap-1.5">
              <Stat k="spent" v={money(camp.spend, currency)} /><Stat k="installs" v={String(camp.installs)} /><Stat k="cost / install" v={money(camp.cpi, currency)} />
              <Stat k="budget" v={`${camp.daily_budget}/d`} /><Stat k="opening" v={pct(camp.hook, 0)} /><Stat k="click-through" v={pct(camp.ctr, 2)} />
            </div>
            <p className="text-[12.5px]">{camp.recommendation}</p>
            <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">{fmt.date(camp.starts_on)} → {fmt.date(camp.ends_on)} · {camp.days_left} days left</div>
            {camp.insights.length > 0 && <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11.5px] text-muted-foreground">{camp.insights.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          </Section>
        )}

        <Section title="Your call">
          {msg && <p className="mb-1.5 text-xs text-primary">{msg}</p>}
          {err && <p className="mb-1.5 text-xs text-destructive">{err}</p>}
          {camp && (camp.pending.length ? (
            <div className="mb-2 text-[12px]">Waiting in Decide: {camp.pending.map((p) => <a key={p.id} href="#decide" className="text-primary hover:underline">{p.title}</a>)}</div>
          ) : camp.status === "building" ? <p className="mb-2 text-[12px] text-muted-foreground">Budget changes open once it&apos;s live in Meta.</p> : (
            <div className="mb-2.5">
              <div className="label mb-1">Put more money on the campaign</div>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="text-muted-foreground">{camp.daily_budget} →</span>
                <Input className="h-7 w-20" type="number" min={1} max={camp.max_daily} value={daily} onChange={(e) => setDaily(e.target.value)} />
                <span className="text-muted-foreground">/day, plus</span>
                <Input className="h-7 w-14" type="number" min={0} max={60} value={days} onChange={(e) => setDays(e.target.value)} />
                <span className="text-muted-foreground">more days</span>
                <Button size="sm" disabled={busy || !Number(daily)} onClick={() => send({ action: "budget", campaign_id: camp.id, daily_budget: Number(daily), extend_days: Number(days) || 0, note: note || undefined })}>Propose</Button>
              </div>
              <p className="mt-1 text-[10.5px] text-muted-foreground">Goes to Decide as an approval; Meta changes only after you approve it there. Cap {camp.max_daily}/day.</p>
            </div>
          ))}
          {v && v.kind !== "ad" && v.ig_media_id && (
            <div className="mb-2.5">
              <div className="label mb-1">Promote this reel as an ad</div>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <Input className="h-7 w-20" type="number" min={1} value={daily} onChange={(e) => setDaily(e.target.value)} />
                <span className="text-muted-foreground">/day for</span>
                <Input className="h-7 w-14" type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} />
                <span className="text-muted-foreground">days</span>
                <Button size="sm" disabled={busy || !Number(daily)} onClick={() => send({ action: "promote", key: v.key, daily_budget: Number(daily), days: Number(days) || 4 })}>Propose</Button>
              </div>
              <p className="mt-1 text-[10.5px] text-muted-foreground">Promotes the post as-is (likes carry over). Goes to Decide first.</p>
            </div>
          )}
          {v && v.video && (
            <div>
              <div className="label mb-1">Suggest a change</div>
              <Textarea rows={2} placeholder="e.g. open on the most striking shot, shorter first line" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="mt-1 flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={busy || !note.trim()} onClick={() => send({ action: "note", key: v.key, text: note })}>Save for the next re-cut</Button>
              </div>
              {v.notes.length > 0 && <ul className="mt-1.5 space-y-0.5 text-[11.5px]">{v.notes.slice(0, 5).map((n, i) => <li key={i}><span className="font-mono text-[10px] text-muted-foreground">{fmt.ago(n.at)}</span> {n.text}</li>)}</ul>}
            </div>
          )}
        </Section>

        {v && v.readings.length > 0 && (
          <Section title="Readings">
            <table className="w-full font-mono text-[10.5px]">
              <thead className="text-muted-foreground"><tr>{(v.kind === "ad" ? ["when", "seen", "opening", "CTR", "installs"] : ["when", "reach", "watched", "saves+shares"]).map((h) => <th key={h} className="py-0.5 text-left font-normal">{h}</th>)}</tr></thead>
              <tbody>{v.readings.slice(0, 8).map((r, i) => (
                <tr key={i} className="border-t border-border/50">{v.kind === "ad"
                  ? <><td>{fmt.dateTime(r.at)}</td><td>{fmt.compact(r.impressions ?? 0)}</td><td>{pct(r.hook, 0)}</td><td>{pct(r.ctr, 2)}</td><td>{r.installs ?? 0}</td></>
                  : <><td>{fmt.dateTime(r.at)}</td><td>{fmt.compact(r.reach ?? 0)}</td><td>{pct(r.watch, 0)}</td><td>{pct(r.act, 2)}</td></>}</tr>
              ))}</tbody>
            </table>
          </Section>
        )}

        {v && v.history.length > 0 && (
          <Section title="History">
            <ul className="space-y-1 text-[11.5px]">{v.history.slice(0, 10).map((h, i) => <li key={i}><span className="font-mono text-[10px] text-muted-foreground">{fmt.dateTime(h.at)}</span> {h.text}</li>)}</ul>
          </Section>
        )}
      </aside>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="mb-3 border-t pt-2.5"><div className="label mb-1.5">{title}</div>{children}</div>
);
