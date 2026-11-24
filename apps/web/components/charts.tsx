"use client";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { fmt } from "@/lib/utils";

export const C = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];
const axis = { stroke: "hsl(var(--muted-foreground))", fontSize: 11, tickLine: false, axisLine: false } as const;
const grid = <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />;
const tip = {
  contentStyle: { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "hsl(var(--muted-foreground))" },
};
const shortDate = (d: string) => fmt.date(d);

export function Sparkline({ data, positive = true }: { data: { date: string; value: number }[]; positive?: boolean }) {
  const color = positive ? C[0] : "hsl(var(--destructive))";
  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`sp-${positive}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#sp-${positive})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Stacked daily bars by key, optional horizontal reference line. */
export function StackedBars({ data, keys, height = 260, money = true, refY, refLabel }: { data: Record<string, number | string>[]; keys: string[]; height?: number; money?: boolean; refY?: number; refLabel?: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {grid}
        <XAxis dataKey="date" tickFormatter={shortDate} {...axis} minTickGap={24} />
        <YAxis {...axis} width={48} tickFormatter={(v) => (money ? `$${v}` : fmt.compact(v))} />
        <Tooltip {...tip} labelFormatter={shortDate} formatter={(v: number) => (money ? fmt.usd(v, 2) : fmt.num(v))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {keys.map((k, i) => <Bar key={k} dataKey={k} stackId="a" fill={C[i % C.length]} isAnimationActive={false} />)}
        {refY != null && <ReferenceLine y={refY} stroke="hsl(var(--warning))" strokeDasharray="4 4" label={{ value: refLabel, fill: "hsl(var(--warning))", fontSize: 11, position: "insideTopRight" }} />}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Bars on the left axis, line on the right axis. */
export function DualAxis({ data, bar, line, barLabel, lineLabel, height = 260 }: { data: Record<string, number | string>[]; bar: string; line: string; barLabel: string; lineLabel: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {grid}
        <XAxis dataKey="date" tickFormatter={shortDate} {...axis} minTickGap={24} />
        <YAxis yAxisId="l" {...axis} width={48} tickFormatter={(v) => `$${v}`} />
        <YAxis yAxisId="r" orientation="right" {...axis} width={40} />
        <Tooltip {...tip} labelFormatter={shortDate} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="l" dataKey={bar} name={barLabel} fill={C[1]} opacity={0.7} isAnimationActive={false} />
        <Line yAxisId="r" dataKey={line} name={lineLabel} stroke={C[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function LagBars({ data }: { data: { lag: number; r: number }[] }) {
  const best = Math.max(...data.map((d) => d.r));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data.map((d) => ({ ...d, label: `${d.lag}d` }))} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {grid}
        <XAxis dataKey="label" {...axis} />
        <YAxis {...axis} width={36} domain={[-1, 1]} />
        <Tooltip {...tip} formatter={(v: number) => v.toFixed(3)} />
        <ReferenceLine y={0} stroke="hsl(var(--border))" />
        <Bar dataKey="r" name="Pearson r" isAnimationActive={false} radius={2}>
          {data.map((d) => <Cell key={d.lag} fill={d.r === best ? C[0] : "hsl(var(--muted-foreground) / 0.45)"} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function MultiLine({ data, lines, height = 300, money = true, refY, refLabel }: { data: Record<string, number | string>[]; lines: { key: string; label: string; dashed?: boolean }[]; height?: number; money?: boolean; refY?: number; refLabel?: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        {grid}
        <XAxis dataKey="date" tickFormatter={(d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit" })} {...axis} minTickGap={24} />
        <YAxis {...axis} width={56} tickFormatter={(v) => (money ? fmt.compact(v) : fmt.compact(v))} />
        <Tooltip {...tip} formatter={(v: number) => (money ? fmt.usd(v) : fmt.num(v))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {lines.map((l, i) => <Line key={l.key} dataKey={l.key} name={l.label} stroke={C[i % C.length]} strokeWidth={2} strokeDasharray={l.dashed ? "5 4" : undefined} dot={false} isAnimationActive={false} />)}
        {refY != null && <ReferenceLine y={refY} stroke="hsl(var(--warning))" strokeDasharray="4 4" label={{ value: refLabel, fill: "hsl(var(--warning))", fontSize: 11, position: "insideTopLeft" }} />}
      </LineChart>
    </ResponsiveContainer>
  );
}
