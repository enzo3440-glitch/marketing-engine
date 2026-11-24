"use client";
import { deskTimeZone, tzLabel } from "@/lib/tz";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, Calendar, ChevronRight, Command as CommandIcon, CornerDownLeft, Film, Gauge, Hammer, Landmark, Lightbulb, LineChart, Map, Plug, Rocket, Search, Server, TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Led } from "@/components/ui";
import type { PaletteItem } from "@/app/api/palette/route";
import type { DeskStatus } from "@/lib/status";
import { cn, RANGES } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: typeof Gauge; area: string; key?: string };
const NAV: { group: string; items: NavItem[]; collapsed?: boolean }[] = [
  { group: "Marketing", items: [
    { href: "/command", label: "Command", icon: Gauge, area: "command", key: "c" },
    { href: "/ideas", label: "Ideas", icon: Lightbulb, area: "content", key: "i" },
    { href: "/make", label: "Make", icon: Film, area: "content", key: "m" },
    { href: "/launch", label: "Launch", icon: Rocket, area: "content", key: "l" },
    { href: "/results", label: "Results", icon: Activity, area: "growth", key: "r" },
    { href: "/calendar", label: "Calendar", icon: Calendar, area: "calendar", key: "k" },
    { href: "/content/map", label: "Marketing Map", icon: Map, area: "content", key: "p" },
  ] },
  { group: "Company", collapsed: true, items: [
    { href: "/build", label: "Build", icon: Hammer, area: "build", key: "b" },
    { href: "/ops", label: "Ops", icon: Server, area: "ops", key: "o" },
    { href: "/finance", label: "Finance", icon: LineChart, area: "finance", key: "f" },
    { href: "/capital", label: "Capital", icon: Landmark, area: "capital" },
    { href: "/growth", label: "Growth (legacy)", icon: TrendingUp, area: "growth" },
    { href: "/settings/integrations", label: "Integrations", icon: Plug, area: "settings", key: "s" },
  ] },
];

/** Live status, shared by the rail and the strip: one request every 15 s. */
function useStatus() {
  return useQuery<DeskStatus>({
    queryKey: ["desk-status"], refetchInterval: 15_000, staleTime: 10_000,
    queryFn: async () => { const r = await fetch("/api/status"); if (!r.ok) throw new Error(String(r.status)); return r.json(); },
  });
}

export function Sidebar({ areas, email, role, mock }: { areas: string[]; email: string; role: string; mock: boolean }) {
  const path = usePathname();
  const { data: st } = useStatus();
  const badge: Record<string, number | undefined> = { "/command": st?.alerts, "/launch": st?.approvals, "/calendar": st?.postsToday, "/make": st?.rendering };
  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((n) => areas.includes(n.area)) })).filter((g) => g.items.length);
  const activeHref = groups.flatMap((g) => g.items).map((n) => n.href).filter((h) => path === h || path.startsWith(h + "/")).sort((a, b) => b.length - a.length)[0];
  return (
    <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r bg-card/60 md:flex">
      <div className="flex h-11 items-center gap-2 border-b px-3.5">
        <div className="grid h-6 w-6 place-items-center rounded-sm bg-primary font-mono text-[11px] font-bold text-primary-foreground">W</div>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold tracking-tight">Marketing Engine</div>
          <div className="label text-[9px]">command center</div>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {groups.map((g) => (
          <NavGroup key={g.group} title={g.group} collapsed={!!g.collapsed && !g.items.some((n) => n.href === activeHref)}>
            {g.items.map((n) => {
              const active = n.href === activeHref;
              const b = badge[n.href];
              return (
                <Link key={n.href} href={n.href} prefetch
                  className={cn("group relative flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    active && "bg-accent text-foreground before:absolute before:inset-y-1 before:-left-2 before:w-0.5 before:rounded-full before:bg-primary")}>
                  <n.icon className={cn("h-3.5 w-3.5", active && "text-primary")} />
                  <span className="flex-1 truncate">{n.label}</span>
                  {!!b && <span className="num rounded-sm bg-warning/15 px-1 font-mono text-[10px] text-warning">{b}</span>}
                  {n.key && !b && <span className="hidden font-mono text-[9.5px] text-muted-foreground/60 group-hover:inline">g {n.key}</span>}
                </Link>
              );
            })}
          </NavGroup>
        ))}
      </nav>
      <div className="border-t px-3.5 py-2.5 text-xs text-muted-foreground">
        <div className="truncate text-foreground">{email}</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="label text-[9.5px]">{role}</span>
          {mock && <span className="rounded-sm bg-warning/15 px-1 font-mono text-[9.5px] uppercase text-warning">mock data</span>}
        </div>
      </div>
    </aside>
  );
}

function NavGroup({ title, collapsed, children }: { title: string; collapsed: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className="mb-3">
      <button onClick={() => setOpen(!open)} className="label mb-1 flex w-full items-center gap-1 px-2 text-[9.5px] hover:text-foreground">
        <ChevronRight className={cn("h-2.5 w-2.5 transition-transform", open && "rotate-90")} />{title}
      </button>
      {open && children}
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(t); }, []);
  if (!now) return <span className="w-24" />;
  return (
    <span className="num hidden font-mono text-[11px] text-muted-foreground sm:inline" title="Desk time (DESK_TIMEZONE)">
      {now.toLocaleString("en-US", { timeZone: deskTimeZone(), weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })} {tzLabel()}
    </span>
  );
}

