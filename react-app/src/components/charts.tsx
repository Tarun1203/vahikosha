// Small, dependency-free charts for the dashboard: horizontal bars, daily
// columns and a segmented bar — plain HTML, thin marks with 4px rounded ends,
// a 2px gap between touching parts, a hover tooltip on every mark, and the
// value written beside each bar so nothing depends on colour alone.
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { inr } from "@/lib/format";
import { cn } from "@/lib/utils";

// one-hue blue ramp (validated: monotone lightness, visible steps, light end ≥ 2:1 on white)
export const RAMP4 = ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
export const SERIES = "#2a78d6";
export const MUTED_MARK = "#c9c8c2";

// ₹950 · ₹12.5K · ₹1.2L · ₹3.4Cr
export function shortInr(n: number) {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  const f = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ""));
  if (a >= 1e7) return s + "₹" + f(a / 1e7) + "Cr";
  if (a >= 1e5) return s + "₹" + f(a / 1e5) + "L";
  if (a >= 1e3) return s + "₹" + f(a / 1e3) + "K";
  return s + "₹" + Math.round(a);
}

function Tip({ children, x }: { children: ReactNode; x: number }) {
  return (
    <div className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg"
      style={{ left: Math.min(Math.max(x, 8), 92) + "%" }}>{children}</div>
  );
}

// horizontal bars, one per row, value at the tip
export interface BarRow { key: string; label: ReactNode; value: number; color?: string; tip?: ReactNode; aside?: ReactNode; to?: string }
export function HBars({ rows, format = shortInr }: { rows: BarRow[]; format?: (n: number) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const w = Math.max(r.value > 0 ? 1.5 : 0, (r.value / max) * 100);
        const bar = (
          <div className="relative flex items-center gap-2" onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)}>
            <div className="relative h-5 min-w-0 flex-1">
              <div className="absolute inset-y-0.5 left-0 rounded-r-[4px]" style={{ width: w * 0.82 + "%", background: r.color || SERIES }} />
              <span className="absolute top-1/2 -translate-y-1/2 pl-1.5 text-xs font-semibold text-neutral-700 tabular-nums" style={{ left: w * 0.82 + "%" }}>{format(r.value)}</span>
              {hover === r.key && r.tip && <Tip x={Math.min(w * 0.82, 80) / 2}>{r.tip}</Tip>}
            </div>
            {r.aside}
          </div>
        );
        return (
          <div key={r.key}>
            <div className="mb-0.5 truncate text-xs font-medium text-neutral-600">{r.to ? <Link to={r.to} className="hover:text-brand-700 hover:underline">{r.label}</Link> : r.label}</div>
            {bar}
          </div>
        );
      })}
    </div>
  );
}

// daily columns with a recessive axis; labels on the first, middle and last day
export function Columns({ data, height = 140, format = shortInr, tip }: {
  data: { key: string; label: string; value: number }[]; height?: number; format?: (n: number) => string; tip: (d: { key: string; label: string; value: number }) => ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.value), 0);
  // a clean top for the axis: 1, 2, 2.5 or 5 × 10ⁿ
  const top = max <= 0 ? 1 : (() => { const p = 10 ** Math.floor(Math.log10(max)); return ([1, 2, 2.5, 5, 10].find((m) => m * p >= max) || 10) * p; })();
  const ticks = [top, top / 2, 0];
  return (
    <div className="flex gap-2">
      <div className="flex flex-col justify-between pb-5 text-right text-[10px] text-neutral-400 tabular-nums" style={{ height }}>
        {ticks.map((t) => <span key={t} className="-translate-y-1/2 leading-none first:translate-y-0 last:translate-y-0">{max > 0 ? format(t) : ""}</span>)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative border-b border-neutral-200" style={{ height: height - 20 }}>
          <div className="absolute inset-x-0 top-0 border-t border-neutral-100" />
          <div className="absolute inset-x-0 top-1/2 border-t border-neutral-100" />
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {data.map((d, i) => (
              <div key={d.key} className="relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <div className={cn("w-full max-w-[24px] rounded-t-[4px] transition-opacity", hover !== null && hover !== i && "opacity-60")}
                  style={{ height: d.value > 0 ? Math.max(2, (d.value / top) * 100) + "%" : 0, background: SERIES }} />
                {hover === i && <Tip x={50}>{tip(d)}</Tip>}
              </div>
            ))}
          </div>
        </div>
        <div className="relative mt-1 h-4 text-[10px] text-neutral-400">
          {[0, Math.floor((data.length - 1) / 2), data.length - 1].map((i, j) => data[i] && (
            <span key={j} className={cn("absolute", j === 0 ? "left-0" : j === 2 ? "right-0" : "-translate-x-1/2")} style={j === 1 ? { left: ((i + 0.5) / data.length) * 100 + "%" } : undefined}>{data[i].label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// one whole split into parts (2px gaps), with a legend that carries the counts
export function Segmented({ parts }: { parts: { key: string; label: string; value: number; color: string; to?: string }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = parts.reduce((t, p) => t + p.value, 0);
  return (
    <div>
      <div className="relative flex h-4 gap-[2px] overflow-visible">
        {total === 0 ? <div className="h-full w-full rounded-[4px] bg-neutral-100" /> : parts.filter((p) => p.value > 0).map((p, i, arr) => (
          <div key={p.key} className={cn("relative h-full", i === 0 && "rounded-l-[4px]", i === arr.length - 1 && "rounded-r-[4px]")}
            style={{ width: (p.value / total) * 100 + "%", background: p.color }} onMouseEnter={() => setHover(p.key)} onMouseLeave={() => setHover(null)}>
            {hover === p.key && <Tip x={50}>{p.label}: {p.value}</Tip>}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {parts.map((p) => {
          const body = <><span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} /><span className="text-neutral-600">{p.label}</span><b className="text-neutral-900 tabular-nums">{p.value}</b></>;
          return p.to ? <Link key={p.key} to={p.to} className="flex items-center gap-1.5 hover:underline">{body}</Link> : <span key={p.key} className="flex items-center gap-1.5">{body}</span>;
        })}
      </div>
    </div>
  );
}

// a headline number
export function StatTile({ label, value, sub, to, tone }: { label: string; value: string; sub?: ReactNode; to?: string; tone?: "critical" }) {
  const inner = (
    <div className="h-full rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm transition hover:border-brand-200 hover:shadow-md">
      <div className="text-xs font-semibold text-neutral-500">{label}</div>
      <div className={cn("mt-1 text-2xl font-extrabold tracking-tight tabular-nums sm:text-3xl", tone === "critical" ? "text-rose-700" : "text-neutral-900")}>{value}</div>
      {sub && <div className="mt-1 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} className="block h-full">{inner}</Link> : inner;
}

export { inr };
