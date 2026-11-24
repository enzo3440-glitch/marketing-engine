"use client";
import type { Approval, CapitalContact, Segment } from "@engine/db/types";
import { Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ApprovalsQueue } from "@/components/approvals";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Input, Select, Table, Td, Textarea, Th } from "@/components/ui";
import { fmt } from "@/lib/utils";

const SEGMENTS: Segment[] = ["investor", "partnership", "warm", "hit", "mentor"];
const STAGES = ["cold", "intro_requested", "drafted", "meeting_set", "pitched", "follow_up", "negotiating", "committed", "active"];

export function CapitalDesk({ contacts, drafts }: { contacts: CapitalContact[]; drafts: Approval[] }) {
  const router = useRouter();
  const [segment, setSegment] = useState<string>("all");
  const [stage, setStage] = useState<string>("all");
  const [q, setQ] = useState("");
  const [draftFor, setDraftFor] = useState<CapitalContact | null>(null);
  const shown = useMemo(() => contacts.filter((c) => (segment === "all" || c.segment === segment) && (stage === "all" || c.stage === stage) && `${c.name} ${c.org}`.toLowerCase().includes(q.toLowerCase())), [contacts, segment, stage, q]);
  const counts = STAGES.map((s) => ({ s, n: contacts.filter((c) => c.stage === s).length })).filter((x) => x.n);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {counts.map(({ s, n }) => (
          <button key={s} onClick={() => setStage(stage === s ? "all" : s)} className={`rounded-md border px-3 py-2 text-left ${stage === s ? "border-primary" : ""}`}>
            <div className="num text-lg font-semibold">{n}</div><div className="text-[11px] text-muted-foreground">{s.replace(/_/g, " ")}</div>
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Contacts" action={
            <div className="flex gap-2">
              <Input className="h-8 w-40" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
              <Select className="h-8" value={segment} onChange={(e) => setSegment(e.target.value)}><option value="all">All segments</option>{SEGMENTS.map((s) => <option key={s}>{s}</option>)}</Select>
            </div>
          } />
          <Table>
            <thead><tr><Th>Name</Th><Th>Org</Th><Th>Segment</Th><Th>Stage</Th><Th>Last touch</Th><Th /></tr></thead>
            <tbody>{shown.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">{c.name}</Td><Td className="text-muted-foreground">{c.org}</Td>
                <Td><Badge tone={c.segment === "investor" ? "primary" : "outline"}>{c.segment}</Badge></Td>
                <Td className="text-xs">{c.stage.replace(/_/g, " ")}</Td>
                <Td className="text-xs text-muted-foreground">{fmt.date(c.last_touch)}</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setDraftFor(c)}><Mail className="h-3.5 w-3.5" />Draft</Button></Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Outreach drafts" description="Approved drafts are sent by the executor (Gmail send is still a stub)." />
          <CardBody className="py-1"><ApprovalsQueue items={drafts} emptyText="No drafts." /></CardBody>
        </Card>
      </div>
      {draftFor && <DraftForm c={draftFor} onClose={() => setDraftFor(null)} onDone={() => { setDraftFor(null); router.refresh(); }} />}
    </div>
  );
}

function DraftForm({ c, onClose, onDone }: { c: CapitalContact; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(`Update for ${c.org ?? c.name}`);
  const [body, setBody] = useState(`Aloha ${c.name.split(" ")[0]},\n\n`);
  const [err, setErr] = useState("");
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <CardHeader title={`Outreach to ${c.name}`} description="Creates an approval; nothing is sent until approved." />
        <CardBody className="space-y-2">
          <Input placeholder="To (email)" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={async () => { try { await api("/api/capital/outreach", { method: "POST", json: { contactId: c.id, to, subject, body } }); onDone(); } catch (e) { setErr((e as Error).message); } }}>Send to approval</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
