"use client";
// Marketing Map, ported from a marketing whiteboard: same layout, brief, validation and
// review-before-apply brainstorm, now saved to ops.marketing_maps with revision checks.
import type { MapNode, MarketingMap, MarketingMapDoc } from "@engine/db/types";
import { Clapperboard, Copy, Download, Link2, Minus, Pencil, Plus, Sparkles, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, Input, Select, Textarea } from "@/components/ui";
import { brainstormPrompt, NODE_FIELDS, productionBrief, reviewProposal, validateMap } from "@/lib/marketing-map";
import { cn } from "@/lib/utils";

const BRANCH = [{ x: 350, y: 420 }, { x: 1050, y: 420 }, { x: 700, y: 740 }];
const TAG: Record<string, string> = { ads: "App acquisition", tiktok: "Culture + contrast", instagram: "Discovery + belonging" };
const LABEL: Record<(typeof NODE_FIELDS)[number], string> = {
  title: "Idea name", hook: "Hook", visual: "Visual / shot progression", audio: "Audio direction", overlay: "On-screen text",
  cta: "App proof / call to action", hypothesis: "What are we testing?", note: "Guardrail / note",
};

function layout(doc: MarketingMapDoc) {
  const pos: Record<string, { x: number; y: number }> = {};
  doc.channels.forEach((c, ci) => {
    doc.nodes.filter((n) => n.channel === c.id).forEach((n, i) => {
      pos[n.id] = ci === 0 ? { x: i % 2 === 0 ? 60 : 300, y: 100 + Math.floor(i / 2) * 94 }
        : ci === 1 ? { x: i % 2 === 0 ? 930 : 1170, y: 100 + Math.floor(i / 2) * 94 }
        : { x: 280 + (i % 4) * 235, y: 825 + Math.floor(i / 4) * 90 };
    });
  });
  return pos;
}

