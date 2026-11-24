"use client";
import type { AdCampaign, AdCreativePick, AdTrialPick } from "@engine/db/types";
import { Camera, ExternalLink, FlaskConical, Megaphone, Pause, Play, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Select, Textarea } from "@/components/ui";
import { creativesOf } from "@/lib/ad-creatives";
import type { ReadyVideo } from "@/lib/launch";
import type { IgPost } from "@/lib/meta-insights";
import { featureColor } from "@/lib/features";
import type { LaunchStructure } from "@/lib/waves";
import { cn, fmt } from "@/lib/utils";
import { Field, MetaBanner, STATUS, type MetaLinkView } from "../calendar/campaigns";

/**
 * Launch → Campaigns: several Meta ad campaigns, each with its settings and a picker over the desk's finished videos
 * and the Instagram feed. A desk video is either in the campaign (an ad) or sent to trial; feed posts can only be ads.
 * "Send for approval" puts the campaign in the approvals queue (built in Meta only once approved) and posts the trials.
 */

type Role = "ad" | "trial";
const CTAS = ["DOWNLOAD", "INSTALL_MOBILE_APP", "LEARN_MORE", "SIGN_UP", "USE_APP"];
const MAX_ADS = 30;
const FIELDS = ["title", "objective", "starts_on", "ends_on", "daily_budget", "countries", "age_min", "age_max", "primary_text", "headline", "cta", "link"] as const;
const fileUrl = (job: string, n: string | null | undefined) => (n ? `/api/reels/files/${encodeURIComponent(job)}/${encodeURIComponent(n)}` : undefined);
const vkey = (v: { job_id: string; variant_id: string }) => `${v.job_id}|${v.variant_id}`;
const thumbOf = (x: AdCreativePick) => (x.ig_media_id ? x.thumb ?? undefined : fileUrl(x.job_id!, x.poster));
const n = (x: number | null) => (x == null ? "—" : fmt.compact(x));

