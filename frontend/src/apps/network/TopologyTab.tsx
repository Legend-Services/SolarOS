import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ArrowRightLeft, Cable, Container, Globe, Layers, Merge, Monitor, Network, RefreshCw, Smartphone, SquareTerminal, Waypoints, Wrench } from "lucide-react";
import { api } from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import { useIntent, useWindows } from "../../lib/stores";
import { useTranslation } from "../../i18n";
import { GlassBadge, GlassButton, Notice } from "../../components/ui/GlassKit";

type NodeType = "internet" | "nic" | "bond" | "bridge" | "vlan" | "vm" | "lxc" | "wireguard" | "peer" | "forward";
interface TNode {
  id: string;
  type: NodeType;
  label: string;
  ip: string | null;
  mac: string | null;
  status: string;
  meta: Record<string, unknown>;
}
interface TEdge {
  id: string;
  source: string;
  target: string;
  kind: "uplink" | "port" | "vnic" | "vpn" | "forward";
  label: string;
}
interface Topology {
  nodes: TNode[];
  edges: TEdge[];
}

/** Column per node type, left to right: Internet → NICs → bonds → bridges → VLANs / VPN / forwards → guests and peers. */
const LAYER: Record<NodeType, number> = { internet: 0, nic: 1, bond: 2, bridge: 3, vlan: 4, wireguard: 4, forward: 4, vm: 5, lxc: 5, peer: 5 };
const STYLE: Record<NodeType, { icon: ReactNode; color: string }> = {
  internet: { icon: <Globe size={14} />, color: "#38bdf8" },
  nic: { icon: <Cable size={14} />, color: "#94a3b8" },
  bond: { icon: <Merge size={14} />, color: "#94a3b8" },
  bridge: { icon: <Network size={14} />, color: "#a78bfa" },
  vlan: { icon: <Layers size={14} />, color: "#c084fc" },
  vm: { icon: <Monitor size={14} />, color: "#34d399" },
  lxc: { icon: <Container size={14} />, color: "#2dd4bf" },
  wireguard: { icon: <Waypoints size={14} />, color: "#f472b6" },
  peer: { icon: <Smartphone size={14} />, color: "#fb7185" },
  forward: { icon: <ArrowRightLeft size={14} />, color: "#fbbf24" },
};
const NODE_W = 176;
const NODE_H = 44;
const COL = 236;
const ROW = 60;
const PAD = 16;
const UP = new Set(["up", "running"]);