export function MarketingMapBoard({ initial, brainstormEnabled }: { initial: MarketingMap; brainstormEnabled: boolean }) {
  const [map, setMap] = useState(initial);
  const doc = map.doc;
  const [selected, setSelected] = useState("root");
  const [state, setState] = useState("Saved");
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState<MapNode | null>(null);
  const [dialog, setDialog] = useState<null | "brainstorm" | "links">(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const pos = useMemo(() => layout(doc), [doc]);

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2500); };
  const copy = async (t: string, msg = "Copied. Ready for your video engine.") => { await navigator.clipboard.writeText(t); flash(msg); };

  async function persist(next: MarketingMapDoc) {
    validateMap(next);
    setState("Saving…");
    try {
      const saved = await api<MarketingMap>("/api/marketing-map", { method: "PUT", json: { map: next, expectedRevision: map.revision } });
      setMap(saved);
      setState("Saved");
    } catch (e) {
      const err = e as Error & { status?: number; data?: { current?: MarketingMap } };
      setState("Not saved");
      if (err.status === 409 && err.data?.current) {
        setMap(err.data.current);
        throw new Error("Someone else saved first. The latest map is loaded; reapply your change.");
      }
      throw err;
    }
  }
  async function sendHook(n: MapNode) {
    const h = await api<{ id: string; existed: boolean }>("/api/reels/hooks", { method: "POST", json: { text: n.hook, source: "map", framework: n.channel } });
    flash(h.existed ? `Already in the hook pool as ${h.id}.` : `Added to the Reel Engine hook pool as ${h.id}.`);
  }

  const node = doc.nodes.find((n) => n.id === selected);
  const channel = doc.channels.find((c) => c.id === selected);
  const t = `translate(${pan.x} ${pan.y}) translate(700 525) scale(${zoom}) translate(-700 -525)`;

  return (
    <div className="relative">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{state} · rev {map.revision}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setDialog("brainstorm")}><Sparkles className="h-3.5 w-3.5" />Brainstorm</Button>
          <Button size="sm" variant="outline" onClick={() => setEditing({ id: "", channel: "instagram", title: "", hook: "" })}><Plus className="h-3.5 w-3.5" />Add idea</Button>
          <Button size="sm" variant="outline" onClick={() => file.current?.click()}><Upload className="h-3.5 w-3.5" />Import</Button>
          <Button size="sm" variant="outline" onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
            a.download = "marketing-map.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}><Download className="h-3.5 w-3.5" />Export</Button>
          <input ref={file} type="file" accept="application/json" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              if (f.size > 250000) throw Error("Map file is too large.");
              const next = JSON.parse(await f.text()) as MarketingMapDoc;
              if (!Array.isArray(next.nodes)) throw Error("Not a marketing map.");
              if (!confirm(`Replace this map with ${next.nodes.length} imported ideas? Export the current map first if you want a backup.`)) return;
              await persist(next);
              flash("Imported map saved");
            } catch (err) { flash((err as Error).message); }
          }} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="relative h-[640px] overflow-hidden bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:24px_24px]">
          <div className="pointer-events-none absolute left-5 top-4 z-[1]">
            <div className="text-[10px] uppercase tracking-[2px] text-muted-foreground">One belief. Three ways in.</div>
            <div className="mt-1 text-lg font-medium">Change how people travel.</div>
          </div>
          <svg ref={svg} viewBox="0 0 1400 1050" className="h-full w-full cursor-grab touch-none active:cursor-grabbing" role="img" aria-label="Marketing mind map"
            onPointerDown={(e) => { if ((e.target as Element).closest("button")) return; drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; svg.current?.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { if (!drag.current || !svg.current) return; const r = 1400 / svg.current.getBoundingClientRect().width; setPan({ x: drag.current.px + (e.clientX - drag.current.x) * r, y: drag.current.py + (e.clientY - drag.current.y) * r }); }}
            onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)}>
            <g transform={t}>
              {doc.channels.map((c, ci) => {
                const q = BRANCH[ci];
                return (
                  <g key={c.id}>
                    <path d={`M700 540 Q${q.x} 540 ${q.x} ${q.y}`} fill="none" stroke={c.color} strokeWidth={2.5} opacity={0.52} />
                    {doc.nodes.filter((n) => n.channel === c.id).map((n) => { const p = pos[n.id]; return <path key={n.id} d={`M${q.x} ${q.y} Q${q.x} ${p.y + 80} ${p.x + 100} ${p.y + 40}`} fill="none" stroke={c.color} strokeWidth={1.3} opacity={0.27} />; })}
                  </g>
                );
              })}
              {(doc.edges ?? []).map((e, i) => { const a = pos[e.from], b = pos[e.to]; return a && b ? <path key={i} d={`M${a.x + 100} ${a.y + 38} L${b.x + 100} ${b.y + 38}`} stroke="hsl(var(--foreground))" strokeDasharray="5 5" opacity={0.3} /> : null; })}
              {doc.nodes.map((n) => {
                const p = pos[n.id], c = doc.channels.find((x) => x.id === n.channel)!;
                return (
                  <foreignObject key={n.id} x={p.x} y={p.y} width={205} height={76}>
                    <button onClick={() => setSelected(n.id)} className={cn("h-full w-full rounded-[11px] border bg-card px-3.5 py-3 text-left transition hover:-translate-y-px hover:bg-accent", selected === n.id && "border-foreground/60 bg-accent")} style={{ borderLeft: `3px solid ${c.color}` }}>
                      <span className="mb-1.5 block text-[9px] uppercase tracking-[1.1px] opacity-70">{TAG[c.id] ?? c.title}</span>
                      <strong className="line-clamp-2 block text-[13px] font-semibold leading-tight">{n.title}</strong>
                    </button>
                  </foreignObject>
                );
              })}
              {doc.channels.map((c, ci) => {
                const q = BRANCH[ci];
                return (
                  <foreignObject key={c.id} x={q.x - 115} y={q.y - 48} width={230} height={96}>
                    <button onClick={() => setSelected(c.id)} className="h-full w-full rounded-[11px] px-5 py-4 text-left text-[#17211a]" style={{ background: c.color }}>
                      <span className="block text-[9px] uppercase tracking-[1.1px] opacity-70">{c.subtitle}</span>
                      <strong className="block text-[19px] font-semibold tracking-tight">{c.title}</strong>
                      <small className="mt-1 block text-[11px]">{c.tone}</small>
                    </button>
                  </foreignObject>
                );
              })}
              <foreignObject x={600} y={445} width={200} height={190}>
                <button onClick={() => setSelected("root")} className="flex h-full w-full flex-col items-center justify-center rounded-full bg-[#edf0df] p-6 text-center text-[#14211a]">
                  <span className="text-[9px] uppercase tracking-[2px]">The belief</span>
                  <strong className="text-[27px] font-bold tracking-tight">YOUR IDEA.</strong>
                  <small className="mt-2 text-[10px]">Less noise.<br />More story.</small>
                </button>
              </foreignObject>
            </g>
          </svg>
          <div className="absolute bottom-4 left-4 flex gap-1.5">
            <Button size="icon" variant="outline" onClick={() => setZoom((z) => Math.max(0.45, z - 0.2))} aria-label="Zoom out"><Minus className="h-4 w-4" /></Button>
            <Button size="icon" variant="outline" onClick={() => setZoom((z) => Math.min(2.5, z + 0.2))} aria-label="Zoom in"><Plus className="h-4 w-4" /></Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Fit map</Button>
          </div>
        </Card>

        <Card className="max-h-[640px] overflow-y-auto p-5 text-sm">
          {node ? (() => {
            const ch = doc.channels.find((c) => c.id === node.channel)!;
            return (
              <>
                <Badge tone="outline">{ch.title}</Badge>
                <h2 className="mt-3 text-xl font-medium tracking-tight">{node.title}</h2>
                <p className="mt-2 text-lg leading-snug">“{node.hook}”</p>
                <Button className="mt-4 w-full" onClick={() => copy(productionBrief(doc, node))}><Copy className="h-4 w-4" />Copy production brief</Button>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => setEditing(node)}><Pencil className="h-3.5 w-3.5" />Edit idea</Button>
                  <Button variant="outline" onClick={() => sendHook(node)}><Clapperboard className="h-3.5 w-3.5" />Hook → engine</Button>
                </div>
                {([["Visual sequence", node.visual], ["Audio direction", node.audio], ["App proof / CTA", node.cta], ["Test this", node.hypothesis], ["Measure", ch.metric], ["Keep it honest", node.note]] as const).filter(([, v]) => v).map(([k, v]) => (
                  <section key={k} className="mt-4 border-t pt-3"><h3 className="mb-1.5 text-[10px] uppercase tracking-[1.5px] text-muted-foreground">{k}</h3><p className="leading-relaxed">{v}</p></section>
                ))}
              </>
            );
          })() : channel ? (
            <>
              <Badge tone="outline">Channel strategy</Badge>
              <h2 className="mt-3 text-xl font-medium">{channel.title}</h2>
              <p className="mt-2 text-muted-foreground">{channel.objective}</p>
              <section className="mt-4 border-t pt-3"><h3 className="mb-1.5 text-[10px] uppercase tracking-[1.5px] text-muted-foreground">Tone</h3><p>{channel.tone}</p></section>
              <section className="mt-4 border-t pt-3"><h3 className="mb-1.5 text-[10px] uppercase tracking-[1.5px] text-muted-foreground">Success is</h3><p>{channel.metric}</p></section>
              <Button className="mt-4 w-full" onClick={() => setEditing({ id: "", channel: channel.id, title: "", hook: "" })}><Plus className="h-4 w-4" />Add an idea here</Button>
              <p className="mt-4 text-xs text-muted-foreground">These are starting roles, not channel rules. Run the same idea in contrasting formats and compare qualified outcomes.</p>
            </>
          ) : (
            <>
              <Badge tone="outline">Marketing Map</Badge>
              <h2 className="mt-3 text-xl font-medium">Sell a better way.</h2>
              <p className="mt-2 text-muted-foreground">A living map of the feeling, the proof and the provocation. Every idea becomes a portable edit brief, and its hook can go straight into the Reel Engine.</p>
              <ul className="mt-3 list-disc space-y-2 pl-4 text-muted-foreground">{(doc.strategy ?? []).map((s) => <li key={s}>{s}</li>)}</ul>
              <section className="mt-4 border-t pt-3">
                <h3 className="mb-1.5 text-[10px] uppercase tracking-[1.5px] text-muted-foreground">Shared language · click to copy</h3>
                {(doc.taglines ?? []).map((tl) => <button key={tl} onClick={() => copy(tl, "Copied")} className="my-1 w-full rounded-md border px-3 py-2 text-left text-xs hover:bg-accent">{tl}</button>)}
              </section>
              <Button variant="outline" className="mt-3 w-full" onClick={() => setDialog("links")}><Link2 className="h-3.5 w-3.5" />Edit cross-links</Button>
            </>
          )}
        </Card>
      </div>

      {editing && <IdeaEditor doc={doc} node={editing} onClose={() => setEditing(null)} onSave={async (n) => {
        const next = structuredClone(doc);
        const i = next.nodes.findIndex((x) => x.id === n.id);
        if (i < 0) next.nodes.push(n); else next.nodes[i] = n;
        await persist(next);
        setSelected(n.id);
        setEditing(null);
        flash("Idea saved");
      }} />}
      {dialog === "brainstorm" && <Brainstorm doc={doc} enabled={brainstormEnabled} onClose={() => setDialog(null)} onCopy={() => copy(brainstormPrompt(doc), "Prompt copied")} onApply={async (p) => {
        await persist({ ...doc, nodes: [...doc.nodes, ...p.nodes], edges: [...(doc.edges ?? []), ...p.edges] });
        setDialog(null);
        flash("Reviewed additions saved");
      }} />}
      {dialog === "links" && <LinksEditor doc={doc} onClose={() => setDialog(null)} onSave={async (edges) => { await persist({ ...doc, edges }); setDialog(null); flash("Cross-links saved"); }} />}
      {toast && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md bg-foreground px-4 py-2 text-sm text-background shadow-lg">{toast}</div>}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function IdeaEditor({ doc, node, onClose, onSave }: { doc: MarketingMapDoc; node: MapNode; onClose: () => void; onSave: (n: MapNode) => Promise<void> }) {
  const [n, setN] = useState<MapNode>(node);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={node.id ? "Edit idea" : "Add an idea"} onClose={onClose}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const out: MapNode = { ...n, id: n.id || `idea-${crypto.randomUUID()}` };
          for (const k of NODE_FIELDS) out[k] = (out[k] ?? "").trim();
          await onSave(out);
        } catch (x) { setErr(`${(x as Error).message} Your draft is still here.`); } finally { setBusy(false); }
      }}>
        <label className="block text-xs text-muted-foreground">Channel
          <Select className="mt-1 w-full" value={n.channel} onChange={(e) => setN({ ...n, channel: e.target.value })}>{doc.channels.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select>
        </label>
        {NODE_FIELDS.map((k) => (
          <label key={k} className="block text-xs text-muted-foreground">{LABEL[k]}
            {k === "title" ? <Input className="mt-1" required maxLength={100} value={n[k] ?? ""} onChange={(e) => setN({ ...n, [k]: e.target.value })} />
              : <Textarea className="mt-1" rows={2} required={k === "hook"} value={n[k] ?? ""} onChange={(e) => setN({ ...n, [k]: e.target.value })} />}
          </label>
        ))}
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy}>Save idea</Button></div>
      </form>
    </Modal>
  );
}

