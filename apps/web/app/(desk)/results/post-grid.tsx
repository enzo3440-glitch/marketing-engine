"use client";
import { PILLARS } from "@engine/db/marketing-plan";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/components/providers";
import type { IgPost } from "@/lib/meta-insights";
import { cn, fmt } from "@/lib/utils";

type Sort = "best" | "latest" | "reach";
const SORTS: { id: Sort; label: string }[] = [{ id: "best", label: "Most successful" }, { id: "latest", label: "Latest" }, { id: "reach", label: "Most reach" }];

/** (saves + shares) ÷ reach: the guide's organic scorecard. Null when reach or saves/shares are unknown. */
const rate = (p: IgPost) => (p.reach && p.saves != null && p.shares != null ? (p.saves + p.shares) / p.reach : null);
const reach = (p: IgPost) => p.reach ?? p.views ?? 0;

/** Instagram posts, big, sortable by success / date / reach. `live` = real media insights; otherwise public observations. */
export function PostGrid({ posts, live }: { posts: IgPost[]; live: boolean }) {
  const [sort, setSort] = useState<Sort>(live ? "best" : "latest");
  const sorted = useMemo(() => {
    const xs = [...posts];
    // without saves/shares (public observations), "most successful" falls back to reach
    if (sort === "best") xs.sort((a, b) => (rate(b) ?? -1) - (rate(a) ?? -1) || reach(b) - reach(a));
    else if (sort === "reach") xs.sort((a, b) => reach(b) - reach(a));
    else xs.sort((a, b) => (a.at < b.at ? 1 : -1));
    return xs;
  }, [posts, sort]);
  const topRate = Math.max(0.0001, ...posts.map((p) => rate(p) ?? 0));
  const topReach = Math.max(1, ...posts.map(reach));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="label mr-1">Sort</span>
        {SORTS.map((s) => (
          <button key={s.id} onClick={() => setSort(s.id)}
            className={cn("rounded-sm border px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground", sort === s.id && "border-primary/60 bg-primary/10 text-foreground")}>
            {s.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{posts.length} posts</span>
      </div>
      <div className="grid grid-cols-2 items-start gap-3 md:grid-cols-3 xl:grid-cols-4">
        {sorted.map((p, i) => {
          const r = rate(p);
          const h = r != null ? r / topRate : reach(p) / topReach;
          const pillar = PILLARS.find((x) => x.id === p.pillar);
          return (
            <div key={p.id} className="group overflow-hidden rounded-md border bg-background/60 transition-colors hover:border-primary/70"
              style={{ borderColor: `hsl(var(--primary) / ${(0.15 + 0.85 * h).toFixed(2)})` }}>
              <a href={p.permalink || undefined} target="_blank" rel="noreferrer" className="block">
              <div className={cn("relative bg-muted/60", p.thumb ? "aspect-[4/5]" : "h-40")}>
                {p.thumb
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100" />
                  : <div className="flex h-full items-end p-3 pt-7 text-[12.5px] leading-snug text-foreground/85"><span className="line-clamp-5">{p.caption || "—"}</span></div>}
                {sort === "best" && i < 3 && <span className="absolute left-2 top-2 rounded-sm bg-primary px-1.5 py-0.5 font-mono text-[10px] font-bold text-primary-foreground">#{i + 1}</span>}
                {pillar && <span className="absolute right-2 bottom-2 h-2.5 w-2.5 rounded-full ring-2 ring-background" style={{ background: pillar.color }} title={pillar.name} />}
                <span className="absolute right-2 top-2 rounded-sm bg-background/85 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">{p.at ? fmt.date(p.at) : ""}</span>
                <span className="absolute bottom-0 left-0 h-1 bg-primary" style={{ width: `${Math.round(h * 100)}%` }} />
              </div>
              {p.thumb && p.caption && <div className="line-clamp-2 px-2.5 pt-2 text-[12px] leading-snug text-foreground/80">{p.caption}</div>}
              <div className="grid grid-cols-4 gap-px p-2 pt-1.5 text-center font-mono">
                <Metric v={fmt.compact(reach(p))} k={live ? "reach" : "views"} />
                <Metric v={p.saves != null ? fmt.compact(p.saves) : fmt.compact(p.likes)} k={p.saves != null ? "saves" : "likes"} />
                <Metric v={p.shares != null ? fmt.compact(p.shares) : fmt.compact(p.comments)} k={p.shares != null ? "shares" : "comments"} />
                <Metric v={r != null ? fmt.pct(r, 1) : "—"} k="s+s/reach" strong />
              </div>
              </a>
              {live && <ImproveButton post={p} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const Metric = ({ v, k, strong }: { v: string; k: string; strong?: boolean }) => (
  <div className="py-1">
    <div className={cn("num text-[13px]", strong && "font-semibold text-primary")}>{v}</div>
    <div className="text-[8.5px] uppercase tracking-wide text-muted-foreground">{k}</div>
  </div>
);

/** Improve on a post: proposes promoting it as a short ads test; the proposal waits in Decide. */
function ImproveButton({ post }: { post: IgPost }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await api<{ proposals?: { title: string }[]; notes?: string[] }>("/api/improve", { method: "POST", json: { kind: "post", id: post.id, caption: post.caption } });
      setMsg(r.proposals?.length ? "sent" : r.notes?.[0] ?? "No change suggested.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
      <button onClick={go} disabled={busy} className="flex items-center gap-1 font-mono text-[10.5px] uppercase text-muted-foreground hover:text-primary disabled:opacity-50">
        <Sparkles className="h-3 w-3" />{busy ? "Reading…" : "Improve"}
      </button>
      {msg === "sent" ? <Link href="/command#decide" className="text-[10.5px] text-primary hover:underline">proposal in Decide →</Link>
        : msg && <span className="truncate text-[10.5px] text-muted-foreground" title={msg}>{msg}</span>}
    </div>
  );
}