function Signal({ label, light, text, href, live }: { label: string; light: DeskStatus["engine"]["light"]; text: string; href?: string; live?: boolean }) {
  const body = (
    <span className="flex items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 py-1 hover:bg-accent" title={`${label}: ${text}`}>
      <Led tone={light} live={live} />
      <span className="label text-[9.5px]">{label}</span>
      <span className="max-w-[9rem] truncate font-mono text-[10.5px] text-foreground/80">{text}</span>
    </span>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** The status strip: every system and queue at a glance, refreshed every 15 s. */
export function Topbar({ mock }: { mock: boolean }) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const range = Number(sp.get("range") ?? 30);
  const { data: st, isError } = useStatus();
  const setRange = (r: number) => {
    const q = new URLSearchParams(sp.toString());
    q.set("range", String(r));
    router.push(`${path}?${q}`);
  };
  return (
    <header className="sticky top-0 z-20 flex h-11 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur">
      <div className="grid h-5 w-5 place-items-center rounded-sm bg-primary font-mono text-[10px] font-bold text-primary-foreground md:hidden">W</div>
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {st ? (
          <>
            <Signal label="Engine" light={st.engine.light} text={st.rendering ? `${st.rendering} rendering` : st.engine.text} href="/content/engine" live={st.rendering > 0} />
            <Signal label="Meta" light={st.meta.light} text={st.live ? `${st.live} live` : st.meta.text} href="/calendar" live={st.live > 0} />
            <Signal label="IG" light={st.instagram.light} text={st.instagram.text} href="/results" />
            <Signal label="Reads" light={st.reading ? "info" : "muted"} text={st.reading ? "Claude reading" : "idle"} live={st.reading} />
            <span className="mx-1 h-4 w-px shrink-0 bg-border" />
            <Signal label="Decide" light={st.approvals ? "warning" : "success"} text={String(st.approvals)} href="/command#decide" />
            <Signal label="Alerts" light={st.alerts ? "danger" : "success"} text={String(st.alerts)} href="/command#alerts" live={st.alerts > 0} />
            <Signal label="Today" light={st.postsToday ? "info" : "muted"} text={`${st.postsToday} posts`} href="/calendar" />
          </>
        ) : (
          <span className="label px-1.5">{isError ? "status unavailable" : "connecting…"}</span>
        )}
      </div>
      <div className="hidden items-center gap-0.5 rounded-sm border p-0.5 lg:flex">
        {RANGES.map((r) => (
          <button key={r} onClick={() => setRange(r)} className={cn("rounded-sm px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground", range === r && "bg-accent text-foreground")}>{r}d</button>
        ))}
      </div>
      {mock && <span className="hidden rounded-sm bg-warning/10 px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-warning xl:inline" title="Seeded data; connectors activate when env vars exist">mock</span>}
      <Clock />
      <button onClick={() => window.dispatchEvent(new Event("open-palette"))}
        className="flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
        <Search className="h-3 w-3" /> <span className="hidden sm:inline">Jump</span>
        <kbd className="flex items-center rounded-sm bg-muted px-1 font-mono text-[9.5px]"><CommandIcon className="h-2.5 w-2.5" />K</kbd>
      </button>
    </header>
  );
}

const ACTIONS: { title: string; sub: string; href: string; area: string }[] = [
  { title: "Generate ideas", sub: "Ideas: Claude proposes new ones from the marketing guide", href: "/ideas", area: "content" },
  { title: "Make a video", sub: "Make: from an idea (app ad or raw) or from your footage", href: "/make", area: "content" },
  { title: "Approve and launch", sub: "Launch: post, trial reel, test or ad with a budget", href: "/launch", area: "content" },
  { title: "Check results", sub: "Results: live Meta and Instagram, Improve any post or campaign", href: "/results", area: "growth" },
  { title: "Brainstorm on the map", sub: "Marketing Map", href: "/content/map", area: "content" },
  { title: "Advanced video tools", sub: "Batch builder, templates, clip bin", href: "/content/engine", area: "content" },
];

/** ⌘K / Ctrl+K: jump to any page, action or item. "g" then a key jumps straight to a page. */
export function CommandPalette({ areas }: { areas: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { data: items = [] } = useQuery<PaletteItem[]>({
    queryKey: ["palette"], enabled: open, staleTime: 30_000,
    queryFn: async () => { const r = await fetch("/api/palette"); return r.ok ? r.json() : []; },
  });
  const pages = useMemo(() => NAV.flatMap((g) => g.items).filter((n) => areas.includes(n.area)), [areas]);

  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "g" && !gAt) { gAt = Date.now(); return; }
      if (gAt && Date.now() - gAt < 1200) {
        const hit = pages.find((p) => p.key === e.key.toLowerCase());
        if (hit) { e.preventDefault(); router.push(hit.href); }
      }
      gAt = 0;
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("open-palette", onOpen); };
  }, [pages, router]);
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const m = (s: string) => !t || s.toLowerCase().includes(t);
    return [
      ...pages.filter((p) => m(p.label)).map((p) => ({ kind: "Go to", title: p.label, sub: p.key ? `g ${p.key}` : "", href: p.href })),
      ...ACTIONS.filter((a) => areas.includes(a.area) && (m(a.title) || m(a.sub))).map((a) => ({ kind: "Do", title: a.title, sub: a.sub, href: a.href })),
      ...(t ? items.filter((i) => m(i.title) || m(i.sub ?? "") || m(i.kind)) : items.filter((i) => i.kind === "Approval")).slice(0, 40),
    ].slice(0, 60);
  }, [q, pages, items, areas]);

  const go = useCallback((href: string) => { setOpen(false); router.push(href); }, [router]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={() => setOpen(false)}>
      <div className="w-full max-w-xl overflow-hidden rounded-md border bg-card shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input ref={input} value={q} placeholder="Jump to a page, action, campaign, idea, approval…"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter" && rows[sel]) go(rows[sel].href);
            }}
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          <kbd className="rounded-sm bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <div className="max-h-[55vh] overflow-y-auto py-1">
          {rows.length ? rows.map((r, i) => (
            <button key={`${r.kind}-${r.title}-${i}`} onMouseEnter={() => setSel(i)} onClick={() => go(r.href)}
              className={cn("flex w-full items-center gap-3 px-3 py-1.5 text-left", i === sel && "bg-accent")}>
              <span className="label w-20 shrink-0 text-[9.5px]">{r.kind}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{r.title}</span>
                {r.sub && <span className="block truncate text-[11px] text-muted-foreground">{r.sub}</span>}
              </span>
              {i === sel && <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          )) : <div className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
}

export function SubNav({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <div className="mb-4 flex gap-0.5 border-b">
      {items.map((i) => (
        <Link key={i.href} href={i.href} prefetch className={cn("-mb-px border-b-2 border-transparent px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground", path === i.href && "border-primary text-foreground")}>
          {i.label}
        </Link>
      ))}
    </div>
  );
}
