"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Card, CardBody, CardHeader, Empty, Select, Table, Td, Th } from "@/components/ui";
import { FEATURES, featureName } from "@/lib/features";

type Item = { key: string; kind: "ad" | "trial"; label: string; feature: string; status: string; fixes: number; why?: string; next?: string; history: { at: string; text: string }[] };
type Status = { on: boolean; changed_at: string | null; changed_by: string | null; log: { at: string; text: string }[]; items: Item[];
  counts: Record<"watching" | "fixing" | "killed" | "replaced", number>; rules: { max_fixes: number; fixes_per_day: number; ad_fair: number; ad_payoff: number; ad_kill: number; trial_fair: number; trial_target?: number } };
type Row = { id: string; name: string; color: string; ads: number; trials: number; spend: number; impressions: number; views3s: number; p50: number; clicks: number; installs: number;
  events: Record<string, number>; reach: number; saves_shares: number; watch_s: number; watch_n: number; watch_len: number };
type Video = { key: string; label: string; kind: string; campaign: string | null; feature: string; manual: boolean; status: string; impressions: number; clicks: number; spend: number;
  installs: number; hook: number | null; reach: number | null; act: number | null; watch: number | null };
type Board = { currency: string; rows: Row[]; videos: Video[]; campaigns: { id: string; title: string }[]; eventNames: string[]; live: boolean; error?: string };

const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** The goals a feature can be judged on; better = higher unless lower is set. "early" = not enough data to trust yet. */
const GOALS: { id: string; name: string; hint: string; lower?: boolean; value: (r: Row) => number | null; fmt: (x: number, cur: string) => string; sub: (r: Row, cur: string) => string; early: (r: Row) => boolean }[] = [
  { id: "installs", name: "Installs", hint: "Cost per install: what it takes to bring one person into the app.", lower: true,
    value: (r) => (r.installs ? r.spend / r.installs : null), fmt: (x, c) => `${x.toFixed(2)} ${c}`, sub: (r) => `${r.installs} installs`, early: (r) => r.installs < 10 },
  { id: "clicks", name: "App Store clicks", hint: "Click-through to the App Store: how many who saw it wanted the app.",
    value: (r) => (r.impressions ? r.clicks / r.impressions : null), fmt: (x) => pct(x, 2), sub: (r, c) => `${r.clicks} clicks${r.clicks ? ` · ${(r.spend / r.clicks).toFixed(2)} ${c}/click` : ""}`, early: (r) => r.impressions < 2000 },
  { id: "hook", name: "Stops the scroll", hint: "Ads: 3-second views ÷ impressions. Reels: share of the video watched on average.",
    value: (r) => (r.impressions ? r.views3s / r.impressions : r.watch_len ? r.watch_s / r.watch_len : null), fmt: (x) => pct(x, 0),
    sub: (r) => (r.impressions ? `${r.impressions.toLocaleString()} impressions` : `${r.trials} reels`), early: (r) => r.impressions < 2000 && r.reach < 600 },
  { id: "hold", name: "Watched half", hint: "Of the people who stopped, the share who watched at least half.",
    value: (r) => (r.views3s ? r.p50 / r.views3s : null), fmt: (x) => pct(x, 0), sub: (r) => `${r.p50.toLocaleString()} watched half`, early: (r) => r.views3s < 500 },
  { id: "saves", name: "Saves + shares", hint: "Instagram reels: (saves + shares) ÷ reach, the reel scorecard.",
    value: (r) => (r.reach ? r.saves_shares / r.reach : null), fmt: (x) => pct(x, 2), sub: (r) => `${r.reach.toLocaleString()} reach · ${r.trials} reels`, early: (r) => r.reach < 600 },
  { id: "events", name: "Used the app", hint: "App events Meta attributes to the ads, per install (needs your app to send events).",
    value: (r) => { const n = Object.values(r.events).reduce((a, x) => a + x, 0); return r.installs && n ? n / r.installs : null; }, fmt: (x) => `${x.toFixed(1)}/install`,
    sub: (r) => `${Object.values(r.events).reduce((a, x) => a + x, 0)} events`, early: (r) => r.installs < 10 },
];

