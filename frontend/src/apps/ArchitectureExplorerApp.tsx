import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { ArrowLeft, Boxes, Cable, Cctv, CircleHelp, Container, Cpu, FlaskConical, Globe, HardDrive, Layers, Maximize2, Monitor, Network, Printer, Radar, RefreshCw, Router, Search, Server, Smartphone, Tv, Wifi, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../lib/api";
import { useTranslation, type TKey } from "../i18n";
import { GlassBadge, GlassButton, GlassInput, GlassSelect, Notice, Segmented } from "../components/ui/GlassKit";

/* Shapes of /api/architecture (backend/app/architecture.py). */
interface NetworkInfo {
  network_id: string;
  kind: "switch" | "vlan" | "lab";
  name: string;
  bridge: string;
  vlan_id: number | null;
  host_cidr: string | null;
  subnet_cidr: string | null;
  gateway_ip: string | null;
  dhcp_active: boolean;
  dhcp_range: string | null;
  dns_servers: string[];
  color: string | null;
  clustered: boolean;
  vlan_aware: boolean;
}
interface GuestRow {
  guest_type: "vm" | "lxc";
  guest_id: number;
  name: string;
  status: string;
  host: string;
  ha: boolean;
  standby_hosts: string[];
  lab_id: string | null;
  interfaces: { net_id: string; bridge: string; vlan_tag: number | null; ip_address: string | null; mac_address: string | null; link_up: boolean }[];
}
interface Overview {
  mode: "standalone" | "cluster";
  cluster_name: string | null;
  quorum_status: "healthy" | "lost" | null;
  floating_vips: { address: string; label?: string; bridge: string; preferred_host?: string }[];
  hosts: { host_id: string; hostname: string; ip_addresses: string[]; role: string; status: string; cpu_pct: number | null; ram_pct: number | null; local: boolean }[];
  uplinks: { name: string; mac: string; link_up: boolean; speed_mbps: number | null; bridge: string | null }[];
  gateways: { ip: string; dev: string; mac: string | null; mac_vendor: string | null }[];
  lldp_neighbors: { local_port: string; neighbor: string; protocol: string | null; neighbor_port: string | null }[];
  host_dns_servers: string[];
  switches: { name: string; vlan_aware: boolean; clustered: boolean; ipv4_cidr: string | null; mode: string; member_ports: string[]; comment: string }[];
  vlans: NetworkInfo[];
  labs: (NetworkInfo & { lab_id: string; members: { guest_type: string; guest_id: number; net_id: string }[] })[];
  networks: NetworkInfo[];
  guests: GuestRow[];
  node: string;
}
export interface ScannedDevice {
  ip_address: string;
  mac_address: string | null;
  mac_vendor: string | null;
  hostname: string | null;
  display_name: string;
  device_category: Category;
  is_managed_guest: boolean;
  is_solardeck_host: boolean;
  guest: { guest_type: string; guest_id: number; name: string } | null;
  roles: string[];
  functionality_summary: string;
  open_ports: { port: number; protocol: string; service_name: string; purpose_description: string }[];
}
interface Scan {
  status: "idle" | "running" | "done" | "failed";
  progress?: number;
  devices: ScannedDevice[];
  finished_at?: number | null;
  error?: string;
  gateway_ip?: string | null;
}
type Category = "router_gateway" | "switch_ap" | "server_hypervisor" | "workstation_pc" | "mobile_tablet" | "printer_scanner" | "camera_nvr" | "media_tv" | "nas_storage" | "iot_device" | "unknown";

export const CATEGORY_ICON: Record<Category, (s: number) => ReactNode> = {
  router_gateway: (s) => <Router size={s} />,
  switch_ap: (s) => <Wifi size={s} />,
  server_hypervisor: (s) => <Server size={s} />,
  workstation_pc: (s) => <Monitor size={s} />,
  mobile_tablet: (s) => <Smartphone size={s} />,
  printer_scanner: (s) => <Printer size={s} />,
  camera_nvr: (s) => <Cctv size={s} />,
  media_tv: (s) => <Tv size={s} />,
  nas_storage: (s) => <HardDrive size={s} />,
  iot_device: (s) => <Cpu size={s} />,
  unknown: (s) => <CircleHelp size={s} />,
};
const CATEGORIES = Object.keys(CATEGORY_ICON) as Category[];
/** Above this many unmanaged devices the drill-down groups them into one "Other Devices (+N)" hub. */
export const DENSITY_THRESHOLD = 6;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;

/** Functionality badge text in the active language, from the scanner's role keys. */
export function useRoleText() {
  const { t } = useTranslation();
  return (d: Pick<ScannedDevice, "roles" | "device_category">) => {
    const roles = d.roles.filter((r) => r !== "managed_guest" && r !== "discovery");
    if (!roles.length) return t(`arch.catFallback.${d.device_category}` as TKey);
    const text = roles.map((r) => t(`arch.role.${r}` as TKey));
    return text.slice(0, 3).join(", ") + (text.length > 3 ? " …" : "");
  };
}

/* ---------------- Pan / zoom ---------------- */

function usePanZoom() {
  const ref = useRef<HTMLDivElement>(null);
  const [v, setV] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setV((p) => {
        const k = Math.min(3, Math.max(0.3, p.k * (e.deltaY < 0 ? 1.1 : 0.9)));
        return { k, x: mx - ((mx - p.x) * k) / p.k, y: my - ((my - p.y) * k) / p.k };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const handlers = {
    onPointerDown: (e: RPointerEvent) => {
      if ((e.target as Element).closest("[data-node]")) return;
      drag.current = { x: e.clientX - v.x, y: e.clientY - v.y };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: RPointerEvent) => drag.current && setV((p) => ({ ...p, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y })),
    onPointerUp: () => (drag.current = null),
  };
  const zoom = (f: number) => setV((p) => ({ ...p, k: Math.min(3, Math.max(0.3, p.k * f)) }));
  return { ref, v, handlers, zoom, reset: () => setV({ x: 0, y: 0, k: 1 }) };
}

function Canvas({ width, height, children, label }: { width: number; height: number; children: ReactNode; label: string }) {
  const { t } = useTranslation();
  const pz = usePanZoom();
  return (
    <div ref={pz.ref} className="relative h-full min-h-[420px] overflow-hidden rounded-xl border border-sky-400/20 bg-[#06142b] touch-none" {...pz.handlers}>
      <svg width="100%" height="100%" className="absolute inset-0 cursor-grab select-none active:cursor-grabbing" role="img" aria-label={label}>
        <defs>
          <pattern id="arch-grid" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform={`translate(${pz.v.x} ${pz.v.y}) scale(${pz.v.k})`}>
            <path d="M24 0H0V24" fill="none" stroke="#38bdf8" strokeOpacity=".07" />
          </pattern>
        </defs>
        <style>{`@keyframes archdash{to{stroke-dashoffset:-24}}.arch-flow{stroke-dasharray:6 6;animation:archdash 1.4s linear infinite}
          @media (prefers-reduced-motion:reduce){.arch-flow{animation:none}}[data-node]{cursor:pointer}[data-node]:focus{outline:none}[data-node]:focus-visible>rect,[data-node]:focus-visible>circle{stroke:#fde047}`}</style>
        <rect width="100%" height="100%" fill="url(#arch-grid)" />
        <g transform={`translate(${pz.v.x} ${pz.v.y}) scale(${pz.v.k})`}>
          <rect width={width} height={height} fill="none" />
          {children}
        </g>
      </svg>
      <div className="absolute bottom-3 right-3 flex gap-1">
        <GlassButton size="xs" onClick={() => pz.zoom(1.2)} aria-label={t("arch.zoomIn")}>
          <ZoomIn size={14} />
        </GlassButton>
        <GlassButton size="xs" onClick={() => pz.zoom(1 / 1.2)} aria-label={t("arch.zoomOut")}>
          <ZoomOut size={14} />
        </GlassButton>
        <GlassButton size="xs" onClick={pz.reset} aria-label={t("arch.resetView")}>
          <Maximize2 size={14} />
        </GlassButton>
      </div>
    </div>
  );
}

/** One schematic box: icon, title, subtitle and optional badges; clickable when `onClick` is given. */
function NodeBox({ x, y, w = 190, h = 58, icon, title, sub, color = "#7dd3fc", badges = [], dashed, onClick, label }: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  icon: ReactNode;
  title: string;
  sub?: string;
  color?: string;
  badges?: { text: string; on: boolean }[];
  dashed?: boolean;
  onClick?: () => void;
  label?: string;
}) {
  const act = onClick ? { "data-node": "", role: "button", tabIndex: 0, "aria-label": label ?? title, onClick, onKeyDown: (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick()) } : { "data-node": "" };
  return (
    <g {...act}>
      <rect x={x} y={y} width={w} height={h} rx={10} fill="#0b2244" fillOpacity=".85" stroke={color} strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} />
      <g transform={`translate(${x + 10} ${y + 10})`} color={color}>
        {icon}
      </g>
      <text x={x + 32} y={y + 22} fill="#f0f9ff" fontSize={12} fontWeight={600}>
        {clip(title, Math.floor((w - 40) / 7))}
      </text>
      {sub && (
        <text x={x + 10} y={y + 40} fill="#bae6fd" fillOpacity=".8" fontSize={10} fontFamily="ui-monospace,monospace">
          {clip(sub, Math.floor((w - 16) / 6))}
        </text>
      )}
      {badges.map((b, i) => (
        <g key={b.text}>
          <rect x={x + w - 48 * (badges.length - i) - 4} y={y + h - 16} width={44} height={13} rx={6.5} fill={b.on ? "#166534" : "#1e293b"} stroke={b.on ? "#4ade80" : "#475569"} strokeWidth={0.8} />
          <text x={x + w - 48 * (badges.length - i) + 18} y={y + h - 6.5} fill={b.on ? "#bbf7d0" : "#94a3b8"} fontSize={8.5} textAnchor="middle" fontWeight={600}>
            {b.text}
          </text>
        </g>
      ))}
    </g>
  );
}

/* ---------------- View 1: blueprint ---------------- */

const COL = [40, 280, 520, 780, 1040];
const NODE_W = 200;

function Blueprint({ o, onDrill }: { o: Overview; onDrill: (id: string) => void }) {
  const { t } = useTranslation();
  const net = (id: string) => o.networks.find((n) => n.network_id === id);
  const labBridges = new Set(o.labs.map((l) => l.bridge));
  const switches = o.switches.filter((s) => !labBridges.has(s.name));
  const TOP = 190;
  const stack = <T,>(items: T[], step: number) => items.map((it, i) => ({ it, y: TOP + i * step }));
  const gws = stack([...o.gateways.map((g) => ({ kind: "gw" as const, g })), ...o.lldp_neighbors.map((l) => ({ kind: "lldp" as const, l }))], 76);
  const ups = stack(o.uplinks, 76);
  const sws = stack(switches, 86);
  const segs = stack([...o.vlans.map((v) => ({ kind: "vlan" as const, v })), ...o.labs.map((l) => ({ kind: "lab" as const, l }))], 86);
  const gs = stack(o.guests, 64);
  const height = Math.max(TOP + 100, ...[gws, ups, sws, segs, gs].map((c) => TOP + c.length * 86)) + 40;
  const mid = (y: number, h = 58) => y + h / 2;
  const yOf = {
    up: Object.fromEntries(ups.map((u) => [u.it.name, u.y])),
    sw: Object.fromEntries(sws.map((s) => [s.it.name, s.y])),
    seg: Object.fromEntries(segs.map((s) => [s.it.kind === "vlan" ? `${s.it.v.bridge}:${s.it.v.vlan_id}` : `lab:${s.it.l.bridge}`, s.y])),
  };
  const edges: { d: string; color: string; flow: boolean }[] = [];
  gws.forEach(({ it, y }) => {
    if (it.kind === "gw") {
      const ty = yOf.sw[it.g.dev] ?? yOf.up[it.g.dev];
      if (ty !== undefined) edges.push({ d: curve(COL[0] + NODE_W, mid(y), it.g.dev in yOf.sw ? COL[2] : COL[1], mid(ty)), color: "#38bdf8", flow: true });
    } else if (yOf.up[it.l.local_port] !== undefined) edges.push({ d: curve(COL[0] + NODE_W, mid(y), COL[1], mid(yOf.up[it.l.local_port])), color: "#94a3b8", flow: false });
  });
  ups.forEach(({ it, y }) => it.bridge && yOf.sw[it.bridge] !== undefined && edges.push({ d: curve(COL[1] + NODE_W, mid(y), COL[2], mid(yOf.sw[it.bridge])), color: it.link_up ? "#38bdf8" : "#475569", flow: it.link_up }));
  segs.forEach(({ it, y }) => it.kind === "vlan" && yOf.sw[it.v.bridge] !== undefined && edges.push({ d: curve(COL[2] + NODE_W, mid(yOf.sw[it.v.bridge]), COL[3], mid(y)), color: it.v.color || "#c084fc", flow: false }));
  gs.forEach(({ it, y }) =>
    it.interfaces.forEach((i) => {
      const seg = labBridges.has(i.bridge) ? yOf.seg[`lab:${i.bridge}`] : i.vlan_tag ? yOf.seg[`${i.bridge}:${i.vlan_tag}`] : undefined;
      const sy = seg ?? yOf.sw[i.bridge];
      if (sy === undefined) return;
      edges.push({ d: curve(seg !== undefined ? COL[3] + NODE_W : COL[2] + NODE_W, mid(sy), COL[4], mid(y, 48)), color: labBridges.has(i.bridge) ? "#f59e0b" : "#34d399", flow: i.link_up && it.status === "running" });
    }),
  );
  const heads = [t("arch.colGateways"), t("arch.colUplinks"), t("arch.colSwitches"), t("arch.colVlans"), t("arch.colGuests")];
  const hostW = Math.max(260, Math.min(1240 / Math.max(o.hosts.length, 1) - 16, 300));

  return (
    <Canvas width={1260} height={height} label={t("arch.blueprintLabel")}>
      {/* Standalone host / cluster band */}
      <rect x={20} y={14} width={1240} height={140} rx={14} fill="#1e1b4b" fillOpacity=".4" stroke="#a78bfa" strokeDasharray={o.mode === "cluster" ? undefined : "5 4"} />
      <text x={36} y={38} fill="#ede9fe" fontSize={13} fontWeight={700}>
        {o.mode === "cluster" ? t("arch.clusterTitle", { name: o.cluster_name ?? "" }) : t("arch.standaloneTitle")}
      </text>
      {o.quorum_status && (
        <text x={36} y={56} fill={o.quorum_status === "healthy" ? "#86efac" : "#fca5a5"} fontSize={10.5}>
          {o.quorum_status === "healthy" ? t("arch.quorumHealthy") : t("arch.quorumLost")}
        </text>
      )}
      {o.floating_vips.length > 0 && (
        <text x={1244} y={38} fill="#c4b5fd" fontSize={10.5} textAnchor="end">
          {`${t("arch.floatingVips")}: ${o.floating_vips.map((v) => v.address).join(" · ")}`}
        </text>
      )}
      {o.hosts.map((h, i) => (
        <NodeBox
          key={h.host_id}
          x={36 + i * (hostW + 12)}
          y={68}
          w={hostW}
          h={74}
          color={h.status === "online" ? "#a78bfa" : h.status === "maintenance" ? "#f59e0b" : "#f87171"}
          icon={<Server size={14} />}
          title={`${h.hostname} · ${t(`arch.hostRole.${h.role}` as TKey)}`}
          sub={`${h.ip_addresses.join(", ") || "—"} · CPU ${h.cpu_pct ?? "—"}% · RAM ${h.ram_pct ?? "—"}%`}
          badges={[{ text: t(`arch.hostStatus.${h.status}` as TKey), on: h.status === "online" }]}
        />
      ))}

      {heads.map((hd, i) => (
        <text key={hd} x={COL[i]} y={TOP - 14} fill="#7dd3fc" fillOpacity=".7" fontSize={10} fontWeight={700} letterSpacing={1.2}>
          {hd.toUpperCase()}
        </text>
      ))}
      {edges.map((e, i) => (
        <path key={i} d={e.d} fill="none" stroke={e.color} strokeWidth={1.6} strokeOpacity=".85" className={e.flow ? "arch-flow" : ""} />
      ))}
      {gws.map(({ it, y }) =>
        it.kind === "gw" ? (
          <NodeBox key={`gw${it.g.ip}`} x={COL[0]} y={y} w={NODE_W} icon={<Globe size={14} />} title={t("arch.gateway", { ip: it.g.ip })} sub={`${it.g.mac ?? ""}${it.g.mac_vendor ? ` · ${it.g.mac_vendor}` : ""}` || it.g.dev} color="#38bdf8" />
        ) : (
          <NodeBox key={`l${it.l.local_port}`} x={COL[0]} y={y} w={NODE_W} icon={<Router size={14} />} title={it.l.neighbor || t("arch.physicalSwitch")} sub={`${it.l.protocol ?? "LLDP"} · ${it.l.neighbor_port ?? ""}`} color="#94a3b8" />
        ),
      )}
      {ups.map(({ it, y }) => (
        <NodeBox key={it.name} x={COL[1]} y={y} w={NODE_W} icon={<Cable size={14} />} title={it.name} sub={`${it.speed_mbps ? `${it.speed_mbps} Mb/s` : t("arch.noLink")} · ${it.mac}`} color={it.link_up ? "#38bdf8" : "#475569"} />
      ))}
      {sws.map(({ it, y }) => {
        const n = net(it.name);
        return (
          <NodeBox
            key={it.name}
            x={COL[2]}
            y={y}
            w={NODE_W}
            h={66}
            icon={<Network size={14} />}
            title={`${it.name}${it.clustered ? " ⧉" : ""}`}
            sub={it.ipv4_cidr ?? t("arch.noHostAddress")}
            color="#a78bfa"
            badges={[{ text: "DHCP", on: !!n?.dhcp_active }, { text: "DNS", on: !!(n?.dns_servers.length || (it.ipv4_cidr && o.host_dns_servers.length && o.gateways.some((g) => g.dev === it.name))) }]}
            onClick={() => onDrill(it.name)}
            label={t("arch.drillInto", { name: it.name })}
          />
        );
      })}
      {segs.map(({ it, y }) =>
        it.kind === "vlan" ? (
          <NodeBox key={it.v.network_id} x={COL[3]} y={y} w={NODE_W} h={66} icon={<Layers size={14} />} title={`VLAN ${it.v.vlan_id} · ${it.v.name}`} sub={it.v.subnet_cidr ?? t("arch.noSubnet")} color={it.v.color || "#c084fc"} badges={[{ text: "DHCP", on: it.v.dhcp_active }, { text: "DNS", on: it.v.dns_servers.length > 0 }]} onClick={() => onDrill(it.v.network_id)} label={t("arch.drillInto", { name: it.v.name })} />
        ) : (
          <NodeBox key={it.l.network_id} x={COL[3]} y={y} w={NODE_W} h={66} dashed icon={<FlaskConical size={14} />} title={`${t("arch.lab")} · ${it.l.name}`} sub={it.l.subnet_cidr ?? ""} color="#f59e0b" badges={[{ text: "DHCP", on: it.l.dhcp_active }]} onClick={() => onDrill(it.l.network_id)} label={t("arch.drillInto", { name: it.l.name })} />
        ),
      )}
      {gs.map(({ it, y }) => (
        <NodeBox
          key={`${it.guest_type}${it.guest_id}`}
          x={COL[4]}
          y={y}
          w={NODE_W}
          h={48}
          icon={it.guest_type === "vm" ? <Monitor size={14} /> : <Container size={14} />}
          title={`${it.name}${it.ha ? " · HA" : ""}`}
          sub={`${it.interfaces.map((i) => i.ip_address).filter(Boolean).join(", ") || it.status}${o.mode === "cluster" ? ` · ${it.host}` : ""}`}
          color={it.status === "running" ? "#34d399" : "#64748b"}
        />
      ))}
    </Canvas>
  );
}

/* ---------------- View 2: network drill-down ---------------- */

function DeviceCard({ d }: { d: ScannedDevice }) {
  const { t } = useTranslation();
  const roleText = useRoleText();
  const [open, setOpen] = useState(false);
  return (
    <li className="glass-soft rounded-xl p-3">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-sky-300/40 text-sky-200">{CATEGORY_ICON[d.device_category](18)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-white">{d.display_name}</span>
            {d.is_managed_guest && <GlassBadge tone="success">{t("arch.managed")}</GlassBadge>}
            {d.is_solardeck_host && <GlassBadge tone="info">{t("arch.role.solardeck_host")}</GlassBadge>}
          </div>
          <div className="font-mono text-[11px] text-slate-300">
            {d.ip_address} · {d.mac_address ?? "—"}
          </div>
          <div className="text-[11px] text-slate-400">
            {t(`arch.cat.${d.device_category}` as TKey)}
            {d.mac_vendor ? ` · ${d.mac_vendor}` : ""}
          </div>
          <div className="mt-1">
            <GlassBadge tone="info">{roleText(d)}</GlassBadge>
          </div>
        </div>
      </div>
      {d.open_ports.length > 0 && (
        <div className="mt-2">
          <button className="flex flex-wrap gap-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("arch.portsToggle", { n: d.open_ports.length })}>
            {d.open_ports.map((p) => (
              <span key={p.port} className="rounded-md border border-sky-300/30 bg-sky-400/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-100">
                {p.port}/{p.protocol}
              </span>
            ))}
          </button>
          {open && (
            <ul className="mt-2 space-y-1 text-[11px]">
              {d.open_ports.map((p) => (
                <li key={p.port} className="flex gap-2">
                  <span className="w-20 shrink-0 font-mono text-sky-200">
                    {p.port}/{p.protocol}
                  </span>
                  <span className="text-slate-300">
                    <b className="text-slate-100">{p.service_name}</b> — {t(`port.${p.port}` as TKey) || p.purpose_description}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function DevicesDrawer({ devices, onClose }: { devices: ScannedDevice[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<"" | Category>("");
  const list = devices.filter(
    (d) => (!cat || d.device_category === cat) && (!q || [d.display_name, d.ip_address, d.mac_address, d.mac_vendor, d.functionality_summary, ...d.open_ports.map((p) => String(p.port))].some((s) => s?.toLowerCase().includes(q.toLowerCase()))),
  );
  return (
    <aside className="glass-strong absolute bottom-0 right-0 top-0 z-10 flex w-[440px] max-w-full flex-col gap-2 border-l border-sky-400/20 bg-slate-950/95 p-3 backdrop-blur-xl" aria-label={t("arch.devicesTitle")}>
      <div className="flex items-center gap-2">
        <h4 className="flex-1 text-sm font-semibold text-white">{t("arch.devicesTitle")}</h4>
        <GlassBadge>{list.length}</GlassBadge>
        <GlassButton size="xs" onClick={onClose}>
          {t("common.close")}
        </GlassButton>
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-2 text-slate-400" />
          <GlassInput className="w-full pl-7" placeholder={t("arch.searchDevices")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("arch.searchDevices")} />
        </div>
        <GlassSelect value={cat} onChange={(e) => setCat(e.target.value as Category | "")} aria-label={t("arch.filterCategory")}>
          <option value="">{t("arch.allCategories")}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`arch.cat.${c}` as TKey)}
            </option>
          ))}
        </GlassSelect>
      </div>
      <ul className="flex-1 space-y-2 overflow-y-auto pr-1">
        {list.map((d) => (
          <DeviceCard key={d.ip_address} d={d} />
        ))}
        {!list.length && <li className="p-4 text-center text-xs text-slate-400">{t("arch.noDevices")}</li>}
      </ul>
    </aside>
  );
}

function DrillDown({ o, id, onBack }: { o: Overview; id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const n = o.networks.find((x) => x.network_id === id);
  const [scan, setScan] = useState<Scan>({ status: "idle", devices: [] });
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Scan>(`/architecture/networks/${encodeURIComponent(id)}/devices`).then(setScan, (e) => setError(e.message)), [id]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (scan.status !== "running") return;
    const h = setInterval(load, 1500);
    return () => clearInterval(h);
  }, [scan.status, load]);
  const start = () => api(`/architecture/networks/${encodeURIComponent(id)}/scan`, { method: "POST" }).then(() => (setError(""), load()), (e) => setError(e.message));

  const onNet = useMemo(
    () =>
      o.guests.filter((g) =>
        g.interfaces.some((i) => (n?.kind === "vlan" ? i.bridge === n.bridge && i.vlan_tag === n.vlan_id : n?.kind === "lab" ? i.bridge === n.bridge : i.bridge === n?.bridge && !i.vlan_tag)),
      ),
    [o.guests, n],
  );
  if (!n) return <Notice error={t("arch.unknownNetwork")} />;
  const hostIp = n.host_cidr?.split("/")[0] ?? null;
  const gwIp = n.gateway_ip ?? scan.gateway_ip ?? null;
  const devs = scan.devices;
  const gwDev = devs.find((d) => d.ip_address === gwIp);
  const dhcpDev = devs.find((d) => d.roles.includes("dhcp"));
  const dnsIp = n.dns_servers[0] ?? devs.find((d) => d.roles.includes("dns"))?.ip_address ?? (gwDev?.roles.includes("dns") ? gwIp : null) ?? (n.kind === "switch" && o.gateways.some((g) => g.dev === n.bridge) ? o.host_dns_servers[0] : null);
  const others = devs.filter((d) => !d.is_managed_guest && !d.is_solardeck_host && d.ip_address !== gwIp);
  const grouped = others.length > DENSITY_THRESHOLD;

  // Star layout around the network hub.
  const CXc = 560;
  const CYc = 330;
  const R = 250;
  type Spoke = { key: string; icon: ReactNode; title: string; sub: string; color: string; onClick?: () => void; dashed?: boolean };
  const spokes: Spoke[] = [
    { key: "gw", icon: <Router size={14} />, title: t("arch.routerGateway"), sub: gwIp ? `${gwIp}${gwDev?.mac_vendor ? ` · ${gwDev.mac_vendor}` : ""}` : t("arch.notDetected"), color: "#38bdf8" },
    { key: "dhcp", icon: <Radar size={14} />, title: t("arch.dhcpServer"), sub: n.dhcp_active ? t("arch.solardeckDhcp", { range: n.dhcp_range ?? "" }) : dhcpDev ? dhcpDev.ip_address : t("arch.notDetected"), color: n.dhcp_active || dhcpDev ? "#4ade80" : "#64748b" },
    { key: "dns", icon: <Globe size={14} />, title: t("arch.dnsServer"), sub: dnsIp ?? t("arch.notDetected"), color: dnsIp ? "#4ade80" : "#64748b" },
    { key: "host", icon: <Server size={14} />, title: t("arch.solardeckHost", { name: o.node }), sub: hostIp ?? t("arch.noHostAddress"), color: "#a78bfa" },
    ...onNet.map((g) => ({
      key: `g${g.guest_type}${g.guest_id}`,
      icon: g.guest_type === "vm" ? <Monitor size={14} /> : <Container size={14} />,
      title: g.name,
      sub: g.interfaces.find((i) => i.bridge === n.bridge)?.ip_address ?? g.status,
      color: g.status === "running" ? "#34d399" : "#64748b",
    })),
    ...(grouped
      ? [{ key: "others", icon: <Boxes size={14} />, title: t("arch.otherDevices", { n: others.length }), sub: t("arch.openExplorer"), color: "#fbbf24", onClick: () => setDrawer(true), dashed: true }]
      : others.map((d) => ({ key: d.ip_address, icon: CATEGORY_ICON[d.device_category](14), title: d.display_name, sub: d.ip_address, color: "#fbbf24", onClick: () => setDrawer(true) }))),
  ];
  const pos = spokes.map((_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / spokes.length;
    return { x: CXc + R * Math.cos(a) * 1.35 - 95, y: CYc + R * Math.sin(a) - 29 };
  });

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <GlassButton size="xs" onClick={onBack}>
          <ArrowLeft size={13} /> {t("arch.backToBlueprint")}
        </GlassButton>
        <h3 className="text-sm font-semibold text-white">{n.name}</h3>
        <span className="font-mono text-[11px] text-slate-400">{n.subnet_cidr ?? t("arch.noSubnet")}</span>
        <GlassBadge tone={n.dhcp_active ? "success" : "neutral"}>DHCP</GlassBadge>
        <GlassBadge tone={dnsIp ? "success" : "neutral"}>DNS</GlassBadge>
        <span className="ml-auto text-[11px] text-slate-400">
          {scan.status === "done" && scan.finished_at ? t("arch.lastScan", { time: new Date(scan.finished_at * 1000).toLocaleString() }) : scan.status === "failed" ? t("arch.scanFailed") : ""}
        </span>
        <GlassButton size="xs" onClick={() => setDrawer(true)} disabled={!devs.length}>
          {t("arch.showDevices", { n: devs.length })}
        </GlassButton>
        <GlassButton size="xs" variant="primary" onClick={start} disabled={scan.status === "running" || !n.host_cidr}>
          <Radar size={13} /> {t("arch.scanNow")}
        </GlassButton>
      </div>
      {scan.status === "running" && (
        <div className="space-y-1" role="status">
          <div className="text-[11px] text-sky-200">{t("arch.scanning", { pct: Math.round(scan.progress ?? 0) })}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-sky-400 transition-[width] duration-500" style={{ width: `${scan.progress ?? 0}%` }} />
          </div>
        </div>
      )}
      <Notice error={error || (scan.status === "failed" ? scan.error : "") || (!n.host_cidr ? t("arch.needHostAddress") : "")} />
      <div className="relative min-h-0 flex-1">
        <Canvas width={1120} height={680} label={t("arch.drillLabel", { name: n.name })}>
          {pos.map((p, i) => (
            <path key={spokes[i].key} d={`M${CXc} ${CYc} L${p.x + 95} ${p.y + 29}`} stroke={spokes[i].color} strokeOpacity=".7" strokeWidth={1.4} className={spokes[i].key === "others" ? "" : "arch-flow"} fill="none" />
          ))}
          <g data-node="">
            <circle cx={CXc} cy={CYc} r={62} fill="#0b2244" stroke={n.color || "#a78bfa"} strokeWidth={2} />
            <g transform={`translate(${CXc - 9} ${CYc - 36})`} color={n.color || "#c4b5fd"}>
              {n.kind === "lab" ? <FlaskConical size={18} /> : n.kind === "vlan" ? <Layers size={18} /> : <Network size={18} />}
            </g>
            <text x={CXc} y={CYc + 2} fill="#f0f9ff" fontSize={12} fontWeight={700} textAnchor="middle">
              {clip(n.kind === "vlan" ? `VLAN ${n.vlan_id}` : n.bridge, 16)}
            </text>
            <text x={CXc} y={CYc + 18} fill="#bae6fd" fontSize={9.5} textAnchor="middle" fontFamily="ui-monospace,monospace">
              {n.subnet_cidr ?? ""}
            </text>
          </g>
          {spokes.map((s, i) => (
            <NodeBox key={s.key} x={pos[i].x} y={pos[i].y} icon={s.icon} title={s.title} sub={s.sub} color={s.color} dashed={s.dashed} onClick={s.onClick} />
          ))}
        </Canvas>
        {drawer && <DevicesDrawer devices={devs} onClose={() => setDrawer(false)} />}
      </div>
    </div>
  );
}

/* ---------------- App ---------------- */

export default function ArchitectureExplorerApp() {
  const { t } = useTranslation();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"blueprint" | "networks">("blueprint");
  const [drill, setDrill] = useState<string | null>(null);
  const load = useCallback(() => api<Overview>("/architecture/overview").then((r) => (setO(r), setError("")), (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={drill ? "networks" : view}
          onChange={(v) => (setView(v), setDrill(null))}
          options={[
            { id: "blueprint", label: t("arch.viewBlueprint") },
            { id: "networks", label: t("arch.viewNetworks") },
          ]}
        />
        {o && (
          <GlassBadge tone={o.mode === "cluster" ? "info" : "neutral"}>
            {o.mode === "cluster" ? t("arch.clusterTitle", { name: o.cluster_name ?? "" }) : t("arch.standaloneTitle")}
          </GlassBadge>
        )}
        <GlassButton size="xs" className="ml-auto" onClick={load} aria-label={t("common.refresh")}>
          <RefreshCw size={13} /> {t("common.refresh")}
        </GlassButton>
      </div>
      <Notice error={error} />
      {!o ? (
        !error && <p className="text-sm text-slate-400">{t("common.loading")}</p>
      ) : drill ? (
        <DrillDown key={drill} o={o} id={drill} onBack={() => setDrill(null)} />
      ) : view === "blueprint" ? (
        <div className="min-h-0 flex-1">
          <Blueprint o={o} onDrill={setDrill} />
        </div>
      ) : (
        <ul className="grid gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {o.networks.map((n) => (
            <li key={n.network_id}>
              <button className="glass-soft w-full rounded-xl p-3 text-left transition hover:bg-white/10" onClick={() => setDrill(n.network_id)}>
                <div className="flex items-center gap-2">
                  <span style={{ color: n.color ?? "#a78bfa" }}>{n.kind === "lab" ? <FlaskConical size={15} /> : n.kind === "vlan" ? <Layers size={15} /> : <Network size={15} />}</span>
                  <span className="flex-1 truncate text-sm font-semibold text-white">{n.kind === "vlan" ? `VLAN ${n.vlan_id} · ${n.name}` : n.name}</span>
                  <GlassBadge tone={n.dhcp_active ? "success" : "neutral"}>DHCP</GlassBadge>
                  <GlassBadge tone={n.dns_servers.length ? "success" : "neutral"}>DNS</GlassBadge>
                </div>
                <div className="mt-1 font-mono text-[11px] text-slate-400">{n.subnet_cidr ?? t("arch.noSubnet")}</div>
                <div className="text-[11px] text-slate-400">{t(`arch.kind.${n.kind}` as TKey)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
