"use client";
// Marketing Advisor desk: momentum with abstention, campaign ideation, evidence-checked
// recommendations, and the editorial readiness rubric with frozen scores in the ledger.
import type { Recommendation } from "@engine/advisor";
import { CRITERIA, readiness, type Criterion } from "@engine/advisor/core";
import { EMOTIONS, type CampaignDraft } from "@engine/advisor/ideation";
import { Clapperboard, Copy, Loader2, Lock, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Select, Table, Td, Textarea, Th } from "@/components/ui";
import { cn, fmt } from "@/lib/utils";

interface PostRow { id: string; title: string; url: string | null; postedAt: string | null; views: number | null; nObs: number; label: string; reason: string; rate: number | null }
interface LedgerEvent { id: string; type: string; revision: number; payload: Record<string, unknown>; recorded_at: string }

const CRITERIA_LABEL: Record<Criterion, string> = { hook: "Hook", clarity: "Clarity", discoveryPayoff: "Discovery payoff", brandFit: "Brand fit", actionBridge: "Action bridge" };

export function AdvisorDesk({ status, posts, ideas, ledger: initialLedger }: {
  status: { provider: string; evidence: string; ledger: string; canSpend: boolean; canPublish: boolean };
  posts: PostRow[]; ideas: { id: string; title: string; hook: string; channel: string }[]; ledger: { revision: number; events: LedgerEvent[] };
}) {
  const router = useRouter();
  const connected = status.provider !== "unconnected";
  const [evidence, setEvidence] = useState<string[]>(posts.filter((p) => p.rate != null).slice(0, 5).map((p) => p.id));
  const [note, setNote] = useState<string | null>(null);
  const flash = (t: string) => { setNote(t); setTimeout(() => setNote(null), 3000); };
  const sendHook = async (text: string) => {
    const h = await api<{ id: string; existed: boolean }>("/api/reels/hooks", { method: "POST", json: { text, source: "claude", framework: "advisor" } });
    flash(h.existed ? `Already in the hook pool as ${h.id}.` : `Added to the Reel Engine hook pool as ${h.id}.`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Sparkles className="h-4 w-4" />
        <span className="font-medium">Marketing Advisor</span>
        <Badge tone={connected ? "success" : "warning"}>model {connected ? "connected" : "unconnected"}</Badge>
        <Badge tone="success">evidence: own posts</Badge>
        <Badge tone="success">ledger rev {initialLedger.revision}</Badge>
        <Badge tone="outline"><Lock className="h-3 w-3" />cannot spend or publish</Badge>
        <span className="text-xs text-muted-foreground">{connected ? "Proposals are drafts for review." : "Set ANTHROPIC_API_KEY for generation; until then ideation returns a copyable prompt."}</span>
        {note && <span className="ml-auto text-xs text-primary">{note}</span>}
      </div>

      <Card>
        <CardHeader title="Observed view momentum" description="Views/hour between repeat measurements of the same post. Abstains when evidence is thin, stale, rounded or incompatible. Descriptive only: not viral probability or attributed acquisition." />
        <Table>
          <thead><tr><Th className="w-8" /><Th>Post</Th><Th>Posted</Th><Th className="text-right">Views</Th><Th className="text-right">Measurements</Th><Th className="text-right">Views / hr</Th><Th>Read</Th></tr></thead>
          <tbody>{posts.slice(0, 25).map((p) => (
            <tr key={p.id}>
              <Td><input type="checkbox" aria-label={`Use ${p.title} as evidence`} checked={evidence.includes(p.id)} onChange={(e) => setEvidence((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} /></Td>
              <Td className="max-w-xs"><a href={p.url ?? undefined} target="_blank" rel="noreferrer" className="block truncate hover:underline">{p.title}</a></Td>
              <Td className="whitespace-nowrap text-xs text-muted-foreground">{fmt.date(p.postedAt)}</Td>
              <Td className="num text-right">{fmt.compact(p.views)}</Td>
              <Td className="num text-right">{p.nObs}</Td>
              <Td className="num text-right">{p.rate == null ? "—" : fmt.num(p.rate, 1)}</Td>
              <Td><span className={cn("text-xs", p.rate != null ? "text-success" : "text-muted-foreground")} title={p.reason}>{p.label}</span><div className="text-[11px] text-muted-foreground">{p.reason}</div></Td>
            </tr>
          ))}</tbody>
        </Table>
        <p className="px-4 py-2 text-[11px] text-muted-foreground">{evidence.length} posts checked as evidence for ideation and recommendations below.</p>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Ideation evidence={evidence} onHook={sendHook} onCopy={(t, m) => navigator.clipboard.writeText(t).then(() => flash(m))} />
        <Recommend evidence={evidence} connected={connected} />
      </div>

      <ReadinessScorer ideas={ideas} ledger={initialLedger} onSaved={() => router.refresh()} />
    </div>
  );
}

function Ideation({ evidence, onHook, onCopy }: { evidence: string[]; onHook: (t: string) => void; onCopy: (t: string, msg: string) => void }) {
  const [ctx, setCtx] = useState({ audience: "curious travelers planning Oahu", objective: "qualified app activations", channel: "instagram_public", emotion: "awe", tension: "Everyone follows the same recommendations", proof: "" });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ status: string; campaigns: CampaignDraft[]; prompt?: string } | null>(null);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof ctx) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setCtx({ ...ctx, [k]: e.target.value });

  async function run() {
    setBusy(true); setErr("");
    try { setRes(await api("/api/advisor", { method: "POST", json: { action: "ideate", context: { ...ctx, proof: ctx.proof || "No verified product proof supplied" }, evidenceIds: evidence } })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  // Campaign → Marketing Map proposal JSON (paste into Map → Brainstorm → Review → Apply).
  const asMapProposal = (c: CampaignDraft) => JSON.stringify({ nodes: [{
    id: `adv-${c.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`, channel: ctx.channel.startsWith("tiktok") ? "tiktok" : ctx.channel.includes("ad") ? "ads" : "instagram",
    title: c.title, hook: c.hook, visual: c.shotBeats.join(" → "), audio: "", overlay: c.emotionalHook, cta: `${c.appProof} ${c.CTA}`.trim(),
    hypothesis: `${c.hypothesis} Metric: ${c.primaryMetric}. Low-cost test: ${c.lowCostTest}. Disconfirming: ${c.disconfirmingResult}`, note: c.guardrails.join(" "),
  }], edges: [] }, null, 2);

  return (
    <Card>
      <CardHeader title="Campaign ideation" description="Original concepts with emotional driver, app proof, belonging cue, a low-cost test and a disconfirming result." />
      <CardBody className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Input value={ctx.audience} onChange={set("audience")} placeholder="Audience" />
          <Input value={ctx.objective} onChange={set("objective")} placeholder="Objective" />
          <Select value={ctx.channel} onChange={set("channel")}><option value="instagram_public">Instagram page</option><option value="instagram_ad_only">Instagram ad-only</option><option value="tiktok">TikTok</option></Select>
          <Select value={ctx.emotion} onChange={set("emotion")}>{EMOTIONS.map((e) => <option key={e}>{e}</option>)}</Select>
        </div>
        <Input value={ctx.tension} onChange={set("tension")} placeholder="Audience tension" />
        <Textarea rows={2} value={ctx.proof} onChange={set("proof")} placeholder="Verified product proof (only real, shipped app features)" />
        <div className="flex justify-end"><Button onClick={run} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Ideate</Button></div>
        {err && <p className="text-xs text-destructive">{err}</p>}
        {res?.status === "unconnected" && res.prompt && (
          <div className="rounded-md bg-muted/50 p-3 text-xs">
            <p className="mb-2 text-muted-foreground">No model connected. Copy this prompt into any assistant, then paste results into the Marketing Map&apos;s Brainstorm review.</p>
            <Button size="sm" variant="outline" onClick={() => onCopy(res.prompt!, "Ideation prompt copied")}><Copy className="h-3.5 w-3.5" />Copy prompt</Button>
          </div>
        )}
        {res?.campaigns.map((c) => (
          <div key={c.title} className="rounded-md border p-3 text-xs">
            <div className="flex items-start justify-between gap-2"><div className="text-sm font-medium">{c.title}</div><Badge tone="warning">draft · review</Badge></div>
            <p className="mt-1 italic">“{c.hook}”</p>
            <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-muted-foreground">
              <dt>Tension</dt><dd className="text-foreground">{c.audienceTension}</dd>
              <dt>Promise</dt><dd className="text-foreground">{c.differentiatedPromise}</dd>
              <dt>App proof</dt><dd className="text-foreground">{c.appProof}</dd>
              <dt>Belonging</dt><dd className="text-foreground">{c.belongingCue}</dd>
              <dt>Shots</dt><dd className="text-foreground">{c.shotBeats.join(" → ")}</dd>
              <dt>Test</dt><dd className="text-foreground">{c.lowCostTest} · metric {c.primaryMetric}</dd>
              <dt>Disconfirms</dt><dd className="text-foreground">{c.disconfirmingResult}</dd>
              <dt>Guardrails</dt><dd className="text-foreground">{c.guardrails.join("; ")}</dd>
            </dl>
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onHook(c.hook)}><Clapperboard className="h-3.5 w-3.5" />Hook → engine</Button>
              <Button size="sm" variant="outline" onClick={() => onCopy(asMapProposal(c), "Map proposal copied: paste into Marketing Map → Brainstorm")}><Copy className="h-3.5 w-3.5" />Copy as map proposal</Button>
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function Recommend({ evidence, connected }: { evidence: string[]; connected: boolean }) {
  const [task, setTask] = useState("recommend");
  const [ask, setAsk] = useState("What should we post next week to grow qualified follows?");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ status: string; recommendations: Recommendation[]; next?: string } | null>(null);
  const [err, setErr] = useState("");
  return (
    <Card>
      <CardHeader title="Recommendations" description="Each recommendation must cite checked evidence. A growth claim without measured view growth is downgraded to hypothesis." />
      <CardBody className="space-y-2 text-sm">
        <div className="flex gap-2">
          <Select value={task} onChange={(e) => setTask(e.target.value)}><option value="recommend">Recommend</option><option value="brainstorm">Brainstorm</option><option value="channel_plan">Channel plan</option></Select>
          <Input value={ask} onChange={(e) => setAsk(e.target.value)} />
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setErr("");
            try { setRes(await api("/api/advisor", { method: "POST", json: { action: "propose", task, context: { ask }, evidenceIds: evidence } })); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ask"}</Button>
        </div>
        {err && <p className="text-xs text-destructive">{err}</p>}
        {res?.status === "unconnected" && <Empty>{connected ? "" : "Model unconnected. "}{res.next}</Empty>}
        {res?.recommendations.map((r, i) => (
          <div key={i} className="rounded-md border p-3 text-xs">
            <div className="flex items-start justify-between gap-2"><span className="text-sm font-medium">{r.title}</span><Badge tone={r.signal === "observed_growth" ? "success" : r.signal === "fresh_baseline" ? "primary" : "outline"}>{r.signal.replace("_", " ")}</Badge></div>
            <p className="mt-1">{r.action}</p>
            {r.evidenceIds.length > 0 && <p className="mt-1 text-muted-foreground">Evidence: {r.evidenceIds.join(", ")}</p>}
            {r.validationNote && <p className="mt-1 text-warning">{r.validationNote}</p>}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function ReadinessScorer({ ideas, ledger, onSaved }: { ideas: { id: string; title: string; hook: string; channel: string }[]; ledger: { revision: number; events: LedgerEvent[] }; onSaved: () => void }) {
  const [ideaId, setIdeaId] = useState(ideas[0]?.id ?? "");
  const [stage, setStage] = useState<"idea" | "video">("idea");
  const [fullReview, setFullReview] = useState(false);
  const [crit, setCrit] = useState<Record<Criterion, { value: number; rationale: string }>>(() => Object.fromEntries(CRITERIA.map((k) => [k, { value: 2, rationale: "" }])) as Record<Criterion, { value: number; rationale: string }>);
  const [msg, setMsg] = useState<string | null>(null);
  const result = useMemo(() => readiness({ stage, criteria: crit, inspection: stage === "video" ? { depth: fullReview ? "full_audiovisual" : "none", completed: fullReview } : undefined }), [stage, crit, fullReview]);
  const idea = ideas.find((i) => i.id === ideaId);

  async function freeze() {
    try {
      await api("/api/advisor", { method: "POST", json: { action: "feedback", expectedRevision: ledger.revision, event: { id: `score-${ideaId}-${Date.now()}`, type: "score", ideaId, stage, result, criteria: crit } } });
      setMsg("Score frozen to the ledger.");
      onSaved();
    } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <Card>
      <CardHeader title="Readiness rubric" description="Equal-weight editorial checklist (0-4 per criterion, rationale required). Not a performance prediction. Video scores require an attested full audiovisual review." />
      <CardBody className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="flex flex-wrap gap-2">
            <Select value={ideaId} onChange={(e) => setIdeaId(e.target.value)} className="max-w-sm">{ideas.map((i) => <option key={i.id} value={i.id}>{i.channel} · {i.title}</option>)}</Select>
            <Select value={stage} onChange={(e) => setStage(e.target.value as "idea")}><option value="idea">Idea (before footage)</option><option value="video">Video (rendered)</option></Select>
            {stage === "video" && <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={fullReview} onChange={(e) => setFullReview(e.target.checked)} />I watched the full video with audio</label>}
          </div>
          {idea && <p className="text-xs italic text-muted-foreground">“{idea.hook}”</p>}
          {CRITERIA.map((k) => (
            <div key={k} className="grid grid-cols-[130px_150px_1fr] items-center gap-2 text-xs">
              <span>{CRITERIA_LABEL[k]}</span>
              <input type="range" min={0} max={4} step={1} value={crit[k].value} onChange={(e) => setCrit({ ...crit, [k]: { ...crit[k], value: Number(e.target.value) } })} aria-label={CRITERIA_LABEL[k]} />
              <Input className="h-7 text-xs" placeholder="Rationale (8+ chars)" value={crit[k].rationale} onChange={(e) => setCrit({ ...crit, [k]: { ...crit[k], rationale: e.target.value } })} />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">{result.kind.replace("_", " ")} · {result.rubricVersion}</div>
            <div className="num text-3xl font-semibold">{result.score ?? "—"}</div>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-muted-foreground">{result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
          <Button className="w-full" variant="outline" disabled={result.score == null} onClick={freeze}><Lock className="h-3.5 w-3.5" />Freeze score to ledger</Button>
          {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
          <div className="text-xs">
            <div className="mb-1 font-medium">Ledger · rev {ledger.revision}</div>
            {ledger.events.length ? [...ledger.events].reverse().slice(0, 6).map((e) => (
              <div key={e.id} className="flex justify-between border-t py-1"><span>{e.type} · {String(e.payload.ideaId ?? e.payload.creativeId ?? "")}</span><span className="text-muted-foreground">{fmt.ago(e.recorded_at)}</span></div>
            )) : <p className="text-muted-foreground">No events yet. Scores are frozen before outcomes so they can be checked later.</p>}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
