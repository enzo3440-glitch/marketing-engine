"use client";
import type { AdCampaign, AdCampaignStatus, MapNode } from "@engine/db/types";
import { CalendarPlus, ExternalLink, Pause, Play, RefreshCw, Send, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Select, Textarea, type Tone } from "@/components/ui";
import { creativesOf } from "@/lib/ad-creatives";
import { cn, fmt } from "@/lib/utils";

export interface PlanPostView { id: string; title: string; day: string; pillar: string; color: string; status: string; channel: string }
export interface ReelPick { job_id: string; variant_id: string; label: string; poster: string | null; picked: boolean }
export type MetaLinkView =
  | { status: "not_configured"; missing: string[] }
  | { status: "connected"; account: { name: string; currency: string; id: string }; adsManager: string }
  | { status: "error"; detail: string };

export const STATUS: Record<AdCampaignStatus, { label: string; tone: Tone; bar: string }> = {
  planned: { label: "Planned", tone: "outline", bar: "bg-muted text-foreground" },
  pending_approval: { label: "Waiting for approval", tone: "warning", bar: "bg-warning/20 text-foreground" },
  rejected: { label: "Rejected", tone: "danger", bar: "bg-destructive/15 text-destructive" },
  building: { label: "Building in Meta", tone: "warning", bar: "bg-warning/20 text-foreground" },
  ready: { label: "Built, starts on date", tone: "primary", bar: "bg-primary/15 text-primary" },
  live: { label: "Live", tone: "success", bar: "bg-success/20 text-success" },
  paused: { label: "Paused", tone: "outline", bar: "bg-muted text-muted-foreground line-through" },
  ended: { label: "Ended", tone: "outline", bar: "bg-muted text-muted-foreground" },
  failed: { label: "Failed", tone: "danger", bar: "bg-destructive/15 text-destructive" },
};
const CTAS = ["DOWNLOAD", "INSTALL_MOBILE_APP", "LEARN_MORE", "SIGN_UP", "USE_APP"];
const file = (job: string, n: string | null) => (n ? `/api/reels/files/${encodeURIComponent(job)}/${encodeURIComponent(n)}` : null);

