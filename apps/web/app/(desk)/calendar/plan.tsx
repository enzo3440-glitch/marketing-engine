"use client";
import { LAUNCH, PILLARS, WEEK, type PlanChannel } from "@engine/db/marketing-plan";
import { CalendarRange } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/components/providers";
import { Badge, Button, Card, CardBody, CardHeader, Input } from "@/components/ui";
import { fmt } from "@/lib/utils";

const CH: Record<PlanChannel | "review", string> = { ig_organic: "IG", ig_paid: "IG ad", tiktok: "TikTok", review: "Review" };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** The guide's weekly pillar plan and launch rounds, and the button that puts its posts on the calendar as ideas. */
export function MarketingPlan({ launchStart, count, missing, today, gates }: {
  launchStart: string | null; count: number; missing: number; today: string; gates: { reviewed: number; tested: number; approved: number };
}) {
  const router = useRouter();
  const [start, setStart] = useState(launchStart ?? today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ added: number; rescheduled: number; launch_start: string }>("/api/marketing/plan", { method: "POST", json: { launch_start: start } });
      setMsg(`${r.added} ideas added, ${r.rescheduled} rescheduled from ${fmt.date(r.launch_start)}`);
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Marketing plan · weekly pillars & launch" description="From the marketing plan and your brand guide. Every post starts as an untested idea." action={
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Launch week</span>
          <Input type="date" className="h-7 w-36 text-xs" value={start} onChange={(e) => setStart(e.target.value)} />
          <Button size="sm" disabled={busy} onClick={load}><CalendarRange className="h-3.5 w-3.5" />{count ? (missing ? `Add ${missing} + reschedule` : "Reschedule ideas") : "Put the plan on the calendar"}</Button>
        </div>
      } />
      <CardBody className="space-y-4">
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        {count > 0 && (
          <p className="text-xs text-muted-foreground">
            {count} plan ideas in Content → Pipeline · {gates.reviewed} reviewed · {gates.tested} tested · {gates.approved} approved. Tick Reviewed + Tested on an idea, then move it on to send it for approval.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {PILLARS.map((p) => (
            <div key={p.id} className="min-w-[180px] flex-1 rounded border p-2 text-xs" style={{ borderLeft: `3px solid ${p.color}` }}>
              <div className="font-medium">{p.name}</div>
              <div className="italic">{p.line}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{p.job}</div>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 text-xs font-medium">Every week</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
            {DAYS.map((d, i) => (
              <div key={d} className="rounded bg-muted/30 p-1.5 text-[11px]">
                <div className="mb-1 font-medium text-muted-foreground">{d}</div>
                {WEEK.filter((s) => s.day === i).map((s) => {
                  const p = PILLARS.find((x) => x.id === s.pillar);
                  return (
                    <div key={s.label} className="mb-1 rounded border bg-card px-1.5 py-1" style={p ? { borderLeft: `3px solid ${p.color}` } : undefined}>
                      <div className="text-[10px] text-muted-foreground">{CH[s.channel]}{p ? ` · ${p.name}` : ""}</div>
                      <div className="leading-tight">{s.label}</div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium">Launch plan{launchStart ? ` · from ${fmt.date(launchStart)}` : ""}</div>
          <div className="space-y-1.5">
            {LAUNCH.map((ph) => {
              const from = launchStart ? addDays(launchStart, ph.weeks[0] * 7) : null;
              const to = launchStart ? addDays(launchStart, ph.weeks[1] * 7 + 6) : null;
              const now = from && to && from <= today && today <= to;
              return (
                <div key={ph.id} className={`rounded border p-2 text-xs ${now ? "border-primary/50 bg-primary/5" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{ph.name}{now && <Badge tone="primary" className="ml-1.5">now</Badge>}</span>
                    <span className="text-muted-foreground">{from ? `${fmt.date(from)} – ${fmt.date(to)}` : `week ${ph.weeks[0]}${ph.weeks[1] !== ph.weeks[0] ? `–${ph.weeks[1]}` : ""}`}</span>
                  </div>
                  <div className="mt-0.5">{ph.question}</div>
                  {ph.paid.length > 0 && <div className="mt-0.5 text-muted-foreground">Paid tests: {ph.paid.join(", ")}</div>}
                  <div className="text-muted-foreground">Organic: {ph.organic}</div>
                  <div className="text-[11px] text-muted-foreground">Decide: {ph.decide}</div>
                </div>
              );
            })}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
