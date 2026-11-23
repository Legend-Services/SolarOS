import { HISTORY } from "../lib/stores";

export interface Series {
  values: number[];
  color: string;
  label: string;
}

/** Rolling area chart. `stacked` stacks series bottom-up; otherwise they overlap. */
export function AreaChart({ series, max, stacked = false, height = 140 }: { series: Series[]; max?: number; stacked?: boolean; height?: number }) {
  const W = 600;
  const H = height;
  const n = HISTORY;
  const len = Math.max(0, ...series.map((s) => s.values.length));
  const offset = n - len; // right-align: newest sample at the right edge

  const tops: number[][] = [];
  series.forEach((s, si) => tops.push(s.values.map((v, i) => v + (stacked && si > 0 ? tops[si - 1][i] : 0))));
  const peak = max ?? Math.max(1, ...tops.flat()) * 1.15;
  const x = (i: number) => ((i + offset) / (n - 1)) * W;
  const y = (v: number) => H - (Math.min(v, peak) / peak) * H;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" role="img">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="rgba(255,255,255,0.06)" />
      ))}
      {len > 1 &&
        series.map((s, si) => {
          const top = tops[si];
          const base = stacked && si > 0 ? tops[si - 1] : top.map(() => 0);
          const line = top.map((v, i) => `${x(i)},${y(v)}`).join(" ");
          const back = base.map((v, i) => `${x(i)},${y(v)}`).reverse().join(" ");
          return (
            <g key={s.label}>
              <polygon points={`${line} ${back}`} fill={s.color} fillOpacity={0.22} />
              <polyline points={line} fill="none" stroke={s.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
    </svg>
  );
}

export function Legend({ items }: { items: { label: string; color: string; value: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
          {i.label} <span className="tabular-nums text-slate-100">{i.value}</span>
        </span>
      ))}
    </div>
  );
}

export function Gauge({ value, label, sub, color }: { value: number; label: string; sub?: string; color: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-20 w-20">
      <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
        <circle cx={40} cy={40} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={7} />
        <circle
          cx={40}
          cy={40}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums text-white">{v.toFixed(0)}%</div>
      </div>
      <div className="text-xs font-medium text-slate-300">{label}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

export function Bar({ value, className = "bg-sky-400" }: { value: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const tone = v > 90 ? "bg-rose-400" : v > 75 ? "bg-amber-400" : className;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${v}%` }} />
    </div>
  );
}