export function OptimizeToggle({ canApprove, compact = false }: { canApprove: boolean; compact?: boolean }) {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!compact);
  const load = useCallback(() => api<{ status: Status }>("/api/optimize").then((r) => setS(r.status)).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { void load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const flip = async () => {
    if (!s) return;
    if (!s.on && !confirm("Turn on live optimize? From now on the desk watches every live ad and trial reel, renders re-cuts of weak hooks and payoffs, and stops dead trial reels. Every swap, repost and ad pause waits for your one-click OK in Command → Live. It never raises a budget or starts a campaign.")) return;
    setBusy(true); setErr(null);
    try { setS(await api<Status>("/api/optimize", { method: "POST", json: { on: !s.on } })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const active = s?.items.filter((x) => x.status === "fixing" || x.history.length) ?? [];
  return (
    <Card className="mb-3">
      <CardHeader title={<span className="flex items-center gap-2">Live optimize {s && <Badge tone={s.on ? "success" : "outline"}>{s.on ? "on" : "off"}</Badge>}</span>}
        description={s?.on
          ? `Reads every live ad hourly and every trial reel every 2 h. A weak part gets re-cut first (up to ${s.rules.max_fixes} re-cuts, hook first) and goes straight back out; only a re-cut that's still weak at both ends after ${s.rules.ad_kill.toLocaleString()} impressions of its own is killed. Budgets still come to Decide.`
          : "Off: weak ads and trial reels come to Decide as proposals. On: the desk kills, re-cuts and reposts them itself, as soon as the numbers are fair."}
        action={<div className="flex items-center gap-2">
          {compact && <button className="label hover:text-foreground" onClick={() => setOpen(!open)}>{open ? "hide" : "details"}</button>}
          <button role="switch" aria-checked={!!s?.on} disabled={!s || busy || !canApprove} onClick={flip} title={canApprove ? "" : "Needs approver access"}
            className={`relative h-6 w-11 rounded-full transition ${s?.on ? "bg-emerald-600" : "bg-muted"} disabled:opacity-50`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${s?.on ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </div>} />
      {err && <CardBody><p className="text-[12px] text-destructive">{err}</p></CardBody>}
      {s && open && (
        <CardBody className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <div className="mb-2 grid grid-cols-4 gap-2">
              {(["watching", "fixing", "replaced", "killed"] as const).map((k) => (
                <div key={k} className="rounded-md border px-2 py-1.5"><div className="label">{k === "fixing" ? "re-cutting" : k}</div><div className="num font-mono text-[17px] font-semibold">{s.counts[k]}</div></div>
              ))}
            </div>
            <div className="text-[11px] leading-relaxed text-muted-foreground">
              <b className="text-foreground">Fair read</b>: an ad&apos;s opening at {s.rules.ad_fair.toLocaleString()} impressions, its clicks at {s.rules.ad_payoff.toLocaleString()} and 2 days; a trial reel at {s.rules.trial_fair} reach (from 6 h after posting). A trial whose reach stops short of {(s.rules.trial_target ?? 1000).toLocaleString()} is re-cut if something in it is strong, or killed.{" "}
              <b className="text-foreground">Never killed on a first read</b>: zero traction gets a re-cut first; only a re-cut still weak at both ends after {s.rules.ad_kill.toLocaleString()} impressions is killed. <b className="text-foreground">Weak opening</b> → re-cut the first 2-3 s.{" "}
              <b className="text-foreground">Watched, no action</b> → re-cut the payoff. <b className="text-foreground">Worked, then dropped</b> → fresh opening, reposted.{" "}
              Up to {s.rules.fixes_per_day} re-cuts a day.
            </div>
            {s.changed_at && <div className="mt-1 font-mono text-[10px] text-muted-foreground">turned {s.on ? "on" : "off"} {ago(s.changed_at)} ago by {s.changed_by}</div>}
          </div>
          <div className="max-h-64 overflow-auto">
            {!active.length && !s.log.length ? <Empty>{s.on ? "Nothing to act on yet: the first reads come once videos have had a fair look." : "Turn it on to start."}</Empty> : (
              <ul className="space-y-1.5 text-[11.5px]">
                {active.filter((x) => x.status === "fixing").map((x) => (
                  <li key={x.key} className="flex gap-2"><Badge tone="warning">re-cutting</Badge><span className="truncate">{x.label}</span></li>
                ))}
                {s.log.slice(0, 25).map((l, i) => (
                  <li key={i} className="flex gap-2"><span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground">{ago(l.at)}</span><span>{l.text}</span></li>
                ))}
              </ul>
            )}
          </div>
        </CardBody>
      )}
    </Card>
  );
}

export function FeatureBoardView() {
  const [campaign, setCampaign] = useState("");
  const [goal, setGoal] = useState("clicks");
  const [b, setB] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const load = useCallback(() => api<{ board: Board }>(`/api/optimize${campaign ? `?campaign=${encodeURIComponent(campaign)}` : ""}`).then((r) => setB(r.board)).catch((e) => setErr((e as Error).message)), [campaign]);
  useEffect(() => { void load(); }, [load]);
  const g = GOALS.find((x) => x.id === goal)!;
  const ranked = useMemo(() => (b?.rows ?? []).map((r) => ({ r, v: g.value(r) })).sort((x, y) => (x.v == null ? 1 : y.v == null ? -1 : g.lower ? x.v - y.v : y.v - x.v)), [b, g]);
  const top = Math.max(1e-9, ...ranked.map((x) => x.v ?? 0));
  const setFeature = async (v: Video, feature: string) => {
    const [job_id, variant_id] = v.key.split(/[|/]/);
    try { await api("/api/optimize", { method: "POST", json: { job_id, variant_id, feature } }); await load(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card className="mb-3">
      <CardHeader title="What brings people in · by feature"
        description={<>Every ad and trial reel, grouped by the feature it sells. Pick the goal to rank by; <Badge tone="outline">early</Badge> means not enough data to trust yet.{b && !b.live && <span className="text-destructive"> Meta ad numbers unavailable{b.error ? `: ${b.error}` : ""}.</span>}</>}
        action={<Select value={campaign} onChange={(e) => setCampaign(e.target.value)} className="h-7 w-48 text-xs">
          <option value="">All campaigns + reels</option>
          {b?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </Select>} />
      <CardBody>
        <div className="mb-3 flex flex-wrap gap-1">
          {GOALS.filter((x) => x.id !== "events" || b?.eventNames.length).map((x) => (
            <button key={x.id} onClick={() => setGoal(x.id)} className={`rounded-md border px-2 py-1 text-[11.5px] ${goal === x.id ? "border-foreground bg-foreground text-background" : "hover:bg-muted"}`}>{x.name}</button>
          ))}
        </div>
        <p className="mb-3 text-[11px] text-muted-foreground">{g.hint}{g.lower ? " Lower is better." : ""}</p>
        {err && <p className="mb-2 text-[12px] text-destructive">{err}</p>}
        {!b ? <div className="h-40 animate-pulse rounded bg-muted/20" /> : (
          <div className="space-y-2">
            {ranked.map(({ r, v }, i) => (
              <button key={r.id} onClick={() => setPick(pick === r.id ? null : r.id)} className={`block w-full rounded-md px-1 py-1 text-left hover:bg-muted/40 ${pick === r.id ? "bg-muted/50" : ""}`}>
                <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span className="flex items-center gap-1.5">
                    <span className="w-4 font-mono text-[10px] text-muted-foreground">{v != null ? i + 1 : ""}</span>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />{r.name}
                    {v != null && g.early(r) && <Badge tone="outline">early</Badge>}
                  </span>
                  <span className="num font-mono text-[12px] font-semibold">{v != null ? g.fmt(v, b.currency) : "—"}</span>
                </div>
                <div className="ml-5 mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${v == null ? 0 : g.lower ? (Math.min(...ranked.filter((x) => x.v != null).map((x) => x.v!)) / v) * 100 : (v / top) * 100}%`, background: r.color, opacity: g.early(r) ? 0.45 : 1 }} />
                </div>
                <div className="ml-5 mt-0.5 font-mono text-[10px] text-muted-foreground">{r.ads} ads · {r.trials} reels · {g.sub(r, b.currency)}</div>
              </button>
            ))}
          </div>
        )}
      </CardBody>
      {b && b.rows.some((r) => r.ads) && (
        <Table>
          <thead><tr><Th>Funnel</Th><Th className="text-right">Seen</Th><Th className="text-right">Stopped</Th><Th className="text-right">Watched half</Th><Th className="text-right">Clicked</Th><Th className="text-right">Installed</Th>
            {b.eventNames.slice(0, 3).map((e) => <Th key={e} className="text-right">{e.replace(/^app_custom_event\.|^mobile_app_|^omni_/, "")}</Th>)}<Th className="text-right">Spend</Th></tr></thead>
          <tbody>{b.rows.filter((r) => r.ads).map((r) => (
            <tr key={r.id}>
              <Td><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: r.color }} />{r.name}</span></Td>
              <Td className="num text-right font-mono text-[11.5px]">{r.impressions.toLocaleString()}</Td>
              <Td className="num text-right font-mono text-[11.5px]">{pct(r.impressions ? r.views3s / r.impressions : null, 0)}</Td>
              <Td className="num text-right font-mono text-[11.5px]">{pct(r.views3s ? r.p50 / r.views3s : null, 0)}</Td>
              <Td className="num text-right font-mono text-[11.5px]">{r.clicks} <span className="text-muted-foreground">({pct(r.impressions ? r.clicks / r.impressions : null, 2)})</span></Td>
              <Td className="num text-right font-mono text-[11.5px]">{r.installs}</Td>
              {b.eventNames.slice(0, 3).map((e) => <Td key={e} className="num text-right font-mono text-[11.5px]">{r.events[e] ?? 0}</Td>)}
              <Td className="num text-right font-mono text-[11.5px]">{r.spend.toFixed(2)}</Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
      {b && pick && (
        <Table>
          <thead><tr><Th>{featureName(pick)} · videos</Th><Th>Status</Th><Th className="text-right">Seen / reach</Th><Th className="text-right">Stop / watch</Th><Th className="text-right">Clicks / saves</Th><Th>Feature</Th></tr></thead>
          <tbody>{b.videos.filter((v) => v.feature === pick).map((v) => (
            <tr key={v.key}>
              <Td className="max-w-[280px]"><div className="truncate" title={v.label}>{v.label}</div><div className="font-mono text-[10px] text-muted-foreground">{v.kind}{v.campaign ? ` · ${v.campaign}` : ""}</div></Td>
              <Td><Badge tone={v.status === "killed" ? "danger" : v.status === "fixing" ? "warning" : "outline"}>{v.status === "fixing" ? "re-cutting" : v.status}</Badge></Td>
              <Td className="num text-right font-mono text-[11.5px]">{v.kind === "ad" ? v.impressions.toLocaleString() : (v.reach ?? 0).toLocaleString()}</Td>
              <Td className="num text-right font-mono text-[11.5px]">{v.kind === "ad" ? pct(v.hook, 0) : pct(v.watch, 0)}</Td>
              <Td className="num text-right font-mono text-[11.5px]">{v.kind === "ad" ? v.clicks : pct(v.act, 2)}</Td>
              <Td>{v.key.includes("ig:") ? null : (
                <Select value={v.manual ? v.feature : "auto"} onChange={(e) => setFeature(v, e.target.value)} className="h-6 w-36 text-[11px]">
                  <option value="auto">auto ({featureName(v.feature)})</option>
                  {FEATURES.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  <option value="other">Unsorted</option>
                </Select>
              )}</Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
    </Card>
  );
}


type Exp = { id: string; at: string; kind: "ad" | "trial"; label: string; variable: string; hypothesis: string; change: string; evidence?: string; status: string; result?: string };
type Lab = { experiments: Exp[]; rules: string[]; asks_missed: string[]; next: string[]; distilled_at: string | null; followers: { at: string; n: number }[] };
const TONE: Record<string, "success" | "warning" | "outline" | "danger"> = { won: "success", lost: "danger", flat: "outline", testing: "warning", rendering: "warning", failed: "outline", unclear: "outline" };

/** The lab: every re-cut is a hypothesis, scored against its parent; what it learns is the playbook (knowledge/what-works.md) every edit reads. */
export function LabCard() {
  const [l, setL] = useState<Lab | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<{ lab: Lab }>("/api/optimize").then((r) => setL(r.lab)).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  const refresh = async () => {
    setBusy(true); setErr(null);
    try { setL((await api<{ lab: Lab }>("/api/optimize", { method: "POST", json: { lab: true } })).lab); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const f = l?.followers ?? [];
  const gained = f.length > 1 ? f[0].n - f[f.length - 1].n : null;
  return (
    <Card className="mb-3">
      <CardHeader title="Lab: what the data is teaching us"
        description="Every re-cut is a test: one hypothesis from the watch curve or skip rate, one change, scored against the original once it has a fair read. What it learns goes into the playbook every new edit and re-cut reads."
        action={<button className="label hover:text-foreground disabled:opacity-50" disabled={busy} onClick={refresh}>{busy ? "re-reading… (a minute or two)" : "re-read the data now"}</button>} />
      {err && <CardBody><p className="text-[12px] text-destructive">{err}</p></CardBody>}
      {l && (
        <CardBody className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 text-[12px]">
            <div>
              <div className="label mb-1">Rules so far {l.distilled_at && <span className="font-mono text-[10px] normal-case text-muted-foreground">· {ago(l.distilled_at)} ago</span>}</div>
              {l.rules.length ? <ul className="list-disc space-y-1 pl-4">{l.rules.map((r, i) => <li key={i}>{r}</li>)}</ul> : <Empty>Not enough data yet.</Empty>}
            </div>
            <div>
              <div className="label mb-1">Next moves: trial reels → grid posts → ads</div>
              {l.next.length ? <ul className="list-disc space-y-1 pl-4">{l.next.map((r, i) => <li key={i}>{r}</li>)}</ul> : <Empty>None yet.</Empty>}
            </div>
            <div>
              <div className="label mb-1">Your asks the newest videos missed</div>
              {l.asks_missed.length ? <ul className="list-disc space-y-1 pl-4 text-amber-600">{l.asks_missed.map((r, i) => <li key={i}>{r}</li>)}</ul> : <div className="text-muted-foreground">None found.</div>}
            </div>
            {f.length > 0 && <div className="font-mono text-[11px] text-muted-foreground">followers {f[0].n.toLocaleString()}{gained != null ? ` (${gained >= 0 ? "+" : ""}${gained} since ${f[f.length - 1].at.slice(5, 10)})` : ""}</div>}
          </div>
          <div className="max-h-80 overflow-auto">
            <div className="label mb-1">Tests</div>
            {!l.experiments.length ? <Empty>The first test starts with live optimize&apos;s next re-cut.</Empty> : (
              <ul className="space-y-2 text-[11.5px]">
                {l.experiments.map((x) => (
                  <li key={x.id} className="rounded-md border px-2 py-1.5">
                    <div className="flex items-center gap-2"><Badge tone={TONE[x.status] ?? "outline"}>{x.status}</Badge><span className="label">{x.kind} · {x.variable}</span><span className="ml-auto font-mono text-[10px] text-muted-foreground">{ago(x.at)}</span></div>
                    <div className="mt-0.5 truncate font-medium">{x.label}</div>
                    {x.evidence && <div className="text-muted-foreground"><span className="font-medium text-foreground">Because: </span>{x.evidence}</div>}
                    <div><span className="font-medium">Test: </span>{x.hypothesis}</div>
                    <div className="text-muted-foreground"><span className="font-medium text-foreground">Change: </span>{x.change}</div>
                    {x.result && <div className="font-mono text-[10.5px] text-muted-foreground">{x.result}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardBody>
      )}
    </Card>
  );
}
