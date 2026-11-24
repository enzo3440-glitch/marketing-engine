import { tzOffsetMs } from "@/lib/tz";
import { efficacy, getRepo, type ContentItem } from "@engine/db";
import { ContentBoard } from "./board";
import { Badge, Card, CardHeader, Table, Td, Th } from "@/components/ui";
import { fmt, hstToday } from "@/lib/utils";

const dayOf = (iso: string) => new Date(Date.parse(iso) + tzOffsetMs()).toISOString().slice(0, 10);

export default async function ContentPage() {
  const items = await getRepo().list("content_items");
  const today = hstToday();
  // Calendar: 5 weeks, Sunday-start, current week second.
  const start = new Date(today + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 7);
  const days = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const byDay = new Map<string, ContentItem[]>();
  for (const it of items) {
    const when = it.posted_at ?? it.scheduled_at;
    if (!when) continue;
    const d = dayOf(when);
    byDay.set(d, [...(byDay.get(d) ?? []), it]);
  }
  const posted = items.filter((i) => i.status === "posted").sort((a, b) => ((a.posted_at ?? "") < (b.posted_at ?? "") ? 1 : -1));
  const unknownShare = posted.filter((p) => efficacy(p) == null).length;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Content calendar" description="Posted and scheduled items, desk time" />
        <div className="grid grid-cols-7 text-xs">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="border-b px-2 py-1.5 text-muted-foreground">{d}</div>)}
          {days.map((d) => (
            <div key={d} className={`min-h-[84px] border-b border-r p-1.5 ${d === today ? "bg-primary/5" : ""}`}>
              <div className={`num mb-1 text-[11px] ${d === today ? "font-semibold text-primary" : "text-muted-foreground"}`}>{Number(d.slice(8))}</div>
              <div className="space-y-1">
                {(byDay.get(d) ?? []).slice(0, 3).map((it) => (
                  <div key={it.id} className={`truncate rounded px-1 py-0.5 text-[11px] ${it.status === "posted" ? "bg-muted" : "bg-primary/15 text-primary"}`} title={it.title ?? ""}>
                    {it.platform === "tiktok" ? "TT · " : "IG · "}{it.title}
                  </div>
                ))}
                {(byDay.get(d)?.length ?? 0) > 3 && <div className="text-[10px] text-muted-foreground">+{byDay.get(d)!.length - 3} more</div>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <ContentBoard items={items.filter((i) => i.status !== "posted").concat(posted.slice(0, 6))} />

      <Card>
        <CardHeader title="Post performance" description={`Efficacy = (saves + shares) ÷ views. ${unknownShare} of ${posted.length} posts come from public CMO Desk observations, where saves, shares and attributed signups are unknown until Insights is connected.`} />
        <Table>
          <thead><tr><Th>Post</Th><Th>Posted</Th><Th className="text-right">Views</Th><Th className="text-right">Likes</Th><Th className="text-right">Saves</Th><Th className="text-right">Shares</Th><Th className="text-right">Efficacy</Th><Th className="text-right">Signups</Th><Th>CMO read</Th></tr></thead>
          <tbody>{posted.map((p) => {
            const m = p.meta as { action?: string; paidStatus?: string };
            return (
              <tr key={p.id}>
                <Td className="max-w-xs"><a href={p.media_url ?? undefined} target="_blank" rel="noreferrer" className="block truncate hover:underline">{p.title}</a><div className="text-[11px] text-muted-foreground">{p.platform} · {p.kind}{m.paidStatus ? ` · ${m.paidStatus}` : ""}</div></Td>
                <Td className="whitespace-nowrap text-xs text-muted-foreground">{fmt.date(p.posted_at)}</Td>
                <Td className="num text-right">{fmt.compact(p.views)}</Td><Td className="num text-right">{fmt.compact(p.likes)}</Td>
                <Td className="num text-right">{fmt.num(p.saves)}</Td><Td className="num text-right">{fmt.num(p.shares)}</Td>
                <Td className="num text-right">{fmt.pct(efficacy(p), 2)}</Td><Td className="num text-right">{fmt.num(p.attributed_signups)}</Td>
                <Td>{m.action ? <Badge tone="outline">{m.action}</Badge> : null}</Td>
              </tr>
            );
          })}</tbody>
        </Table>
      </Card>
    </div>
  );
}
