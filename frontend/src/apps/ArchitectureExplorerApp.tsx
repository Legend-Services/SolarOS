import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Boxes, ChevronRight, Cable, Cctv, CircleHelp, Container, Cpu, FlaskConical, Globe, HardDrive, Layers, Maximize2, Monitor, Network, Printer, Radar, RefreshCw, Router, Search, Server, Smartphone, Tag, Tv, Wifi, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../lib/api";
import { ink } from "../lib/format";
import { useTranslation, type TKey } from "../i18n";
import { GlassBadge, GlassButton, GlassInput, GlassSelect, Notice, Segmented } from "../components/ui/GlassKit";
import { useIntentFor } from "../lib/stores";
import type { Guest } from "../lib/types";
import GuestDrawer from "./GuestDrawer";

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
/** A network / VLAN / lab or custom compute group (backend/app/compute_groups.py via the overview). */
interface SemanticGroup {
  group_id: string;
  source: "network" | "custom" | "ungrouped";
  kind: "switch" | "vlan" | "lab" | "custom" | "ungrouped";
  name: string;
  color: string;
  linked_network_id: string | null;
  vlan_id: number | null;
  bridge: string | null;
  subnet_cidr: string | null;
  dhcp_active: boolean;
  dns_servers: string[];
  device_count: number;
  total_guests: number;
  running_guests: number;
  members: { guest_type: "vm" | "lxc"; guest_id: number; group_count: number; interfaces: { iface: string; ip: string | null }[] }[];
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
  semantic_groups: SemanticGroup[];
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

type ZoomEvent = { k: number; prev: number; at: { x: number; y: number } | null };
type Crumb = { label: string; onClick?: () => void };
/** Zoom at which the overview opens the group under the pointer (and below which a drill-down returns). */
export const DRILL_ZOOM = 0.75;
const clampK = (k: number) => Math.min(3, Math.max(0.2, k));

function usePanZoom(onZoom?: (e: ZoomEvent) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [v, setV] = useState({ x: 0, y: 0, k: 1 });
  const [smooth, setSmooth] = useState(false);
  const cur = useRef(v);
  const cb = useRef(onZoom);
  cb.current = onZoom;
  const drag = useRef<{ x: number; y: number } | null>(null);
  const set = useCallback((n: { x: number; y: number; k: number }, animate: boolean, at: ZoomEvent["at"] = null) => {
    const prev = cur.current.k;
    cur.current = n;
    setV(n);
    setSmooth(animate);
    if (n.k !== prev) cb.current?.({ k: n.k, prev, at });
  }, []);
  /** Zoom by `f` around a screen point (the canvas center by default); `at` is that point in drawing coordinates. */
  const zoomAt = useCallback((f: number, mx?: number, my?: number, animate = true) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = cur.current;
    const x0 = mx ?? r.width / 2;
    const y0 = my ?? r.height / 2;
    const k = clampK(p.k * f);
    set({ k, x: x0 - ((x0 - p.x) * k) / p.k, y: y0 - ((y0 - p.y) * k) / p.k }, animate, { x: (x0 - p.x) / p.k, y: (y0 - p.y) / p.k });
  }, [set]);
  /** Fit a width × height drawing below the floating bar, never zooming in past `cap`. */
  const fit = useCallback((w: number, h: number, cap: number, animate = true) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const k = clampK(Math.min(cap, (r.width - 32) / w, (r.height - 72) / h));
    set({ k, x: (r.width - w * k) / 2, y: 56 + Math.max(0, (r.height - 72 - h * k) / 2) }, animate);
  }, [set]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top, false);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);
  const handlers = {
    onPointerDown: (e: RPointerEvent) => {
      if ((e.target as Element).closest("[data-node]")) return;
      drag.current = { x: e.clientX - cur.current.x, y: e.clientY - cur.current.y };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: RPointerEvent) => drag.current && set({ ...cur.current, x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }, false),
    onPointerUp: () => (drag.current = null),
  };
  return { ref, v, smooth, handlers, zoomAt, fit };
}

