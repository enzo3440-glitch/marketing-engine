import { deskTimeZone, tzOffsetMs } from "./tz";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

const TZ = deskTimeZone();

export const fmt = {
  usd: (n: number | null | undefined, digits = 0) =>
    n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits }),
  num: (n: number | null | undefined, digits = 0) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits })),
  compact: (n: number | null | undefined) => (n == null ? "—" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)),
  pct: (n: number | null | undefined, digits = 1) => (n == null ? "—" : `${(n * 100).toFixed(digits)}%`),
  signedPct: (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`),
  date: (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }) : "—"),
  time: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }) : "—"),
  dateTime: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ }) : "—"),
  ago: (iso: string | null | undefined) => {
    if (!iso) return "never";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },
};

/** Today on the desk clock (DESK_TIMEZONE), YYYY-MM-DD. */
export const hstToday = () => new Date(Date.now() + tzOffsetMs()).toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() + tzOffsetMs() - n * 86400_000).toISOString().slice(0, 10);

export const RANGES = [7, 30, 90] as const;
export function parseRange(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return (RANGES as readonly number[]).includes(n) ? n : 30;
}
