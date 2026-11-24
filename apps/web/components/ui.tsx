// Small shadcn-style primitives (hand-rolled to keep the scaffold dependency-light).
import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "outline" | "ghost" | "destructive" | "secondary";
const variants: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-input bg-transparent hover:bg-accent",
  ghost: "hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  secondary: "bg-muted text-foreground hover:bg-accent",
};

export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "icon" }>(
  ({ className, variant = "default", size = "md", ...p }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        size === "sm" ? "h-7 px-2.5 text-xs" : size === "icon" ? "h-8 w-8" : "h-9 px-3.5",
        variants[variant], className,
      )}
      {...p}
    />
  ),
);
Button.displayName = "Button";

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-md border bg-card/90 text-card-foreground shadow-[0_0_0_1px_hsl(var(--background))]", className)} {...p} />;
}
export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b px-3.5 py-2.5", className)}>
      <div className="min-w-0">
        <h3 className="label leading-tight text-foreground/80">{title}</h3>
        {description && <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function CardBody({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-3.5", className)} {...p} />;
}

const tones = {
  default: "bg-muted text-foreground",
  primary: "bg-primary/15 text-primary",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
  outline: "border text-muted-foreground",
};
export type Tone = keyof typeof tones;
export function Badge({ tone = "default", className, ...p }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wide", tones[tone], className)} {...p} />;
}

export const severityTone = (s: string): Tone => (s === "critical" ? "danger" : s === "error" ? "danger" : s === "warn" ? "warning" : "outline");
export const statusTone = (s: string): Tone =>
  ["connected", "ok", "success", "executed", "approved", "done", "posted", "winner", "resolved", "accepted"].includes(s) ? "success"
  : ["error", "failed", "crashed", "rejected", "retired"].includes(s) ? "danger"
  : ["pending", "running", "rendering", "queued", "testing", "fix_proposed", "building", "scheduled"].includes(s) ? "warning"
  : "outline";

export function Table({ className, ...p }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full text-sm", className)} {...p} />
    </div>
  );
}
export const Th = ({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn("label border-b px-3 py-2 text-left", className)} {...p} />
);
export const Td = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn("border-b border-border/60 px-3 py-2 align-top", className)} {...p} />
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn("h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...p} />
));
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn("w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...p} />
));
Textarea.displayName = "Textarea";

export const Select = ({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cn("h-9 rounded-md border border-input bg-card px-2 text-sm", className)} {...p} />
);

export function PageHeader({ title, description, children }: { title: string; description?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="label text-primary/80">Marketing Engine</div>
        <h1 className="mt-0.5 text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 max-w-3xl text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed p-5 text-center text-[13px] text-muted-foreground">{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="num mt-1 font-mono text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Status light. tone: success (on), warning (attention), danger (down), muted (off / not connected). */
export function Led({ tone = "muted", live = false, className }: { tone?: "success" | "warning" | "danger" | "muted" | "info"; live?: boolean; className?: string }) {
  const c = { success: "bg-success shadow-[0_0_6px_hsl(var(--success))]", warning: "bg-warning shadow-[0_0_6px_hsl(var(--warning))]",
    danger: "bg-destructive shadow-[0_0_6px_hsl(var(--destructive))]", info: "bg-info shadow-[0_0_6px_hsl(var(--info))]", muted: "bg-muted-foreground/50" }[tone];
  return <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", c, live && "live-dot", className)} />;
}