export function CampaignCalendar({ campaigns, posts = [], concepts, strategy, reels, meta, days, today, offset, canApprove }: {
  campaigns: AdCampaign[]; posts?: PlanPostView[]; concepts: MapNode[]; strategy: string[]; reels: ReelPick[]; meta: MetaLinkView;
  days: string[]; today: string; offset: number; canApprove: boolean;
}) {
  const router = useRouter();
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = campaigns.find((c) => c.id === sel) ?? null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const schedule = (concept_id: string) => run(async () => setSel((await api<AdCampaign>("/api/ads/campaigns", { method: "POST", json: { concept_id } })).id));

  return (
    <div className="space-y-4">
      <MetaBanner meta={meta} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="xl:col-span-3">
          <CardHeader title={`Campaigns & planned posts · ${fmt.date(days[0])} – ${fmt.date(days[days.length - 1])}`} description="Desk-clock dates. Solid bars are Meta ad campaigns (click to edit); dashed chips are plan posts by pillar, untested until reviewed." action={
            <div className="flex gap-1 text-xs">
              <Link className="rounded border px-2 py-1" href={`?w=${offset - 4}`}>←</Link>
              <Link className="rounded border px-2 py-1" href="?w=0">Now</Link>
              <Link className="rounded border px-2 py-1" href={`?w=${offset + 4}`}>→</Link>
            </div>
          } />
          <div className="grid grid-cols-7 text-xs">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="border-b px-2 py-1.5 text-muted-foreground">{d}</div>)}
            {days.map((d) => {
              const on = campaigns.filter((c) => c.starts_on <= d && d <= c.ends_on);
              return (
                <div key={d} className={cn("min-h-[92px] border-b border-r p-1.5", d === today && "bg-primary/5")}>
                  <div className={cn("num mb-1 text-[11px]", d === today ? "font-semibold text-primary" : "text-muted-foreground")}>{Number(d.slice(8))}</div>
                  <div className="space-y-1">
                    {on.map((c) => (
                      <button key={c.id} onClick={() => setSel(c.id)} title={`${c.title} · ${STATUS[c.status].label}`}
                        className={cn("block w-full truncate rounded px-1 py-0.5 text-left text-[11px]", STATUS[c.status].bar, sel === c.id && "ring-1 ring-foreground/40")}>
                        {d === c.starts_on || d === days[0] ? c.title : " "}
                      </button>
                    ))}
                    {posts.filter((p) => p.day === d).map((p) => (
                      <Link key={p.id} href="/ideas" title={`${p.title} · ${p.status}`}
                        className={cn("block truncate rounded border border-dashed px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground", p.status !== "idea" && "border-solid")}
                        style={{ borderLeftColor: p.color, borderLeftWidth: 3, borderLeftStyle: "solid" }}>
                        {p.channel === "tiktok" ? "TT" : p.channel === "ig_paid" ? "Ad" : "IG"} · {p.title}
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <Card>
          <CardHeader title="Marketing plan · ad concepts" description="The Marketing Map's Instagram ad-only channel. Schedule one to put it on the calendar." />
          <CardBody className="space-y-3">
            {concepts.length ? concepts.map((n) => {
              const n2 = campaigns.filter((c) => c.concept_id === n.id).length;
              return (
                <div key={n.id} className="text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium leading-tight">{n.title}</span>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => schedule(n.id)}><CalendarPlus className="h-3.5 w-3.5" />Schedule</Button>
                  </div>
                  {n.hook && <p className="mt-0.5 text-xs">“{n.hook}”</p>}
                  {n.hypothesis && <p className="mt-0.5 text-[11px] text-muted-foreground">{n.hypothesis}</p>}
                  {n2 > 0 && <p className="mt-0.5 text-[11px] text-primary">{n2} on the calendar</p>}
                </div>
              );
            }) : <Empty>No ideas on the Marketing Map&apos;s ads channel yet.</Empty>}
            {strategy.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Strategy notes</summary>
                <ul className="mt-1 list-disc space-y-1 pl-4">{strategy.map((s) => <li key={s}>{s}</li>)}</ul>
              </details>
            )}
          </CardBody>
        </Card>
      </div>
      {current && <Editor key={current.id + current.updated_at} c={current} reels={reels} busy={busy} run={run} canApprove={canApprove} meta={meta} close={() => setSel(null)} />}
      {!current && campaigns.length > 0 && (
        <Card>
          <CardHeader title="All campaigns" />
          <CardBody className="divide-y p-0">
            {campaigns.map((c) => (
              <button key={c.id} onClick={() => setSel(c.id)} className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm hover:bg-accent">
                <span className="truncate">{c.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">{fmt.date(c.starts_on)} – {fmt.date(c.ends_on)} · {c.daily_budget}/day <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></span>
              </button>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export function MetaBanner({ meta }: { meta: MetaLinkView }) {
  if (meta.status === "connected") return (
    <p className="text-xs text-muted-foreground">
      <Badge tone="success">Meta connected</Badge> {meta.account.name} ({meta.account.id}, {meta.account.currency}) ·{" "}
      <a className="underline" href={meta.adsManager} target="_blank" rel="noreferrer">Ads Manager</a>
    </p>
  );
  if (meta.status === "error") return <p className="text-xs text-destructive"><Badge tone="danger">Meta error</Badge> {meta.detail}</p>;
  return (
    <p className="text-xs text-muted-foreground">
      <Badge tone="warning">Meta not connected</Badge> You can plan and approve campaigns, but nothing is built until {meta.missing.join(", ")} {meta.missing.length === 1 ? "is" : "are"} set in .env (restart the desk after).
    </p>
  );
}

function Editor({ c, reels, busy, run, canApprove, meta, close }: {
  c: AdCampaign; reels: ReelPick[]; busy: boolean; run: (fn: () => Promise<unknown>) => void; canApprove: boolean; meta: MetaLinkView; close: () => void;
}) {
  const [f, setF] = useState(c);
  const editable = ["planned", "rejected", "failed"].includes(c.status) && !c.meta.campaign_id;
  const set = <K extends keyof AdCampaign>(k: K, v: AdCampaign[K]) => setF((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(c);
  const save = () => api(`/api/ads/campaigns/${c.id}`, { method: "PATCH", json: f });
  const act = (action: string) => () => run(() => api(`/api/ads/campaigns/${c.id}`, { method: "POST", json: { action } }));
  const picks = creativesOf(f);
  const first = picks[0]?.job_id ? picks[0] : null;
  const many = picks.length > 1 || picks.some((x) => x.ig_media_id);
  const reel = first ? reels.find((r) => r.job_id === first.job_id && r.variant_id === first.variant_id) : null;
  const adsManager = meta.status === "connected" && c.meta.campaign_id ? `${meta.adsManager}&selected_campaign_ids=${c.meta.campaign_id}` : null;

  return (
    <Card>
      <CardHeader title={c.title} description={<span className="flex items-center gap-2"><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>{c.meta.error && <span className="text-destructive">{c.meta.error}</span>}</span>} action={
        <div className="flex flex-wrap gap-1.5">
          {editable && <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => run(save)}>Save</Button>}
          {["planned", "rejected"].includes(c.status) && <Button size="sm" disabled={busy} onClick={() => run(async () => { if (dirty) await save(); await api(`/api/ads/campaigns/${c.id}`, { method: "POST", json: { action: "submit" } }); })}><Send className="h-3.5 w-3.5" />Send for approval</Button>}
          {["ready", "live"].includes(c.status) && <Button size="sm" variant="outline" disabled={busy} onClick={act("pause")}><Pause className="h-3.5 w-3.5" />Pause</Button>}
          {c.status === "paused" && canApprove && <Button size="sm" disabled={busy} onClick={act("resume")}><Play className="h-3.5 w-3.5" />Resume</Button>}
          {c.status === "failed" && c.approval_id && canApprove && <Button size="sm" disabled={busy} onClick={act("build")}><RefreshCw className="h-3.5 w-3.5" />Retry build</Button>}
          {c.meta.campaign_id && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
            const r = await api<{ proposals?: unknown[]; notes?: string[] }>("/api/improve", { method: "POST", json: { kind: "campaign", id: c.id } });
            if (!r.proposals?.length) throw new Error(r.notes?.[0] ?? "No change suggested.");
            throw new Error("Proposal sent to Decide (Command page). It runs when you approve it.");
          })}><Sparkles className="h-3.5 w-3.5" />Improve</Button>}
          {adsManager && <a className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs" href={adsManager} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Ads Manager</a>}
          {!c.meta.campaign_id && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => { await api(`/api/ads/campaigns/${c.id}`, { method: "DELETE" }); close(); })}><Trash2 className="h-3.5 w-3.5" /></Button>}
          <Button size="sm" variant="ghost" onClick={close}>Close</Button>
        </div>
      } />
      <CardBody>
        {c.status === "pending_approval" && <p className="mb-3 text-xs text-muted-foreground">In the approvals queue (Command). Approving it builds everything in Meta, paused, and it switches on on {fmt.date(c.starts_on)}.</p>}
        <fieldset disabled={!editable || busy} className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-2">
            <Field label="Name"><Input value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Starts"><Input type="date" value={f.starts_on} onChange={(e) => set("starts_on", e.target.value)} /></Field>
              <Field label="Ends"><Input type="date" value={f.ends_on} onChange={(e) => set("ends_on", e.target.value)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Daily budget (${meta.status === "connected" ? meta.account.currency : "account currency"})`}><Input type="number" min={1} value={f.daily_budget} onChange={(e) => set("daily_budget", Number(e.target.value))} /></Field>
              <Field label="Goal">
                <Select value={f.objective} onChange={(e) => set("objective", e.target.value as AdCampaign["objective"])}>
                  <option value="traffic">Clicks to link</option><option value="app_installs">App installs</option><option value="awareness">Reach</option>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Countries"><Input value={f.countries.join(", ")} onChange={(e) => set("countries", e.target.value.toUpperCase().split(/[\s,]+/).filter(Boolean))} /></Field>
              <Field label="Age from"><Input type="number" value={f.age_min} onChange={(e) => set("age_min", Number(e.target.value))} /></Field>
              <Field label="to"><Input type="number" value={f.age_max} onChange={(e) => set("age_max", Number(e.target.value))} /></Field>
            </div>
          </div>
          <div className="space-y-2">
            <Field label="Primary text"><Textarea rows={5} value={f.primary_text} onChange={(e) => set("primary_text", e.target.value)} /></Field>
            <Field label="Headline"><Input value={f.headline} maxLength={40} onChange={(e) => set("headline", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Button"><Select value={f.cta} onChange={(e) => set("cta", e.target.value)}>{CTAS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ").toLowerCase()}</option>)}</Select></Field>
              <Field label="Link (https)"><Input value={f.link} placeholder="https://apps.apple.com/…" onChange={(e) => set("link", e.target.value)} /></Field>
            </div>
          </div>
          <div className="space-y-2">
{many ? (
              <Field label={`Videos · ${picks.length} ads`}>
                <ul className="space-y-0.5 text-xs">{picks.map((x) => <li key={x.key} className="truncate">{x.ig_media_id ? "IG post · " : ""}{x.label ?? x.variant_id}</li>)}</ul>
                <Link href="/launch" className="text-[11px] text-primary hover:underline">Change the videos on Launch → Campaigns</Link>
              </Field>
            ) : (
              <Field label="Reel (from the Video Engine gallery)">
                <Select value={first ? `${first.job_id}|${first.variant_id}` : ""} onChange={(e) => {
                  const r = reels.find((x) => `${x.job_id}|${x.variant_id}` === e.target.value);
                  set("creatives", r ? [{ key: `${r.job_id}|${r.variant_id}`, job_id: r.job_id, variant_id: r.variant_id, poster: r.poster }] : []);
                }}>
                  <option value="">Choose a reel…</option>
                  {reels.map((r) => <option key={`${r.job_id}|${r.variant_id}`} value={`${r.job_id}|${r.variant_id}`}>{r.picked ? "★ " : ""}{r.label}</option>)}
                </Select>
              </Field>
            )}
            {!many && first && (reel?.poster ?? first.poster) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="" className="max-h-64 rounded border" src={file(first.job_id!, reel?.poster ?? first.poster ?? null)!} />
            )}
            {!reels.length && <p className="text-xs text-muted-foreground">No finished reels yet. Render one in Content → Video Engine.</p>}
          </div>
        </fieldset>
        {Object.keys(c.meta).some((k) => k.endsWith("_id")) && (
          <p className="mt-3 text-[11px] text-muted-foreground">Meta: {["campaign_id", "adset_id", "ad_id", "video_id"].filter((k) => c.meta[k as keyof AdCampaign["meta"]]).map((k) => `${k.replace("_id", "")} ${c.meta[k as keyof AdCampaign["meta"]]}`).join(" · ")}</p>
        )}
      </CardBody>
    </Card>
  );
}

export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block space-y-1 text-xs"><span className="text-muted-foreground">{label}</span>{children}</label>
);