export function CampaignDesk({ campaigns, structures = {}, videos, posts, promoted, meta, cap, canApprove }: {
  campaigns: AdCampaign[]; structures?: Record<string, LaunchStructure>; videos: ReadyVideo[]; posts: IgPost[] | null; promoted: Record<string, string>; meta: MetaLinkView; cap: number; canApprove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(videos.map((v) => [vkey(v), v])), [videos]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "detail" in r) setMsg(String((r as { detail: string }).detail));
      router.refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const create = () => run(async () => setOpen((await api<AdCampaign>("/api/ads/campaigns", { method: "POST", json: { blank: true } })).id));
  const current = campaigns.find((c) => c.id === open) ?? null;

  return (
    <Card className="mb-3">
      <CardHeader title={`Campaigns${campaigns.length ? ` · ${campaigns.length}` : ""}`}
        description="Meta ad campaigns: pick desk videos and Instagram posts for the ads, send other videos to trial. Nothing is built in Meta until the approval is approved."
        action={<Button size="sm" onClick={create} disabled={busy}><Plus className="h-3.5 w-3.5" />New campaign</Button>} />
      <CardBody className="space-y-3">
        <MetaBanner meta={meta} />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {msg && <p className="text-xs text-primary">{msg}</p>}
        {!campaigns.length ? <Empty>No campaigns yet. Start one with New campaign.</Empty> : (
          <div className="divide-y rounded border">
            {campaigns.map((c) => {
              const ads = creativesOf(c), trials = c.trials ?? [];
              return (
                <button key={c.id} onClick={() => setOpen(open === c.id ? null : c.id)} className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent", open === c.id && "bg-accent/60")}>
                  <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                  <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
                  <span className="hidden items-center gap-1 sm:flex">
                    {ads.slice(0, 6).map((x) => <Thumb key={x.key} src={thumbOf(x)} ig={!!x.ig_media_id} />)}
                    {trials.slice(0, 4).map((t) => <Thumb key={t.key} src={fileUrl(t.job_id, t.poster)} trial />)}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {structures[c.id] && <span className="mr-1 rounded-sm bg-primary/10 px-1 text-primary">{structures[c.id].sets.length} features{structures[c.id].winners_open ? ` · ${structures[c.id].winners.filter((w) => !w.dropped).length} winners` : ""}</span>}
                    {ads.length} ad{ads.length === 1 ? "" : "s"}{trials.length ? ` · ${trials.length} trial` : ""} · {c.daily_budget}/day · {fmt.date(c.starts_on)} – {fmt.date(c.ends_on)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {current && <Builder key={current.id + current.updated_at} c={current} structure={structures[current.id] ?? null} videos={videos} byKey={byKey} posts={posts} promoted={promoted}
          meta={meta} cap={cap} canApprove={canApprove} busy={busy} run={run} close={() => setOpen(null)} />}
      </CardBody>
    </Card>
  );
}

function Thumb({ src, ig, trial }: { src?: string; ig?: boolean; trial?: boolean }) {
  return (
    <span className={cn("relative block h-9 w-6 overflow-hidden rounded-sm bg-muted", trial && "opacity-70 ring-1 ring-warning")}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />}
      {ig && <Camera className="absolute bottom-0 right-0 h-2.5 w-2.5 text-white drop-shadow" />}
    </span>
  );
}

function Builder({ c, structure, videos, byKey, posts, promoted, meta, cap, canApprove, busy, run, close }: {
  c: AdCampaign; structure: LaunchStructure | null; videos: ReadyVideo[]; byKey: Map<string, ReadyVideo>; posts: IgPost[] | null; promoted: Record<string, string>; meta: MetaLinkView;
  cap: number; canApprove: boolean; busy: boolean; run: (fn: () => Promise<unknown>) => void; close: () => void;
}) {
  const [f, setF] = useState(c);
  const set = <K extends keyof AdCampaign>(k: K, v: AdCampaign[K]) => setF((x) => ({ ...x, [k]: v }));
  // what's picked: key → in the campaign / sent to trial, plus what we know of picked Instagram posts
  const initial = useMemo(() => {
    const m = new Map<string, Role>();
    for (const x of creativesOf(c)) m.set(x.key, "ad");
    for (const t of c.trials ?? []) m.set(t.key, "trial");
    return m;
  }, [c]);
  const [picks, setPicks] = useState(initial);
  const [tab, setTab] = useState<"desk" | "ig">("desk");
  const igKnown = useMemo(() => {
    const m = new Map<string, AdCreativePick>();
    for (const x of creativesOf(c)) if (x.ig_media_id) m.set(x.key, x);
    for (const p of posts ?? []) m.set(`ig:${p.id}`, { key: `ig:${p.id}`, ig_media_id: p.id, label: p.caption.slice(0, 140) || `Instagram post ${p.id.slice(-6)}`, thumb: p.thumb, permalink: p.permalink });
    return m;
  }, [c, posts]);

  const editable = ["planned", "rejected", "failed"].includes(c.status) && !c.meta.campaign_id;
  const pick = (k: string, r: Role | null) => setPicks((s) => { const x = new Map(s); if (r) x.set(k, r); else x.delete(k); return x; });
  const adKeys = [...picks].filter(([, r]) => r === "ad").map(([k]) => k);
  const trialKeys = [...picks].filter(([, r]) => r === "trial").map(([k]) => k);
  const creatives = adKeys.map((k): Partial<AdCreativePick> => {
    if (k.startsWith("ig:")) { const x = igKnown.get(k); return { ig_media_id: k.slice(3), label: x?.label, thumb: x?.thumb ?? null, permalink: x?.permalink ?? null }; }
    const [job_id, variant_id] = k.split("|");
    return { job_id, variant_id };
  });
  const trials = trialKeys.map((k): Partial<AdTrialPick> => { const [job_id, variant_id] = k.split("|"); return { job_id, variant_id }; });
  const fieldsDirty = FIELDS.some((k) => JSON.stringify(f[k]) !== JSON.stringify(c[k]));
  const picksDirty = JSON.stringify([...picks].sort()) !== JSON.stringify([...initial].sort());
  const dirty = fieldsDirty || picksDirty;
  const fields = Object.fromEntries(FIELDS.map((k) => [k, f[k]]));
  const save = () => api(`/api/ads/campaigns/${c.id}`, { method: "PATCH", json: { ...fields, creatives, trials } });
  const act = (action: string) => () => run(() => api(`/api/ads/campaigns/${c.id}`, { method: "POST", json: { action } }));
  const unsentTrials = trialKeys.filter((k) => { const v = byKey.get(k); return !!v && (!v.launched || v.launch_status === "failed"); }).length; // not listed = already out
  const canSend = ["planned", "rejected"].includes(c.status) || (c.status === "pending_approval" && unsentTrials > 0 && !picksDirty);
  const sendLabel = adKeys.length
    ? `Send for approval${unsentTrials ? ` · post ${unsentTrials} trial reel${unsentTrials > 1 ? "s" : ""}` : ""}`
    : `Post ${unsentTrials} trial reel${unsentTrials === 1 ? "" : "s"}`;
  const adsManager = meta.status === "connected" && c.meta.campaign_id ? `${meta.adsManager}&selected_campaign_ids=${c.meta.campaign_id}` : null;
  const days = Math.max(1, Math.round((Date.parse(f.ends_on) - Date.parse(f.starts_on)) / 86400_000) + 1);
  const deskPicked = videos.filter((v) => picks.has(vkey(v))).length;
  const igPicked = adKeys.filter((k) => k.startsWith("ig:")).length;

  return (
    <div className="rounded border border-primary/40 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Megaphone className="h-4 w-4 text-primary" />
        <span className="font-medium">{c.title}</span>
        <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
        {c.meta.error && <span className="text-xs text-destructive">{c.meta.error}</span>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {editable && <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => run(save)}>Save</Button>}
          {canSend && (adKeys.length > 0 || unsentTrials > 0) && (
            <Button size="sm" disabled={busy || (!editable && dirty)} onClick={() => run(async () => { if (dirty && editable) await save(); return api(`/api/ads/campaigns/${c.id}`, { method: "POST", json: { action: "send" } }); })}>
              <Send className="h-3.5 w-3.5" />{sendLabel}
            </Button>
          )}
          {["ready", "live"].includes(c.status) && <Button size="sm" variant="outline" disabled={busy} onClick={act("pause")}><Pause className="h-3.5 w-3.5" />Pause</Button>}
          {c.status === "paused" && canApprove && <Button size="sm" disabled={busy} onClick={act("resume")}><Play className="h-3.5 w-3.5" />Resume</Button>}
          {c.status === "failed" && c.approval_id && canApprove && <Button size="sm" disabled={busy} onClick={act("build")}><RefreshCw className="h-3.5 w-3.5" />Retry build</Button>}
          {adsManager && <a className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs" href={adsManager} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Ads Manager</a>}
          {!c.meta.campaign_id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { await api(`/api/ads/campaigns/${c.id}`, { method: "DELETE" }); close(); })}><Trash2 className="h-3.5 w-3.5" /></Button>}
          <Button size="sm" variant="ghost" onClick={close}>Close</Button>
        </div>
      </div>
      {c.status === "pending_approval" && <p className="mb-3 text-xs text-muted-foreground">In the approvals queue. Approving it builds the campaign, its ad set and one ad per video in Meta, paused; it switches on on {fmt.date(c.starts_on)}.</p>}

      <fieldset disabled={!editable || busy} className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Field label="Name"><Input value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Starts"><Input type="date" value={f.starts_on} onChange={(e) => set("starts_on", e.target.value)} /></Field>
            <Field label="Ends"><Input type="date" value={f.ends_on} onChange={(e) => set("ends_on", e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={`Daily budget (${meta.status === "connected" ? meta.account.currency : "account currency"}) · cap ${cap}`}>
              <Input type="number" min={1} max={cap} value={f.daily_budget} onChange={(e) => set("daily_budget", Number(e.target.value))} />
            </Field>
            <Field label="Goal">
              <Select value={f.objective} onChange={(e) => set("objective", e.target.value as AdCampaign["objective"])}>
                <option value="traffic">Clicks to link</option><option value="app_installs">App installs</option><option value="awareness">Reach</option>
              </Select>
            </Field>
          </div>
          <p className={cn("text-[11px]", f.daily_budget > cap ? "text-destructive" : "text-muted-foreground")}>Up to {f.daily_budget * days} over {days} day{days > 1 ? "s" : ""}, shared by the campaign&apos;s ads.</p>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Countries"><Input value={f.countries.join(", ")} onChange={(e) => set("countries", e.target.value.toUpperCase().split(/[\s,]+/).filter(Boolean))} /></Field>
            <Field label="Age from"><Input type="number" value={f.age_min} onChange={(e) => set("age_min", Number(e.target.value))} /></Field>
            <Field label="to"><Input type="number" value={f.age_max} onChange={(e) => set("age_max", Number(e.target.value))} /></Field>
          </div>
        </div>
        <div className="space-y-2">
          <Field label="Primary text (desk videos; Instagram posts keep their own caption)"><Textarea rows={4} value={f.primary_text} onChange={(e) => set("primary_text", e.target.value)} /></Field>
          <Field label="Headline"><Input value={f.headline} maxLength={40} onChange={(e) => set("headline", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Button"><Select value={f.cta} onChange={(e) => set("cta", e.target.value)}>{CTAS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ").toLowerCase()}</option>)}</Select></Field>
            <Field label="Link (https)"><Input value={f.link} placeholder="https://apps.apple.com/…" onChange={(e) => set("link", e.target.value)} /></Field>
          </div>
        </div>
      </fieldset>

      {structure && <LaunchPlan s={structure} built={!!c.meta.campaign_id} stale={picksDirty || fieldsDirty} />}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="label">Videos</div>
        {(["desk", "ig"] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-sm border px-2.5 py-1 text-xs ${tab === k ? "border-primary bg-primary/10" : "text-muted-foreground hover:text-foreground"}`}>
            {k === "desk" ? `Desk videos · ${videos.length}${deskPicked ? ` (${deskPicked} picked)` : ""}` : `Instagram feed · ${posts?.length ?? 0}${igPicked ? ` (${igPicked} picked)` : ""}`}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          <span className={adKeys.length > MAX_ADS ? "text-destructive" : "text-foreground"}>{adKeys.length}</span> in the campaign (max {MAX_ADS}) · <span className="text-foreground">{trialKeys.length}</span> to trial
        </span>
      </div>
      <div className="mt-2 grid max-h-[460px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
        {tab === "desk" ? (!videos.length ? <Empty>No finished videos. Make one on Make.</Empty> : videos.map((v) => {
          const k = vkey(v), r = picks.get(k) ?? null;
          const out = !!v.launched && v.launch_status !== "failed";
          const lockedTrial = r === "trial" && out && (c.trials ?? []).some((t) => t.key === k); // already posted as this campaign's trial
          return (
            <PickCard key={k} thumb={fileUrl(v.job_id, v.poster)} title={v.title} active={!!r}
              sub={<>{v.made_by}{v.duration != null ? ` · ${Math.round(v.duration)}s` : ""}{v.launched && <Badge tone={v.launch_status === "failed" ? "danger" : v.launch_status === "live" ? "success" : "warning"} className="ml-1">{v.launched} · {v.launch_status}</Badge>}</>}>
              <Choice on={!r} disabled={!editable || lockedTrial} onClick={() => pick(k, null)}>—</Choice>
              <Choice on={r === "ad"} disabled={!editable || lockedTrial} onClick={() => pick(k, "ad")}><Megaphone className="h-3 w-3" />In the campaign</Choice>
              <Choice on={r === "trial"} disabled={!editable || (out && r !== "trial")} title={out && r !== "trial" ? `Already launched as ${v.launched}` : "Free · non-followers only · off your grid"} onClick={() => pick(k, "trial")}><FlaskConical className="h-3 w-3" />Send to trial</Choice>
            </PickCard>
          );
        })) : !posts ? <Empty>Instagram isn&apos;t connected (META_IG_USER_ID with the desk&apos;s Meta token), so the feed can&apos;t be listed.</Empty>
          : !posts.length ? <Empty>No posts in the feed.</Empty> : posts.map((p) => {
            const k = `ig:${p.id}`, on = picks.get(k) === "ad";
            const where = promoted[p.id];
            return (
              <PickCard key={k} thumb={p.thumb ?? undefined} title={p.caption.split("\n")[0] || "(no caption)"} active={on}
                sub={<>{fmt.date(p.at.slice(0, 10))} · {n(p.reach)} reach · {n(p.saves)} saves · {n(p.shares)} shares
                  {where && <Badge tone="primary" className="ml-1" title={where}>promoted</Badge>}
                  <a href={p.permalink} target="_blank" rel="noreferrer" className="ml-1 inline-flex text-primary" onClick={(e) => e.stopPropagation()}><ExternalLink className="h-3 w-3" /></a></>}>
                <Choice on={!on} disabled={!editable} onClick={() => pick(k, null)}>—</Choice>
                <Choice on={on} disabled={!editable} title={where ? `Already promoted: ${where}` : undefined} onClick={() => pick(k, "ad")}><Megaphone className="h-3 w-3" />In the campaign</Choice>
              </PickCard>
            );
          })}
      </div>
      {[...picks.keys()].some((k) => k.startsWith("ig:") && !posts?.some((p) => `ig:${p.id}` === k)) && (
        <p className="mt-2 text-[11px] text-muted-foreground">Also in the campaign: {adKeys.filter((k) => k.startsWith("ig:") && !posts?.some((p) => `ig:${p.id}` === k)).map((k) => igKnown.get(k)?.label?.split("\n")[0] ?? k).join(" · ")} (older posts, not in the feed list)</p>
      )}
      {Object.keys(c.meta.ads ?? {}).length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">Meta: campaign {c.meta.campaign_id} · {Object.values(c.meta.ads!).filter((x) => x.ad_id).length}/{creativesOf(c).length} ads built</p>
      )}
    </div>
  );
}

/** The launch as Meta campaigns: the feature test (one ad set per feature, who's live, who's waiting, how each reads) and Winners. */
function LaunchPlan({ s, built, stale }: { s: LaunchStructure; built: boolean; stale: boolean }) {
  const lab = (k: string) => s.labels[k] ?? k;
  const waiting = s.sets.reduce((n, g) => n + g.bench.length, 0);
  const winners = s.winners.filter((w) => !w.dropped);
  const p = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
  const VERDICT: Record<string, { text: string; cls: string }> = {
    leading: { text: "working", cls: "bg-success/15 text-success" }, behind: { text: "not yet", cls: "bg-destructive/10 text-destructive" },
    even: { text: "even", cls: "bg-muted text-muted-foreground" }, early: { text: "too early", cls: "bg-muted text-muted-foreground" },
  };
  const AdLine = ({ k, mark, dim }: { k: string; mark: string; dim?: boolean }) => {
    const r = s.reads?.[k];
    return (
      <li className={cn("grid grid-cols-[1fr_auto] gap-x-2", dim && "text-muted-foreground")} title={r?.next ?? lab(k)}>
        <span className="truncate">{mark} {lab(k)}</span>
        {r && r.impressions > 0 && <span className="font-mono text-[10.5px] text-muted-foreground">{fmt.compact(r.impressions)} · {p(r.hook, 0)} · {p(r.ctr, 2)}</span>}
        {r?.next && !dim && <span className="col-span-2 truncate text-[10.5px] text-muted-foreground">{r.status} · {r.next}</span>}
      </li>
    );
  };
  return (
    <div className="mt-4 rounded border bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <div className="label">Launch structure</div>
        <span className="text-[11px] text-muted-foreground">{built ? "in Meta now" : stale ? "as last saved (save to update)" : "what approval builds"} · {s.total}/day in all, never more</span>
      </div>
      {s.insights && s.insights.length > 0 && (
        <div className="mt-2 rounded border bg-background p-2">
          <div className="mb-1 text-xs font-medium">What&apos;s working, what isn&apos;t</div>
          <ul className="space-y-0.5 text-[11.5px]">{s.insights.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
      <div className="mt-2 grid gap-2 lg:grid-cols-[1fr_280px]">
        <div className="rounded border bg-background p-2">
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="font-medium">1 · Feature test <span className="font-normal text-muted-foreground">(one ad set per feature, so each gets its own read)</span></span>
            <span className="font-mono text-[11px] text-muted-foreground">{s.sets.filter((g) => !g.retired).length} ad sets · {s.sets.find((g) => !g.retired)?.daily ?? 0}/day each{waiting ? ` · ${waiting} waiting` : ""}</span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {s.sets.map((g) => {
              const r = s.set_reads?.[g.feature];
              return (
                <div key={g.feature} className={cn("rounded border p-1.5 text-[11px]", g.retired && "opacity-50")} style={{ borderLeft: `3px solid ${featureColor(g.feature)}` }}>
                  <div className="flex items-center justify-between gap-1 font-medium">
                    <span>{g.name}</span>
                    {g.retired ? <span className="text-muted-foreground">retired</span> : r && <span className={cn("rounded-sm px-1 text-[10px] font-normal", VERDICT[r.verdict].cls)}>{VERDICT[r.verdict].text}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 text-muted-foreground">
                    <span className="text-foreground">{g.live.length} live</span>
                    {g.bench.length > 0 && <span>· {g.bench.length} waiting</span>}
                    {g.won.length > 0 && <span className="text-success">· {g.won.length} to Winners</span>}
                    {g.out.length > 0 && <span>· {g.out.length} out</span>}
                  </div>
                  {r && r.impressions > 0 && (
                    <div className="mt-1 grid grid-cols-4 gap-1 rounded bg-muted/40 p-1 text-center font-mono text-[10.5px]">
                      <div><div className="text-muted-foreground">seen</div>{fmt.compact(r.impressions)}</div>
                      <div><div className="text-muted-foreground">opening</div>{p(r.hook, 0)}</div>
                      <div><div className="text-muted-foreground">click</div>{p(r.ctr, 2)}</div>
                      <div><div className="text-muted-foreground">installs</div>{r.installs}{r.cpi != null ? ` · ${r.cpi.toFixed(2)}` : ""}</div>
                    </div>
                  )}
                  {r && <p className="mt-0.5 text-[10.5px] text-muted-foreground">{r.why} Spent {r.spend.toFixed(2)} {s.currency ?? ""}.</p>}
                  <ul className="mt-1 space-y-0.5">
                    {g.live.map((k) => <AdLine key={k} k={k} mark="▸" />)}
                    {g.won.map((k) => <AdLine key={k} k={k} mark="★" />)}
                    {g.bench.map((k) => <AdLine key={k} k={k} mark="◦" dim />)}
                    {g.out.map((k) => <AdLine key={k} k={k} mark="×" dim />)}
                  </ul>
                </div>
              );
            })}
          </div>
          {built && <p className="mt-1 text-[10.5px] text-muted-foreground">Per ad: impressions · opening (3-second views per impression) · click-through. ▸ live · ★ moved to Winners · ◦ waiting · × out. Hover an ad for the optimizer&apos;s next step.</p>}
        </div>
        <div className="rounded border bg-background p-2 text-[11px]">
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="font-medium">2 · Winners</span>
            <span className="font-mono text-[11px] text-muted-foreground">{s.winners_open ? `${s.winners_daily}/day · Meta spreads it` : "not open yet"}</span>
          </div>
          {s.winners_read && s.winners_read.impressions > 0 && (
            <div className="mb-1 grid grid-cols-3 gap-1 rounded bg-muted/40 p-1 text-center font-mono text-[10.5px]">
              <div><div className="text-muted-foreground">seen</div>{fmt.compact(s.winners_read.impressions)}</div>
              <div><div className="text-muted-foreground">click</div>{p(s.winners_read.ctr, 2)}</div>
              <div><div className="text-muted-foreground">installs</div>{s.winners_read.installs}</div>
            </div>
          )}
          {winners.length ? (
            <ul className="space-y-0.5">{winners.map((w) => <li key={w.key} className="truncate">★ {w.label} <span className="font-mono text-muted-foreground">{(w.ctr * 100).toFixed(2)}% CTR</span></li>)}</ul>
          ) : <p className="text-muted-foreground">Opens when two test ads prove themselves; they move here, the next ads take their test slots, and this campaign gets 50-70% of the budget.</p>}
          {s.winners.some((w) => w.dropped) && <p className="mt-1 text-muted-foreground">{s.winners.filter((w) => w.dropped).length} dropped after wearing out.</p>}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{s.rule} Runs with live optimize on.</p>
      {s.log.length > 0 && <ul className="mt-1 space-y-0.5 text-[11px]">{s.log.slice(0, 5).map((l, i) => <li key={i}><span className="font-mono text-muted-foreground">{fmt.date(l.at.slice(0, 10))}</span> {l.text}</li>)}</ul>}
    </div>
  );
}

function PickCard({ thumb, title, sub, active, children }: { thumb?: string; title: string; sub: React.ReactNode; active: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex gap-2 rounded border p-2", active && "border-primary/60 bg-primary/5")}>
      <div className="w-14 shrink-0 overflow-hidden rounded bg-muted" style={{ aspectRatio: "9 / 16" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[12px] font-medium leading-snug">{title}</div>
        <div className="mt-0.5 flex flex-wrap items-center text-[10.5px] text-muted-foreground">{sub}</div>
        <div className="mt-1.5 flex flex-wrap gap-1">{children}</div>
      </div>
    </div>
  );
}

function Choice({ on, disabled, title, onClick, children }: { on: boolean; disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" disabled={disabled} title={title} onClick={onClick}
      className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50", on ? "border-primary bg-primary/10" : "hover:bg-accent")}>
      {children}
    </button>
  );
}
