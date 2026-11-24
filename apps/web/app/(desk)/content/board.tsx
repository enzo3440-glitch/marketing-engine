"use client";
import { PILLARS } from "@engine/db/marketing-plan";
import type { ContentItem, ContentStatus } from "@engine/db/types";
import { ArrowRight, Check, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Input, Select } from "@/components/ui";
import { fmt } from "@/lib/utils";

const COLS: ContentStatus[] = ["idea", "draft", "approved", "scheduled", "posted"];
type Gates = { reviewed?: boolean; tested?: boolean };
const plan = (it: ContentItem) => it.meta as { gates?: Gates; pillar?: string; channel?: string; blocked?: string; hypothesis?: string; tier?: string };
const TIER: Record<string, string> = { entertain: "text-info", educate: "text-success", sell: "text-warning" };

export function ContentBoard({ items: initial }: { items: ContentItem[] }) {
  const [items, setItems] = useState(initial);
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState<ContentItem["platform"]>("instagram");
  const [err, setErr] = useState<string | null>(null);

  async function advance(it: ContentItem) {
    const status = COLS[COLS.indexOf(it.status) + 1];
    if (!status) return;
    setErr(null);
    try {
      const row = await api<ContentItem>(`/api/content/${it.id}`, { method: "PATCH", json: { status } });
      setItems((xs) => xs.map((x) => (x.id === it.id ? row : x)));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function gate(it: ContentItem, k: keyof Gates) {
    setErr(null);
    try {
      const row = await api<ContentItem>(`/api/content/${it.id}`, { method: "PATCH", json: { gates: { [k]: !plan(it).gates?.[k] } } });
      setItems((xs) => xs.map((x) => (x.id === it.id ? row : x)));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const row = await api<ContentItem>("/api/content", { method: "POST", json: { title, platform } });
    setItems((xs) => [row, ...xs]);
    setTitle("");
  }

  return (
    <Card>
      <CardHeader title="Pipeline" description="idea → draft → approved → scheduled → posted. Plan ideas need Reviewed + Tested before they go to the approval queue; drafts reach 'approved' only there." action={err && <span className="text-xs text-destructive">{err}</span>} />
      <CardBody>
        <form onSubmit={add} className="mb-3 flex gap-2">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value as ContentItem["platform"])}><option value="instagram">Instagram</option><option value="tiktok">TikTok</option></Select>
          <Input placeholder="New idea…" value={title} onChange={(e) => setTitle(e.target.value)} className="max-w-md" />
          <Button variant="outline"><Plus className="h-4 w-4" />Add idea</Button>
        </form>
        <div className="grid gap-2 md:grid-cols-5">
          {COLS.map((col) => (
            <div key={col} className="rounded-md bg-muted/30 p-2">
              <div className="mb-2 flex justify-between text-xs font-medium capitalize"><span>{col}</span><span className="text-muted-foreground">{items.filter((i) => i.status === col).length}</span></div>
              <div className="space-y-1.5">
                {items.filter((i) => i.status === col).map((it) => (
                  <div key={it.id} className="rounded border bg-card p-2 text-xs" title={plan(it).hypothesis}>
                    {plan(it).pillar && <PillarTag id={plan(it).pillar!} paid={plan(it).channel === "ig_paid"} tier={plan(it).tier} />}
                    <div className="line-clamp-2">{it.title}</div>
                    {col === "idea" && plan(it).gates && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {(["reviewed", "tested"] as const).map((k) => (
                          <button key={k} onClick={() => gate(it, k)} className={`inline-flex items-center gap-0.5 rounded border px-1 text-[10px] ${plan(it).gates?.[k] ? "border-success/40 bg-success/15 text-success" : "text-muted-foreground"}`}>
                            {plan(it).gates?.[k] && <Check className="h-2.5 w-2.5" />}{k === "reviewed" ? "Reviewed" : "Tested"}
                          </button>
                        ))}
                        {plan(it).blocked && <span className="text-[10px] text-destructive" title={plan(it).blocked}>blocked</span>}
                      </div>
                    )}
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-muted-foreground"><Badge tone="outline" className="mr-1 px-1">{it.platform === "tiktok" ? "TT" : "IG"}</Badge>{fmt.date(it.scheduled_at ?? it.posted_at)}</span>
                      {col !== "posted" && col !== "draft" && !(col === "idea" && plan(it).gates && !(plan(it).gates!.reviewed && plan(it).gates!.tested)) && <button onClick={() => advance(it)} className="text-muted-foreground hover:text-foreground" aria-label="Advance" title={col === "idea" && plan(it).gates ? "Send for approval" : undefined}><ArrowRight className="h-3.5 w-3.5" /></button>}
                      {col === "idea" && plan(it).gates && !(plan(it).gates!.reviewed && plan(it).gates!.tested) && <span className="text-[10px] text-warning">needs review + test</span>}
                      {col === "draft" && <span className="text-[10px] text-warning">needs approval</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

export function PillarTag({ id, paid, tier }: { id: string; paid?: boolean; tier?: string }) {
  const p = PILLARS.find((x) => x.id === id);
  if (!p) return null;
  return (
    <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />{p.name}{paid ? " · paid" : ""}
      {tier && <span className={`ml-auto font-medium capitalize ${TIER[tier] ?? ""}`}>{tier}</span>}
    </div>
  );
}
