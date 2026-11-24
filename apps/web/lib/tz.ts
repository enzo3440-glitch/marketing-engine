/**
 * The desk's clock. Days, posting hours and ad schedules follow DESK_TIMEZONE (an IANA name such as
 * "America/New_York" or "Europe/London"; default UTC). Pure functions, safe in any runtime.
 */
export const deskTimeZone = (): string => {
  const tz = process.env.DESK_TIMEZONE || "UTC"; // inlined at build time by next.config.mjs (env)
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
};

/** Milliseconds to add to a UTC instant to get the desk's wall clock at that instant (negative west of UTC). */
export function tzOffsetMs(at: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: deskTimeZone(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(at / 1000) * 1000;
}

/** "+HH:MM" / "-HH:MM" for a desk-local date, for ISO strings like `${day}T23:59:00${tzSuffix(day)}`. */
export function tzSuffix(day?: string): string {
  const at = day ? Date.parse(`${day}T12:00:00Z`) : Date.now();
  const m = Math.round(tzOffsetMs(at) / 60_000), a = Math.abs(m);
  return `${m < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** YYYY-MM-DD on the desk's clock for an ISO instant. */
export const deskDay = (iso: string | number): string => {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  return new Date(t + tzOffsetMs(t)).toISOString().slice(0, 10);
};

/** Today on the desk's clock. */
export const deskToday = (): string => deskDay(Date.now());

/** Short label for the clock, e.g. "UTC" or "EST". */
export const tzLabel = (): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: deskTimeZone(), timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? deskTimeZone();
