"use client";
import { Check, Loader2, PlugZap, X } from "lucide-react";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, statusTone } from "@/components/ui";
import { fmt } from "@/lib/utils";

interface Item {
  id: string; label: string; implemented: boolean; docs: string | null; env: { key: string; set: boolean }[];
  status: string; lastSync: string | null; error: string | null; detail: string | null;
}

export function IntegrationsList({ items }: { items: Item[] }) {
  const [state, setState] = useState<Record<string, { status: string; detail?: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  async function test(id: string) {
    setBusy(id);
    try {
      const r = await api<{ status: string; detail?: string }>(`/api/integrations/${id}/test`, { method: "POST" });
      setState((s) => ({ ...s, [id]: r }));
    } catch (e) {
      setState((s) => ({ ...s, [id]: { status: "error", detail: (e as Error).message } }));
    } finally { setBusy(null); }
  }
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((it) => {
        const cur = state[it.id] ?? { status: it.status, detail: it.error ?? it.detail ?? undefined };
        return (
          <Card key={it.id} className="flex flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium">{it.label}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{it.id}</div>
              </div>
              <div className="flex gap-1">
                {!it.implemented && <Badge tone="outline">stub</Badge>}
                <Badge tone={statusTone(cur.status)}>{cur.status.replace("_", " ")}</Badge>
              </div>
            </div>
            <div className="mt-3 space-y-1">
              {it.env.map((e) => (
                <div key={e.key} className="flex items-center gap-1.5 font-mono text-[11px]">
                  {e.set ? <Check className="h-3 w-3 text-success" /> : <X className="h-3 w-3 text-muted-foreground" />}
                  <span className={e.set ? "" : "text-muted-foreground"}>{e.key}</span>
                </div>
              ))}
            </div>
            {cur.detail && <p className="mt-2 text-xs text-muted-foreground">{cur.detail}</p>}
            <div className="mt-auto flex items-center justify-between pt-3">
              <span className="text-[11px] text-muted-foreground">{it.lastSync ? `last ok ${fmt.ago(it.lastSync)}` : ""}{it.docs && <> · <a href={it.docs.startsWith("http") ? it.docs : undefined} className="text-primary" target="_blank" rel="noreferrer">{it.docs.startsWith("http") ? "docs" : it.docs}</a></>}</span>
              <Button size="sm" variant="outline" onClick={() => test(it.id)} disabled={busy === it.id}>
                {busy === it.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}Test connection
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
