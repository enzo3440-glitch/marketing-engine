"use client";
import type { CmoRecommendation } from "@engine/db/types";
import { Check, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardHeader, statusTone } from "@/components/ui";

const KINDS: { key: CmoRecommendation["kind"] | "all"; label: string }[] = [
  { key: "all", label: "All" }, { key: "watchlist", label: "Outside watchlist" }, { key: "trend", label: "Own-footage ideas" },
  { key: "creative_test", label: "Acquisition tests" }, { key: "paid_decision", label: "Paid decisions" }, { key: "agent", label: "Agent" },
];

export function Recommendations({ items: initial }: { items: CmoRecommendation[] }) {
  const [items, setItems] = useState(initial);
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("all");
  const [hideDismissed, setHide] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const shown = useMemo(() => items.filter((r) => (kind === "all" || r.kind === kind) && (!hideDismissed || r.status !== "dismissed")), [items, kind, hideDismissed]);

  async function setStatus(r: CmoRecommendation, status: CmoRecommendation["status"]) {
    setItems((xs) => xs.map((x) => (x.id === r.id ? { ...x, status } : x)));
    await api(`/api/cmo/recommendations/${r.id}`, { method: "PATCH", json: { status } });
  }
  /** Accept = it becomes an idea on Ideas, ready to make into a video. */
  async function toIdea(r: CmoRecommendation) {
    await api("/api/ideas", { method: "POST", json: { action: "add", title: r.title.slice(0, 120), hook: r.hook ?? r.body?.slice(0, 300) ?? "" } });
    await setStatus(r, "accepted");
    setNote(`"${r.title.slice(0, 40)}" is now on Ideas.`);
  }

  return (
    <Card>
      <CardHeader
        title="Decision desk"
        description="Saved research from the old CMO desk. Make it an idea to put it on Ideas (then make and launch it), or dismiss it. Signals keep their original confidence labels."
        action={note && <span className="text-xs text-primary">{note}</span>}
      />
      <div className="flex flex-wrap items-center gap-1 border-b px-4 py-2">
        {KINDS.map((k) => (
          <button key={k.key} onClick={() => setKind(k.key)} className={`rounded px-2 py-1 text-xs ${kind === k.key ? "bg-accent text-foreground" : "text-muted-foreground"}`}>
            {k.label} <span className="text-muted-foreground">{k.key === "all" ? items.length : items.filter((i) => i.kind === k.key).length}</span>
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={hideDismissed} onChange={(e) => setHide(e.target.checked)} />Hide dismissed</label>
      </div>
      <div className="grid gap-3 p-4 md:grid-cols-2">
        {shown.map((r) => (
          <div key={r.id} className="flex flex-col rounded-md border p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium">{r.title}</div>
              <Badge tone={statusTone(r.status)}>{r.status}</Badge>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              <Badge tone="outline">{r.kind.replace("_", " ")}</Badge>
              {r.signal && <Badge tone={r.signal === "observed_growth" ? "primary" : "outline"}>{r.signal.replace(/_/g, " ")}</Badge>}
              {r.confidence && <Badge tone="outline" className="max-w-full truncate">{r.confidence}</Badge>}
            </div>
            {r.hook && <p className="mt-2 rounded bg-muted/60 px-2 py-1 text-xs italic">“{r.hook}”</p>}
            {r.body && <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">{r.body}</p>}
            {r.evidence && <p className="mt-2 text-xs"><span className="text-muted-foreground">Evidence: </span>{r.evidence}</p>}
            {r.sources.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                {r.sources.slice(0, 4).map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s.title}</a>)}
              </div>
            )}
            <div className="mt-auto flex gap-1.5 pt-3">
              {r.status !== "accepted" && <Button size="sm" variant="outline" onClick={() => toIdea(r)}><Check className="h-3.5 w-3.5" />Make it an idea</Button>}
              {r.status !== "dismissed" && <Button size="sm" variant="ghost" onClick={() => setStatus(r, "dismissed")}><X className="h-3.5 w-3.5" />Dismiss</Button>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
