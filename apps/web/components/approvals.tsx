"use client";
import type { Approval } from "@engine/db/types";
import { Check, ChevronDown, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Empty, statusTone } from "@/components/ui";
import { fmt } from "@/lib/utils";

const TYPE_LABEL: Record<Approval["type"], string> = { fix_pr: "Fix PR", post: "Post", outreach_email: "Outreach", ad_change: "Ad change", ad_launch: "Ad launch", optimize: "Improve", other: "Brief" };

export function ApprovalsQueue({ items, emptyText = "Nothing waiting on you." }: { items: Approval[]; emptyText?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/approvals/${id}`, { method: "POST", json: { decision } });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!items.length) return <Empty>{emptyText}</Empty>;
  return (
    <div className="divide-y">
      {error && <p className="pb-2 text-xs text-destructive">{error}</p>}
      {items.map((a) => (
        <div key={a.id} className="py-2.5">
          <div className="flex items-start gap-3">
            <button onClick={() => setOpen(open === a.id ? null : a.id)} className="mt-0.5 text-muted-foreground" aria-label="Toggle preview">
              <ChevronDown className={`h-4 w-4 transition-transform ${open === a.id ? "" : "-rotate-90"}`} />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="primary">{TYPE_LABEL[a.type]}</Badge>
                <span className="truncate text-sm font-medium">{a.title}</span>
              </div>
              {a.summary && <p className="mt-0.5 text-xs text-muted-foreground">{a.summary}</p>}
              <p className="mt-0.5 text-[11px] text-muted-foreground">{a.created_by_agent ?? "desk"} · {fmt.ago(a.created_at)}</p>
            </div>
            {a.status === "pending" ? (
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => decide(a.id, "reject")}><X className="h-3.5 w-3.5" />Reject</Button>
                <Button size="sm" disabled={busy === a.id} onClick={() => decide(a.id, "approve")}><Check className="h-3.5 w-3.5" />Approve</Button>
              </div>
            ) : (
              <Badge tone={statusTone(a.status)}>{a.status}</Badge>
            )}
          </div>
          {open === a.id && <Preview a={a} />}
        </div>
      ))}
    </div>
  );
}

function Preview({ a }: { a: Approval }) {
  const p = a.preview as Record<string, unknown>;
  return (
    <div className="ml-7 mt-2 space-y-2 rounded-md bg-muted/50 p-3 text-xs">
      {typeof p.diff === "string" && <Diff diff={p.diff} />}
      {typeof p.caption === "string" && <pre className="whitespace-pre-wrap font-sans">{p.caption}</pre>}
      {typeof p.body === "string" && (
        <div>
          <div className="text-muted-foreground">To {String(p.to)} · {String(p.subject)}</div>
          <pre className="mt-1 whitespace-pre-wrap font-sans">{p.body}</pre>
        </div>
      )}
      {Array.isArray(p.bullets) && <ul className="list-disc pl-4">{(p.bullets as string[]).map((b) => <li key={b}>{b}</li>)}</ul>}
      {a.result && <pre className="whitespace-pre-wrap text-muted-foreground">Result: {JSON.stringify(a.result, null, 1)}</pre>}
      {!p.diff && !p.caption && !p.body && !p.bullets && <pre className="whitespace-pre-wrap text-muted-foreground">{JSON.stringify(p, null, 1)}</pre>}
    </div>
  );
}

export function Diff({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto rounded border bg-background p-2 font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-success" : l.startsWith("-") && !l.startsWith("---") ? "text-destructive" : l.startsWith("@@") ? "text-primary" : ""}>{l || " "}</div>
      ))}
    </pre>
  );
}