function Brainstorm({ doc, enabled, onClose, onCopy, onApply }: { doc: MarketingMapDoc; enabled: boolean; onClose: () => void; onCopy: () => void; onApply: (p: ReturnType<typeof reviewProposal>) => Promise<void> }) {
  const [text, setText] = useState("");
  const [focus, setFocus] = useState("");
  const [reviewed, setReviewed] = useState<ReturnType<typeof reviewProposal> | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const review = (raw = text) => {
    try { setReviewed(reviewProposal(doc, JSON.parse(raw))); setErr(""); } catch (e) { setReviewed(null); setErr((e as Error).message); }
  };
  return (
    <Modal title="Brainstorm, then review" onClose={onClose}>
      <p className="text-sm text-muted-foreground">Proposals are never applied automatically. {enabled ? "Ask Claude, or" : "No model key is set:"} copy the prompt into any assistant and paste its JSON below.</p>
      <div className="mt-3 flex gap-2">
        {enabled && <Input placeholder="Optional focus, e.g. rainy-day Oahu" value={focus} onChange={(e) => setFocus(e.target.value)} />}
        {enabled && <Button disabled={busy} onClick={async () => {
          setBusy(true); setErr("");
          try { const p = await api("/api/marketing-map/brainstorm", { method: "POST", json: { focus } }); const s = JSON.stringify(p, null, 2); setText(s); review(s); }
          catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}><Sparkles className="h-4 w-4" />{busy ? "Thinking…" : "Ask Claude"}</Button>}
        <Button variant="outline" onClick={onCopy}><Copy className="h-4 w-4" />Copy prompt</Button>
      </div>
      <Textarea className="mt-3 font-mono text-xs" rows={9} placeholder='{"nodes":[],"edges":[]}' value={text} onChange={(e) => { setText(e.target.value); setReviewed(null); }} />
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      {reviewed && <ul className="mt-2 space-y-1 text-xs">{reviewed.nodes.map((n) => <li key={n.id}><Badge tone="outline">{n.channel}</Badge> <span className="font-medium">{n.title}</span> · “{n.hook}”</li>)}</ul>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button variant="outline" onClick={() => review()}>Review</Button>
        <Button disabled={!reviewed} onClick={async () => { try { await onApply(reviewed!); } catch (e) { setErr((e as Error).message); } }}>Apply additions</Button>
      </div>
    </Modal>
  );
}

function LinksEditor({ doc, onClose, onSave }: { doc: MarketingMapDoc; onClose: () => void; onSave: (e: { from: string; to: string }[]) => Promise<void> }) {
  const [text, setText] = useState(JSON.stringify(doc.edges ?? [], null, 2));
  const [err, setErr] = useState("");
  return (
    <Modal title="Edit cross-links" onClose={onClose}>
      <p className="text-sm text-muted-foreground">Connect ideas across channels with from/to IDs. Channel branches stay intact.</p>
      <Textarea className="mt-3 font-mono text-xs" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={async () => { try { const e = JSON.parse(text); if (!Array.isArray(e)) throw Error("Use an array of from/to objects"); await onSave(e); } catch (x) { setErr((x as Error).message); } }}>Save links</Button>
      </div>
    </Modal>
  );
}