/** Pan / zoom canvas with the floating semantic zoom & breadcrumb bar (crumbs · − zoom % + · Fit to Screen). */
function Canvas({ width, height, children, label, crumbs = [], hint, onZoom, fitCap = 1 }: {
  width: number;
  height: number;
  children: ReactNode;
  label: string;
  crumbs?: Crumb[];
  hint?: string;
  onZoom?: (e: ZoomEvent) => void;
  fitCap?: number;
}) {
  const { t } = useTranslation();
  const pz = usePanZoom(onZoom);
  useEffect(() => {
    // Fit on open and whenever the canvas changes size (window resize, a drawer opening beside it); "Fit to Screen" refits too.
    let r = 0;
    const ro = new ResizeObserver(() => (cancelAnimationFrame(r), (r = requestAnimationFrame(() => pz.fit(width, height, fitCap, false)))));
    if (pz.ref.current) ro.observe(pz.ref.current);
    return () => (cancelAnimationFrame(r), ro.disconnect());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={pz.ref} className="relative h-full min-h-[420px] overflow-hidden rounded-xl border border-[var(--bp-border)] bg-[var(--bp-canvas)] touch-none" {...pz.handlers}>
      <svg width="100%" height="100%" className="absolute inset-0 cursor-grab select-none active:cursor-grabbing" role="img" aria-label={label}>
        <defs>
          <pattern id="arch-grid" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform={`translate(${pz.v.x} ${pz.v.y}) scale(${pz.v.k})`}>
            <path d="M24 0H0V24" fill="none" stroke="var(--bp-grid)" />
          </pattern>
        </defs>
        <style>{`@keyframes archdash{to{stroke-dashoffset:-24}}.arch-flow{stroke-dasharray:6 6;animation:archdash 1.4s linear infinite}
          @media (prefers-reduced-motion:reduce){.arch-flow{animation:none}.arch-stage{transition:none!important}}[data-node]{cursor:pointer}[data-node]:focus{outline:none}[data-node]:focus-visible>rect,[data-node]:focus-visible>circle{stroke:#fde047}`}</style>
        <rect width="100%" height="100%" fill="url(#arch-grid)" />
        <g className="arch-stage" style={{ transform: `translate(${pz.v.x}px, ${pz.v.y}px) scale(${pz.v.k})`, transformOrigin: "0 0", transition: pz.smooth ? "transform .35s cubic-bezier(.22,1,.36,1)" : undefined }}>
          <rect width={width} height={height} fill="none" />
          {children}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-center gap-2">
        {crumbs.length > 0 && (
          <nav data-node="" className="pointer-events-auto flex items-center gap-1 rounded-xl border border-sky-400/20 bg-slate-950/85 px-2 py-1 text-[11px] backdrop-blur" aria-label={t("sz.overview")}>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="text-slate-500" />}
                {c.onClick ? (
                  <button className="rounded px-1 text-sky-300 hover:text-white hover:underline" onClick={c.onClick}>
                    {c.label}
                  </button>
                ) : (
                  <span className="px-1 font-semibold text-white" aria-current="page">
                    {c.label}
                  </span>
                )}
              </span>
            ))}
            {hint && <span className="ml-2 hidden text-slate-400 md:inline">{hint}</span>}
          </nav>
        )}
        <div data-node="" className="pointer-events-auto ml-auto flex items-center gap-1 rounded-xl border border-sky-400/20 bg-slate-950/85 px-1.5 py-1 backdrop-blur">
          <GlassButton size="xs" onClick={() => pz.zoomAt(1 / 1.2)} aria-label={t("arch.zoomOut")}>
            <ZoomOut size={14} />
          </GlassButton>
          <span className="w-11 text-center text-[11px] text-sky-100 tabular-nums" aria-live="polite" aria-label={t("sz.zoomPct", { pct: Math.round(pz.v.k * 100) })}>
            {Math.round(pz.v.k * 100)}%
          </span>
          <GlassButton size="xs" onClick={() => pz.zoomAt(1.2)} aria-label={t("arch.zoomIn")}>
            <ZoomIn size={14} />
          </GlassButton>
          <GlassButton size="xs" onClick={() => pz.fit(width, height, fitCap)} aria-label={t("sz.fit")}>
            <Maximize2 size={14} /> <span className="hidden sm:inline">{t("sz.fit")}</span>
          </GlassButton>
        </div>
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
      <rect x={x} y={y} width={w} height={h} rx={10} fill="var(--bp-node)" fillOpacity=".85" stroke={ink(color)} strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} />
      <g transform={`translate(${x + 10} ${y + 10})`} color={ink(color)}>
        {icon}
      </g>
      <text x={x + 32} y={y + 22} fill="var(--bp-text)" fontSize={12} fontWeight={600}>
        {clip(title, Math.floor((w - 40) / 7))}
      </text>
      {sub && (
        <text x={x + 10} y={y + 40} fill="var(--bp-text-2)" fontSize={10} fontFamily="ui-monospace,monospace">
          {clip(sub, Math.floor((w - 16) / 6))}
        </text>
      )}
      {badges.map((b, i) => (
        <g key={b.text}>
          <rect x={x + w - 48 * (badges.length - i) - 4} y={y + h - 16} width={44} height={13} rx={6.5} fill={b.on ? "var(--bp-pill-on)" : "var(--bp-pill-off)"} stroke={b.on ? "var(--bp-pill-on-stroke)" : "var(--bp-pill-off-stroke)"} strokeWidth={0.8} />
          <text x={x + w - 48 * (badges.length - i) + 18} y={y + h - 6.5} fill={b.on ? "var(--bp-pill-on-text)" : "var(--bp-pill-off-text)"} fontSize={8.5} textAnchor="middle" fontWeight={600}>
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

/** The standalone host or cluster band across the top of the blueprint and the overview. */
function HostBand({ o }: { o: Overview }) {
  const { t } = useTranslation();
  const hostW = Math.max(260, Math.min(1240 / Math.max(o.hosts.length, 1) - 16, 300));
  return (
    <>
      <rect x={20} y={14} width={1240} height={140} rx={14} fill="var(--bp-node-violet)" stroke={ink("#a78bfa")} strokeDasharray={o.mode === "cluster" ? undefined : "5 4"} />
      <text x={36} y={38} fill="var(--bp-violet-text)" fontSize={13} fontWeight={700}>
        {o.mode === "cluster" ? t("arch.clusterTitle", { name: o.cluster_name ?? "" }) : t("arch.standaloneTitle")}
      </text>
      {o.quorum_status && (
        <text x={36} y={56} fill={o.quorum_status === "healthy" ? "var(--bp-ok-text)" : "var(--bp-bad-text)"} fontSize={10.5}>
          {o.quorum_status === "healthy" ? t("arch.quorumHealthy") : t("arch.quorumLost")}
        </text>
      )}
      {o.floating_vips.length > 0 && (
        <text x={1244} y={38} fill="var(--bp-violet-text)" fontSize={10.5} textAnchor="end">
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

    </>
  );
}

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

  return (
    <Canvas width={1260} height={height} label={t("arch.blueprintLabel")} crumbs={[{ label: t("arch.viewBlueprint") }]}>
      <HostBand o={o} />

      {heads.map((hd, i) => (
        <text key={hd} x={COL[i]} y={TOP - 14} fill="var(--bp-label)" fontSize={10} fontWeight={700} letterSpacing={1.2}>
          {hd.toUpperCase()}
        </text>
      ))}
      {edges.map((e, i) => (
        <path key={i} d={e.d} fill="none" stroke={ink(e.color)} strokeWidth={1.6} strokeOpacity=".85" className={e.flow ? "arch-flow" : ""} />
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


/* ---------------- Zoom level 1: semantic overview ---------------- */

const CARD_W = 250;
const CARD_H = 116;
const CARD_GAP = 22;
const CARD_X = 600;
const CARD_COLS = 3;
const KIND_ORDER = { switch: 0, vlan: 1, lab: 2, custom: 3, ungrouped: 4 };
const SOURCE_ORDER = { network: 0, custom: 1, ungrouped: 2 };

/** Small rounded label for SVG cards (DHCP / DNS service badges). */
function Pill({ x, y, text, on }: { x: number; y: number; text: string; on: boolean }) {
  const w = text.length * 5.6 + 14;
  return (
    <g>
      <rect x={x} y={y} width={w} height={15} rx={7.5} fill={on ? "var(--bp-pill-on)" : "var(--bp-pill-off)"} stroke={on ? "var(--bp-pill-on-stroke)" : "var(--bp-pill-off-stroke)"} strokeWidth={0.8} />
      <text x={x + w / 2} y={y + 10.5} fill={on ? "var(--bp-pill-on-text)" : "var(--bp-pill-off-text)"} fontSize={9} textAnchor="middle" fontWeight={600}>
        {text}
      </text>
    </g>
  );
}

const groupIcon = (kind: SemanticGroup["kind"], s: number) =>
  kind === "lab" ? <FlaskConical size={s} /> : kind === "vlan" ? <Layers size={s} /> : kind === "switch" ? <Network size={s} /> : <Tag size={s} />;

/** Hosts, uplinks and virtual switches, with every network / VLAN / lab and custom group collapsed into one clickable card. */
function SemanticOverview({ o, onOpen }: { o: Overview; onOpen: (groupId: string) => void }) {
  const { t } = useTranslation();
  const labBridges = new Set(o.labs.map((l) => l.bridge));
  const switches = o.switches.filter((s) => !labBridges.has(s.name));
  // Cards follow the switch column order (then labs), so the switch → card lines cross as little as possible.
  const swIndex = (g: SemanticGroup) => {
    const i = switches.findIndex((s) => s.name === g.bridge);
    return i < 0 ? switches.length : i;
  };
  const groups = o.semantic_groups
    .filter((g) => g.source !== "ungrouped" || g.total_guests > 0)
    .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || swIndex(a) - swIndex(b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.vlan_id ?? 0) - (b.vlan_id ?? 0) || a.name.localeCompare(b.name));
  const TOP = 190;
  const ups = o.uplinks.map((u, i) => ({ u, y: TOP + i * 76 }));
  const sws = switches.map((sw, i) => ({ sw, y: TOP + i * 86 }));
  const cards = groups.map((g, i) => ({ g, x: CARD_X + (i % CARD_COLS) * (CARD_W + CARD_GAP), y: TOP + Math.floor(i / CARD_COLS) * (CARD_H + CARD_GAP) }));
  const width = CARD_X + CARD_COLS * (CARD_W + CARD_GAP) + 20;
  const height = Math.max(TOP + Math.ceil(cards.length / CARD_COLS) * (CARD_H + CARD_GAP), TOP + sws.length * 86, TOP + ups.length * 76, TOP + 100) + 40;
  const swY = Object.fromEntries(sws.map((x) => [x.sw.name, x.y]));
  const bridgeOf = (g: SemanticGroup) => g.bridge ?? o.networks.find((n) => n.network_id === g.linked_network_id)?.bridge;
  const origin = (g: SemanticGroup) =>
    g.source === "custom" ? t("grp.customGroup") : g.source === "ungrouped" ? "" : t("grp.networkGroup", { label: t(`grp.kind.${g.kind}` as TKey, { id: g.vlan_id ?? "" }) });
  const name = (g: SemanticGroup) => (g.source === "ungrouped" ? t("grp.ungrouped") : g.name);

  // Zooming in past DRILL_ZOOM opens the card under the pointer (or the one nearest to the zoom point).
  const onZoom = ({ k, prev, at }: ZoomEvent) => {
    if (!at || prev >= DRILL_ZOOM || k < DRILL_ZOOM || !cards.length) return;
    const d = (c: (typeof cards)[number]) => Math.hypot(c.x + CARD_W / 2 - at.x, c.y + CARD_H / 2 - at.y);
    const near = cards.reduce((a, b) => (d(b) < d(a) ? b : a));
    if (d(near) < CARD_W * 1.2) onOpen(near.g.group_id);
  };

  return (
    <Canvas width={width} height={height} label={t("arch.blueprintLabel")} crumbs={[{ label: t("sz.overview") }]} hint={t("sz.hint")} onZoom={onZoom} fitCap={DRILL_ZOOM - 0.04}>
      <HostBand o={o} />
      {[t("arch.colUplinks"), t("arch.colSwitches"), t("sz.colGroups")].map((hd, i) => (
        <text key={hd} x={[40, 300, CARD_X][i]} y={TOP - 14} fill="var(--bp-label)" fontSize={10} fontWeight={700} letterSpacing={1.2}>
          {hd.toUpperCase()}
        </text>
      ))}
      {ups.map(({ u, y }) =>
        u.bridge && swY[u.bridge] !== undefined ? <path key={`e${u.name}`} d={curve(240, y + 29, 300, swY[u.bridge] + 29)} fill="none" stroke={ink(u.link_up ? "#38bdf8" : "#475569")} strokeWidth={1.6} className={u.link_up ? "arch-flow" : ""} /> : null,
      )}
      {cards.map(({ g, x, y }) => {
        const b = bridgeOf(g);
        return b && swY[b] !== undefined ? <path key={`e${g.group_id}`} d={curve(500, swY[b] + 33, x, y + CARD_H / 2)} fill="none" stroke={ink(g.color)} strokeOpacity=".6" strokeWidth={1.4} /> : null;
      })}
      {ups.map(({ u, y }) => (
        <NodeBox key={u.name} x={40} y={y} w={200} icon={<Cable size={14} />} title={u.name} sub={`${u.speed_mbps ? `${u.speed_mbps} Mb/s` : t("arch.noLink")} · ${u.mac}`} color={u.link_up ? "#38bdf8" : "#475569"} />
      ))}
      {sws.map(({ sw, y }) => (
        <NodeBox key={sw.name} x={300} y={y} w={200} h={66} icon={<Network size={14} />} title={`${sw.name}${sw.clustered ? " ⧉" : ""}`} sub={sw.ipv4_cidr ?? t("arch.noHostAddress")} color="#a78bfa" onClick={() => onOpen(`net-${sw.name}`)} label={t("sz.zoomInto", { name: sw.name })} />
      ))}
      {cards.map(({ g, x, y }) => (
        <g
          key={g.group_id}
          data-node=""
          role="button"
          tabIndex={0}
          aria-label={t("sz.zoomInto", { name: name(g) })}
          onClick={() => onOpen(g.group_id)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(g.group_id))}
        >
          <rect x={x} y={y} width={CARD_W} height={CARD_H} rx={14} fill="var(--bp-node)" fillOpacity=".9" stroke={ink(g.color)} strokeWidth={1.5} strokeDasharray={g.source === "network" && g.kind !== "lab" ? undefined : "5 4"} />
          <rect x={x} y={y + 14} width={5} height={CARD_H - 28} rx={2.5} fill={ink(g.color)} />
          <g transform={`translate(${x + 16} ${y + 14})`} color={ink(g.color)}>
            {groupIcon(g.kind, 16)}
          </g>
          <text x={x + 40} y={y + 27} fill="var(--bp-text)" fontSize={13} fontWeight={700}>
            {clip(name(g), 26)}
          </text>
          <text x={x + 16} y={y + 48} fill="var(--bp-text-2)" fontSize={10}>
            {clip(origin(g), 40)}
          </text>
          <text x={x + 16} y={y + 66} fill="var(--bp-text)" fontSize={10.5} fontFamily="ui-monospace,monospace">
            {g.subnet_cidr ?? (g.source === "network" ? t("arch.noSubnet") : "")}
          </text>
          {g.source === "network" && (
            <>
              <Pill x={x + 16} y={y + CARD_H - 28} text="DHCP" on={g.dhcp_active} />
              <Pill x={x + 62} y={y + CARD_H - 28} text="DNS" on={g.dns_servers.length > 0} />
            </>
          )}
          <text x={x + CARD_W - 14} y={y + CARD_H - 30} fill="var(--bp-ok-text)" fontSize={10.5} fontWeight={600} textAnchor="end">
            {t("grp.nodes", { n: g.total_guests })}
          </text>
          <text x={x + CARD_W - 14} y={y + CARD_H - 16} fill="var(--bp-warn-text)" fontSize={10} textAnchor="end">
            {t("grp.devices", { n: g.device_count })}
          </text>
        </g>
      ))}
    </Canvas>
  );
}

/* ---------------- Zoom level 2: network / group drill-down (level 3: guest drawer and device explorer) ---------------- */

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
    <aside
      className="flex max-h-[50vh] w-full shrink-0 flex-col gap-2 rounded-xl border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-panel)] p-3 lg:max-h-full lg:w-[400px] xl:w-[440px]"
      aria-label={t("arch.devicesTitle")}
    >
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

function DrillDown({ o, group, root, onBack }: { o: Overview; group: SemanticGroup; root: string; onBack: () => void }) {
  const { t } = useTranslation();
  const id = group.linked_network_id;
  const n = id ? o.networks.find((x) => x.network_id === id) : undefined;
  const title = group.source === "ungrouped" ? t("grp.ungrouped") : group.name;
  const [scan, setScan] = useState<Scan>({ status: "idle", devices: [] });
  const [drawer, setDrawer] = useState(false);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => (n ? api<Scan>(`/architecture/networks/${encodeURIComponent(n.network_id)}/devices`).then(setScan, (e) => setError(e.message)) : Promise.resolve()), [n]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (scan.status !== "running") return;
    const h = setInterval(load, 1500);
    return () => clearInterval(h);
  }, [scan.status, load]);
  const start = () => n && api(`/architecture/networks/${encodeURIComponent(n.network_id)}/scan`, { method: "POST" }).then(() => (setError(""), load()), (e) => setError(e.message));
  // Level 3: the guest's hardware & console drawer (guests of other cluster hosts are managed from Compute Manager).
  const openGuest = (gt: string, vmid: number) =>
    api<Guest[]>("/v1/guests").then((list) => setGuest(list.find((g) => g.vmid === vmid && (g.type === "qemu") === (gt === "vm")) ?? null), (e) => setError(e.message));

  const byKey = new Map(o.guests.map((g) => [`${g.guest_type}:${g.guest_id}`, g]));
  const members = group.members.flatMap((m) => {
    const g = byKey.get(`${m.guest_type}:${m.guest_id}`);
    return g ? [{ m, g }] : [];
  });
  const hostIp = n?.host_cidr?.split("/")[0] ?? null;
  const gwIp = n ? (n.gateway_ip ?? scan.gateway_ip ?? null) : null;
  const devs = scan.devices;
  const gwDev = devs.find((d) => d.ip_address === gwIp);
  const dhcpDev = devs.find((d) => d.roles.includes("dhcp"));
  const dnsIp = !n
    ? null
    : (n.dns_servers[0] ??
      devs.find((d) => d.roles.includes("dns"))?.ip_address ??
      (gwDev?.roles.includes("dns") ? gwIp : null) ??
      (n.kind === "switch" && o.gateways.some((g) => g.dev === n.bridge) ? o.host_dns_servers[0] : null));
  const others = devs.filter((d) => !d.is_managed_guest && !d.is_solardeck_host && d.ip_address !== gwIp);
  const grouped = others.length > DENSITY_THRESHOLD;

  // Star layout around the network / group hub.
  const CXc = 560;
  const CYc = 330;
  const R = 250;
  type Spoke = { key: string; icon: ReactNode; title: string; sub: string; color: string; onClick?: () => void; dashed?: boolean; badges?: { text: string; on: boolean }[] };
  const services: Spoke[] = n
    ? [
        { key: "gw", icon: <Router size={14} />, title: t("arch.routerGateway"), sub: gwIp ? `${gwIp}${gwDev?.mac_vendor ? ` · ${gwDev.mac_vendor}` : ""}` : t("arch.notDetected"), color: "#38bdf8" },
        { key: "dhcp", icon: <Radar size={14} />, title: t("arch.dhcpServer"), sub: n.dhcp_active ? t("arch.solardeckDhcp", { range: n.dhcp_range ?? "" }) : dhcpDev ? dhcpDev.ip_address : t("arch.notDetected"), color: n.dhcp_active || dhcpDev ? "#4ade80" : "#64748b" },
        { key: "dns", icon: <Globe size={14} />, title: t("arch.dnsServer"), sub: dnsIp ?? t("arch.notDetected"), color: dnsIp ? "#4ade80" : "#64748b" },
        { key: "host", icon: <Server size={14} />, title: t("arch.solardeckHost", { name: o.node }), sub: hostIp ?? t("arch.noHostAddress"), color: "#a78bfa" },
      ]
    : [];
  const spokes: Spoke[] = [
    ...services,
    ...members.map(({ m, g }) => {
      const nic = m.interfaces[0];
      return {
        key: `g${g.guest_type}${g.guest_id}`,
        icon: g.guest_type === "vm" ? <Monitor size={14} /> : <Container size={14} />,
        title: g.name,
        sub: nic ? `${nic.iface} · ${nic.ip ?? g.status}` : g.status,
        color: g.status === "running" ? "#34d399" : "#64748b",
        onClick: () => openGuest(g.guest_type, g.guest_id),
        badges: m.group_count > 1 ? [{ text: t("sz.multiHomed", { n: m.group_count }), on: true }] : [],
      };
    }),
    ...(grouped
      ? [{ key: "others", icon: <Boxes size={14} />, title: t("arch.otherDevices", { n: others.length }), sub: t("arch.openExplorer"), color: "#fbbf24", onClick: () => setDrawer(true), dashed: true }]
      : others.map((d) => ({ key: d.ip_address, icon: CATEGORY_ICON[d.device_category](14), title: d.display_name, sub: d.ip_address, color: "#fbbf24", onClick: () => setDrawer(true) }))),
  ];
  const pos = spokes.map((_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(spokes.length, 1);
    return { x: CXc + R * Math.cos(a) * 1.35 - 95, y: CYc + R * Math.sin(a) - 29 };
  });
  // Zooming well back out returns to the overview (hysteresis below DRILL_ZOOM so a drill-in does not bounce back).
  const BACK = DRILL_ZOOM - 0.25;
  // Only a user zoom (it has a focus point) leaves the view; fitting the canvas to a new size never does.
  const onZoom = ({ k, prev, at }: ZoomEvent) => at && prev >= BACK && k < BACK && onBack();

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: group.color }} />
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {n && <span className="font-mono text-[11px] text-slate-400">{n.subnet_cidr ?? t("arch.noSubnet")}</span>}
        {n && <GlassBadge tone={n.dhcp_active ? "success" : "neutral"}>DHCP</GlassBadge>}
        {n && <GlassBadge tone={dnsIp ? "success" : "neutral"}>DNS</GlassBadge>}
        <GlassBadge tone="info">{t("grp.nodes", { n: members.length })}</GlassBadge>
        <span className="ml-auto text-[11px] text-slate-400">
          {scan.status === "done" && scan.finished_at ? t("arch.lastScan", { time: new Date(scan.finished_at * 1000).toLocaleString() }) : scan.status === "failed" ? t("arch.scanFailed") : ""}
        </span>
        {n && (
          <>
            <GlassButton size="xs" onClick={() => setDrawer(true)} disabled={!devs.length}>
              {t("arch.showDevices", { n: devs.length })}
            </GlassButton>
            <GlassButton size="xs" variant="primary" onClick={start} disabled={scan.status === "running" || !n.host_cidr}>
              <Radar size={13} /> {t("arch.scanNow")}
            </GlassButton>
          </>
        )}
      </div>
      {scan.status === "running" && (
        <div className="space-y-1" role="status">
          <div className="text-[11px] text-sky-200">{t("arch.scanning", { pct: Math.round(scan.progress ?? 0) })}</div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-sky-400 transition-[width] duration-500" style={{ width: `${scan.progress ?? 0}%` }} />
          </div>
        </div>
      )}
      <Notice error={error || (scan.status === "failed" ? scan.error : "") || (n && !n.host_cidr ? t("arch.needHostAddress") : "")} notice={n ? "" : t("sz.noNetwork")} />
      {/* The device explorer sits beside the canvas (below it on narrow screens), never over its nodes. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Canvas width={1120} height={680} label={t("arch.drillLabel", { name: title })} crumbs={[{ label: root, onClick: onBack }, { label: title }]} onZoom={onZoom}>
            {pos.map((p, i) => (
              <path key={spokes[i].key} d={`M${CXc} ${CYc} L${p.x + 95} ${p.y + 29}`} stroke={ink(spokes[i].color)} strokeOpacity=".7" strokeWidth={1.4} className={spokes[i].key === "others" ? "" : "arch-flow"} fill="none" />
            ))}
            <g data-node="">
              <circle cx={CXc} cy={CYc} r={62} fill="var(--bp-node)" stroke={ink(group.color)} strokeWidth={2} />
              <g transform={`translate(${CXc - 9} ${CYc - 36})`} color={ink(group.color)}>
                {groupIcon(group.kind, 18)}
              </g>
              <text x={CXc} y={CYc + 2} fill="var(--bp-text)" fontSize={12} fontWeight={700} textAnchor="middle">
                {clip(n ? (n.kind === "vlan" ? `VLAN ${n.vlan_id}` : n.bridge) : title, 16)}
              </text>
              <text x={CXc} y={CYc + 18} fill="var(--bp-text-2)" fontSize={9.5} textAnchor="middle" fontFamily="ui-monospace,monospace">
                {n?.subnet_cidr ?? ""}
              </text>
            </g>
            {spokes.map((s, i) => (
              <NodeBox key={s.key} x={pos[i].x} y={pos[i].y} icon={s.icon} title={s.title} sub={s.sub} color={s.color} dashed={s.dashed} onClick={s.onClick} badges={s.badges} />
            ))}
          </Canvas>
        </div>
        {drawer && <DevicesDrawer devices={devs} onClose={() => setDrawer(false)} />}
      </div>
      <GuestDrawer guest={guest} onClose={() => setGuest(null)} onSaved={() => {}} />
    </div>
  );
}

/* ---------------- App ---------------- */

export default function ArchitectureExplorerApp() {
  const { t } = useTranslation();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"overview" | "blueprint" | "networks">("overview");
  const [drill, setDrill] = useState<string | null>(null);
  const load = useCallback(() => api<Overview>("/architecture/overview").then((r) => (setO(r), setError("")), (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  useIntentFor("architect", (groupId) => setDrill(groupId));
  const group = drill ? o?.semantic_groups.find((g) => g.group_id === drill) : undefined;
  const root = view === "blueprint" ? t("arch.viewBlueprint") : view === "networks" ? t("arch.viewNetworks") : t("sz.overview");

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <style>{`@keyframes sz-in{from{opacity:0;transform:scale(.96)}}.sz-enter{animation:sz-in .35s cubic-bezier(.22,1,.36,1)}@media (prefers-reduced-motion:reduce){.sz-enter{animation:none}}`}</style>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={(v) => (setView(v), setDrill(null))}
          options={[
            { id: "overview", label: t("sz.viewOverview") },
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
      ) : drill && group ? (
        <div key={drill} className="sz-enter min-h-0 flex-1">
          <DrillDown o={o} group={group} root={root} onBack={() => setDrill(null)} />
        </div>
      ) : view === "overview" ? (
        <div key="overview" className="sz-enter min-h-0 flex-1">
          <SemanticOverview o={o} onOpen={setDrill} />
        </div>
      ) : view === "blueprint" ? (
        <div className="min-h-0 flex-1">
          <Blueprint o={o} onDrill={(id) => setDrill(`net-${id}`)} />
        </div>
      ) : (
        <ul className="grid gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {o.semantic_groups
            .filter((g) => g.source !== "ungrouped" || g.total_guests > 0)
            .map((g) => (
              <li key={g.group_id}>
                <button className="glass-soft w-full rounded-xl p-3 text-left transition hover:bg-white/10" onClick={() => setDrill(g.group_id)}>
                  <div className="flex items-center gap-2">
                    <span style={{ color: g.color }}>{groupIcon(g.kind, 15)}</span>
                    <span className="flex-1 truncate text-sm font-semibold text-white">{g.source === "ungrouped" ? t("grp.ungrouped") : g.name}</span>
                    {g.source === "network" && <GlassBadge tone={g.dhcp_active ? "success" : "neutral"}>DHCP</GlassBadge>}
                    {g.source === "network" && <GlassBadge tone={g.dns_servers.length ? "success" : "neutral"}>DNS</GlassBadge>}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-slate-400">{g.subnet_cidr ?? (g.source === "network" ? t("arch.noSubnet") : "")}</div>
                  <div className="text-[11px] text-slate-400">
                    {g.source === "network" ? t(`arch.kind.${g.kind}` as TKey) : g.source === "custom" ? t("grp.customGroup") : t("grp.ungroupedHint")} · {t("grp.nodes", { n: g.total_guests })} · {t("grp.devices", { n: g.device_count })}
                  </div>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