/** Columns from the node types (empty columns dropped), rows ordered by the average row of each node's parents. */
export function layout(t: Topology): Map<string, { x: number; y: number }> {
  const used = [...new Set(t.nodes.map((n) => LAYER[n.type]))].sort((a, b) => a - b);
  const col = (n: TNode) => used.indexOf(LAYER[n.type]);
  const row = new Map<string, number>();
  const pos = new Map<string, { x: number; y: number }>();
  used.forEach((_, c) => {
    const nodes = t.nodes.filter((n) => col(n) === c);
    const parent = (n: TNode) => {
      const ys = t.edges.filter((e) => e.target === n.id && row.has(e.source)).map((e) => row.get(e.source)!);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    nodes
      .map((n) => ({ n, p: parent(n) }))
      .sort((a, b) => a.p - b.p || a.n.label.localeCompare(b.n.label))
      .forEach(({ n }, i) => {
        row.set(n.id, i);
        pos.set(n.id, { x: PAD + c * COL, y: PAD + i * ROW });
      });
  });
  return pos;
}

export default function TopologyTab({ onTab }: { onTab: (tab: "router" | "wg") => void }) {
  const { t } = useTranslation();
  const open = useWindows((s) => s.open);
  const go = useIntent((s) => s.go);
  const [topo, setTopo] = useState<Topology | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Topology>("/v1/network/topology").then((x) => (setTopo(x), setError("")), (e) => setError(e.message));
  }, []);
  usePoll(load, 30000);
  const pos = useMemo(() => (topo ? layout(topo) : new Map()), [topo]);

  if (!topo) return <Notice error={error} />;
  if (topo.nodes.length <= 1) return <p className="text-sm text-slate-400">{t("topo.empty")}</p>;

  const near = new Set<string>(sel ? [sel] : []);
  const hot = new Set<string>();
  for (const e of topo.edges)
    if (sel && (e.source === sel || e.target === sel)) (hot.add(e.id), near.add(e.source), near.add(e.target));
  const width = Math.max(...[...pos.values()].map((p) => p.x)) + NODE_W + PAD;
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + NODE_H + PAD;
  const node = topo.nodes.find((n) => n.id === sel) ?? null;
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));

  const actions = (n: TNode): ReactNode => {
    if (n.type === "vm" || n.type === "lxc") {
      const type = n.meta.guest_type as "qemu" | "lxc";
      return (
        <GlassButton size="xs" onClick={() => open("console", { type, vmid: Number(n.meta.vmid), name: n.label, mode: type === "qemu" ? "vnc" : "shell" })}>
          <SquareTerminal size={12} /> {t("topo.openConsole")}
        </GlassButton>
      );
    }
    if (["nic", "bond", "bridge", "vlan"].includes(n.type))
      return (
        <GlassButton size="xs" onClick={() => go("controlpanel", "network")}>
          <Wrench size={12} /> {t("topo.configureBridge")}
        </GlassButton>
      );
    if (n.type === "forward")
      return (
        <GlassButton size="xs" onClick={() => onTab("router")}>
          <ArrowRightLeft size={12} /> {t("topo.editForward")}
        </GlassButton>
      );
    if (n.type === "wireguard" || n.type === "peer")
      return (
        <GlassButton size="xs" onClick={() => onTab("wg")}>
          <Waypoints size={12} /> {t("topo.configureVpn")}
        </GlassButton>
      );
    return null;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">{t("topo.title")}</h3>
        <span className="text-[11px] text-slate-400 max-sm:hidden">{t("topo.hint")}</span>
        <GlassButton variant="ghost" size="xs" onClick={load} aria-label={t("common.refresh")}>
          <RefreshCw size={13} />
        </GlassButton>
      </div>
      <Notice error={error} />
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="glass-soft min-w-0 flex-1 overflow-auto rounded-2xl" onClick={() => setSel(null)}>
          <svg width={width} height={height} role="img" aria-label={t("topo.title")} className="block">
            {topo.edges.map((e) => {
              const a = pos.get(e.source);
              const b = pos.get(e.target);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              const on = hot.has(e.id);
              return (
                <g key={e.id} opacity={sel && !on ? 0.15 : 1}>
                  <path
                    d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke={on ? "#7dd3fc" : STYLE[byId.get(e.target)?.type ?? "nic"].color}
                    strokeOpacity={on ? 1 : 0.55}
                    strokeWidth={on ? 2.5 : 1.5}
                    strokeDasharray={e.kind === "forward" || e.kind === "vpn" ? "5 4" : undefined}
                  />
                  {e.label && on && (
                    <text x={mx} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="fill-slate-200 text-[10px]">
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
            {topo.nodes.map((n) => {
              const p = pos.get(n.id)!;
              const s = STYLE[n.type];
              const up = UP.has(n.status);
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x},${p.y})`}
                  opacity={sel && !near.has(n.id) ? 0.3 : 1}
                  className="cursor-pointer"
                  role="button"
                  tabIndex={0}
                  aria-label={`${t(`topo.type.${n.type}`)} ${n.label}`}
                  aria-pressed={sel === n.id}
                  onClick={(e) => (e.stopPropagation(), setSel(sel === n.id ? null : n.id))}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSel(sel === n.id ? null : n.id))}
                >
                  <rect width={NODE_W} height={NODE_H} rx={12} fill="var(--sd-glass-bg, rgba(15,23,42,.7))" fillOpacity={0.85} stroke={sel === n.id ? "#7dd3fc" : s.color} strokeOpacity={sel === n.id ? 1 : 0.6} strokeWidth={sel === n.id ? 2 : 1} />
                  <rect width={4} height={NODE_H - 16} x={0} y={8} rx={2} fill={s.color} />
                  <foreignObject x={10} y={0} width={NODE_W - 16} height={NODE_H}>
                    <div className="flex h-full items-center gap-2 text-[11px] leading-tight">
                      <span style={{ color: s.color }}>{s.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-100">{n.label}</span>
                        <span className="block truncate text-[10px] text-slate-400">{n.ip ?? t(`topo.type.${n.type}`)}</span>
                      </span>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${up ? "bg-emerald-400" : "bg-slate-500"}`} />
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        </div>
        <aside className="glass-soft w-full shrink-0 space-y-3 rounded-2xl p-4 text-xs lg:w-64">
          {!node ? (
            <p className="text-slate-400">{t("topo.select")}</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span style={{ color: STYLE[node.type].color }}>{STYLE[node.type].icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white">{node.label}</span>
                  <span className="text-[10px] text-slate-400">{t(`topo.type.${node.type}`)}</span>
                </span>
              </div>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-slate-400">{t("topo.ip")}</dt>
                <dd className="truncate font-mono text-slate-100">{node.ip ?? "—"}</dd>
                <dt className="text-slate-400">{t("topo.mac")}</dt>
                <dd className="truncate font-mono text-slate-100">{node.mac ?? "—"}</dd>
                <dt className="text-slate-400">{t("topo.status")}</dt>
                <dd>
                  <GlassBadge tone={UP.has(node.status) ? "success" : "neutral"}>{node.status.toUpperCase()}</GlassBadge>
                </dd>
                {typeof node.meta.comment === "string" && node.meta.comment && (
                  <>
                    <dt className="text-slate-400">#</dt>
                    <dd className="truncate text-slate-100">{node.meta.comment}</dd>
                  </>
                )}
              </dl>
              <div>
                <div className="mb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{t("topo.connections")}</div>
                <ul className="space-y-1">
                  {topo.edges
                    .filter((e) => e.source === node.id || e.target === node.id)
                    .map((e) => {
                      const other = byId.get(e.source === node.id ? e.target : e.source);
                      return other ? (
                        <li key={e.id}>
                          <button onClick={() => setSel(other.id)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-white/10">
                            <span style={{ color: STYLE[other.type].color }}>{STYLE[other.type].icon}</span>
                            <span className="min-w-0 flex-1 truncate text-slate-200">{other.label}</span>
                            {e.label && <span className="shrink-0 text-[10px] text-slate-500">{e.label}</span>}
                          </button>
                        </li>
                      ) : null;
                    })}
                </ul>
              </div>
              <div className="flex flex-wrap gap-2">{actions(node)}</div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
