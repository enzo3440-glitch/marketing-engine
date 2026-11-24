"use client";
import type { BuildItem, Incident } from "@engine/db/types";
import { ArrowLeft, ArrowRight, Plus, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { Diff } from "@/components/approvals";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Empty, Input, Select, severityTone, statusTone, Table, Td, Th } from "@/components/ui";
import { fmt } from "@/lib/utils";

const COLS: BuildItem["status"][] = ["backlog", "active", "done"];
const KIND_TONE = { feature: "primary", bug: "danger", test: "warning" } as const;

export function BuildBoard({ items: initial }: { items: BuildItem[] }) {
  const [items, setItems] = useState(initial);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<BuildItem["kind"]>("feature");

  async function move(it: BuildItem, dir: -1 | 1) {
    const status = COLS[COLS.indexOf(it.status) + dir];
    if (!status) return;
    setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, status } : x)));
    await api(`/api/build-items/${it.id}`, { method: "PATCH", json: { status } });
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const row = await api<BuildItem>("/api/build-items", { method: "POST", json: { title, kind } });
    setItems((xs) => [row, ...xs]);
    setTitle("");
  }

  return (
    <div>
      <form onSubmit={add} className="mb-3 flex gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value as BuildItem["kind"])}>
          <option value="feature">Feature</option><option value="bug">Bug</option><option value="test">Field test</option>
        </Select>
        <Input placeholder="Add to backlog…" value={title} onChange={(e) => setTitle(e.target.value)} className="max-w-md" />
        <Button variant="outline"><Plus className="h-4 w-4" />Add</Button>
      </form>
      <div className="grid gap-3 md:grid-cols-3">
        {COLS.map((col) => (
          <Card key={col} className="bg-muted/30">
            <CardHeader title={<span className="capitalize">{col}</span>} action={<Badge>{items.filter((i) => i.status === col).length}</Badge>} />
            <CardBody className="space-y-2 p-2">
              {items.filter((i) => i.status === col).map((it) => (
                <div key={it.id} className="rounded-md border bg-card p-2.5 text-sm">
                  <div className="flex items-center gap-1.5">
                    <Badge tone={KIND_TONE[it.kind]}>{it.kind}</Badge>
                    <span className="text-[11px] text-muted-foreground">P{it.priority}</span>
                  </div>
                  <div className="mt-1">{it.title}</div>
                  <div className="mt-1.5 flex justify-end gap-1">
                    {col !== "backlog" && <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(it, -1)} aria-label="Move left"><ArrowLeft className="h-3.5 w-3.5" /></Button>}
                    {col !== "done" && <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(it, 1)} aria-label="Move right"><ArrowRight className="h-3.5 w-3.5" /></Button>}
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function CrashTable({ incidents }: { incidents: Incident[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function send(id: string) {
    try {
      await api(`/api/incidents/${id}/propose`, { method: "POST" });
      setMsg("Sent to the approval queue.");
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <Card>
      <CardHeader title="Crashes" description="Sentry issues via webhook. Crash Triage drafts a fix from the stack + repo files; fixes become PRs only after approval." action={msg && <span className="text-xs text-muted-foreground">{msg}</span>} />
      {incidents.length ? (
        <Table>
          <thead><tr><Th>Issue</Th><Th>Severity</Th><Th className="text-right">Events</Th><Th className="text-right">Users</Th><Th>First seen</Th><Th>Last seen</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {incidents.map((i) => (
              <Fragment key={i.id}>
                <tr className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(open === i.id ? null : i.id)}>
                  <Td className="max-w-md"><div className="truncate font-medium">{i.title}</div><div className="truncate text-[11px] text-muted-foreground">{String((i.payload as { culprit?: string }).culprit ?? i.body ?? "")}</div></Td>
                  <Td><Badge tone={severityTone(i.severity)}>{i.severity}</Badge></Td>
                  <Td className="num text-right">{fmt.num(i.occurrences)}</Td>
                  <Td className="num text-right">{fmt.num(i.users_affected)}</Td>
                  <Td className="text-xs text-muted-foreground">{fmt.dateTime(i.first_seen)}</Td>
                  <Td className="text-xs text-muted-foreground">{fmt.ago(i.last_seen)}</Td>
                  <Td><Badge tone={statusTone(i.status)}>{i.status}</Badge></Td>
                  <Td className="text-right">
                    {i.proposed_fix && i.status !== "resolved" && (
                      <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); send(i.id); }}><Send className="h-3.5 w-3.5" />Send to approval</Button>
                    )}
                  </Td>
                </tr>
                {open === i.id && (
                  <tr><Td colSpan={8} className="bg-muted/30">
                    {i.proposed_fix ? (
                      <div className="space-y-2 text-xs"><p><span className="font-medium">Proposed fix:</span> {i.proposed_fix.summary}</p><Diff diff={i.proposed_fix.diff} /></div>
                    ) : <p className="text-xs text-muted-foreground">No fix proposed yet. {i.status === "triaged" ? "Triaged by the agent; needs a human or more repo context." : "Crash Triage picks up open issues every minute when the worker runs."}</p>}
                  </Td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </Table>
      ) : <CardBody><Empty>No crashes. Add the Sentry webhook to start the feed.</Empty></CardBody>}
    </Card>
  );
}
