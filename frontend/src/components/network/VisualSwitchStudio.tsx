import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFeatureEnabled } from "../../store/featureStore";
import { Cable, CircleHelp, Globe, Layers, Network, Pencil, Plus, RefreshCw, Router, Server, ShieldCheck, Trash2, Undo2, Wifi } from "lucide-react";
import { VipsPanel } from "../cluster/ClusterDialogs";
import { GroupZoomPills } from "../compute/ComputeGroupSection";
import { api, ApiError } from "../../lib/api";
import type { Guest } from "../../lib/types";
import { useTranslation, type TKey } from "../../i18n";
import { Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../ui/GlassKit";
import { OsiDisclosure } from "../osi/OsiArchitecturePanel";
import { osiValues } from "../../data/osiModelRegistry";

/* Visual Virtual Switch studio: every virtual switch as a rack faceplate with draggable port jacks, color-coded VLAN
   drop lanes joined by patch cables, a port inspector and a per-VLAN DHCP panel. Host network edits are staged and
   applied with a 60-second rollback guard (backend app/network_switch.py). */

type VlanMode = "access" | "trunk" | "unassigned";
interface Physical { name: string; mac: string; link_up: boolean; speed_mbps: number | null; driver: string | null; pci_slot: string | null; assigned_bridge: string | null; vlan_mode: VlanMode; access_vlan: number | null; tagged_vlans: number[]; ipv4_cidr: string | null; method: string; mtu: number | null }
interface Bridge { name: string; vlan_aware: boolean; ipv4_cidr: string | null; ipv4_gateway: string | null; ipv6_cidr: string | null; dns_servers: string[]; method: string; mtu: number | null; autostart: boolean; mode: "bridged" | "nat" | "isolated"; member_ports: string[]; comment: string; live: boolean; protected: boolean; clustered?: boolean; synced_hosts?: number }
interface HostVnic { name: string; type: "vlan" | "dummy" | "veth"; parent: string | null; vlan_id: number | null; ipv4_cidr: string | null; method: string; link_up: boolean; assigned_bridge: string | null; vlan_mode: VlanMode; access_vlan: number | null; tagged_vlans: number[] }
interface GuestVnic { guest_id: number; guest_name: string; guest_type: "vm" | "lxc"; status: string; net_id: string; bridge: string; vlan_tag: number | null; trunks: number[]; model: string; mac: string | null; ip_address: string | null; rate_mbps: number | null; link_disconnected: boolean; vlan_mode: VlanMode }
interface Dhcp { enabled: boolean; gateway_ip: string; subnet_mask: string; range_start: string; range_end: string; lease_time: string; dns_servers: string[]; static_leases: { mac: string; ip: string; hostname: string }[] }
interface Vlan { vlan_id: number; name: string; color: string; bridge: string; host_ipv4_cidr: string | null; description: string; dhcp_config: Dhcp | null; dhcp_active: boolean }
interface SwitchState { physical: Physical[]; bridges: Bridge[]; host_vnics: HostVnic[]; guest_vnics: GuestVnic[]; vlans: Vlan[]; default_bridge: string; bridge_prefix: string; pending: boolean; rollback_seconds_left: number | null; dnsmasq_installed: boolean; nic_models: string[]; cluster?: { mode: string; hosts: number } }
interface Lease { ip: string; mac: string; hostname: string; expires_at: number; is_static: boolean }

/** One draggable port on a faceplate. */
interface Port { kind: "physical" | "host_vnic" | "guest_vnic"; id: string; bridge: string | null; label: string; sub: string; mode: VlanMode; access: number | null; tagged: number[]; up: boolean; speed: number | null; physical?: Physical; host?: HostVnic; guest?: GuestVnic }

const DEFAULT_COLOR = "#94a3b8";
/** Quick-select VLAN templates; `reach` drives the WAN / LAN / Management badges in the educational tooltip. */
const PRESETS: { id: number; slug: string; color: string; reach: { wan: boolean; lan: boolean; mgmt: boolean } }[] = [
  { id: 10, slug: "mgmt", color: "#38bdf8", reach: { wan: true, lan: true, mgmt: true } },
  { id: 20, slug: "iot", color: "#22c55e", reach: { wan: true, lan: false, mgmt: false } },
  { id: 30, slug: "guest", color: "#f59e0b", reach: { wan: true, lan: false, mgmt: false } },
  { id: 40, slug: "lab", color: "#a855f7", reach: { wan: true, lan: false, mgmt: false } },
  { id: 50, slug: "cameras", color: "#ef4444", reach: { wan: false, lan: true, mgmt: false } },
  { id: 60, slug: "dmz", color: "#f97316", reach: { wan: true, lan: false, mgmt: false } },
];
type Preset = (typeof PRESETS)[number];
const presetKey = (p: Preset, part?: "desc" | "purpose" | "how") => `vsw.preset.${p.slug}${part ? `.${part}` : ""}` as TKey;
const SWATCHES = ["#38bdf8", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#f97316", "#ec4899", "#14b8a6", "#eab308"];
const DRAG_TYPE = "application/x-solardeck-port";

/* ---------- IPv4 helpers (validation + range bar) */
const ip2n = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m || m.slice(1).some((x) => +x > 255)) return null;
  return m.slice(1).reduce((a, x) => a * 256 + +x, 0);
};
const n2ip = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const maskOf = (prefix: number) => n2ip(prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
const prefixOf = (mask: string) => {
  const n = ip2n(mask);
  return n === null ? 24 : n.toString(2).replace(/0+$/, "").length;
};
const isCidr = (v: string) => {
  const [ip, p] = v.split("/");
  return ip2n(ip ?? "") !== null && p !== undefined && /^\d{1,2}$/.test(p) && +p <= 32;
};
const speedLabel = (mbps: number | null) => (!mbps ? "" : mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`);

function useSwitch() {
  const [state, setState] = useState<SwitchState | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setState(await api<SwitchState>("/network/switch/state"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { state, error, reload };
}

/* ---------- Port jack */
function Jack({ port, color, onOpen, selected }: { port: Port; color: (v: number | null) => string; onOpen: () => void; selected: boolean }) {
  const { t } = useTranslation();
  const ring =
    port.mode === "trunk"
      ? `conic-gradient(${[port.access ?? 1, ...port.tagged].map((v, i, a) => `${color(v)} ${(i / a.length) * 360}deg ${((i + 1) / a.length) * 360}deg`).join(",")})`
      : port.mode === "unassigned"
        ? "rgba(255,255,255,0.08)"
        : color(port.access ?? 1);
  const onDrag = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: port.kind, id: port.id }));
    e.dataTransfer.effectAllowed = "move";
  };
  return (
    <button
      type="button"
      draggable
      onDragStart={onDrag}
      onClick={onOpen}
      data-port={port.id}
      title={`${port.label} — ${t(port.mode === "trunk" ? "vsw.mode.trunk" : port.mode === "access" ? "vsw.mode.access" : "vsw.mode.unassigned")}`}
      className={`group flex w-[92px] cursor-grab flex-col items-center gap-1 rounded-xl p-1.5 text-center transition hover:bg-white/[0.06] active:cursor-grabbing ${selected ? "bg-white/10 ring-1 ring-sky-300/50" : ""}`}
    >
      <span className="relative grid h-11 w-12 place-items-center rounded-lg p-[3px]" style={{ background: ring }}>
        <span className="relative grid h-full w-full place-items-center rounded-md bg-slate-950/90 shadow-[inset_0_2px_6px_rgba(0,0,0,0.8)]">
          {/* RJ45 opening */}
          <span className="mt-1 h-4 w-7 rounded-[3px] bg-black/90 ring-1 ring-white/10 [clip-path:polygon(0_0,100%_0,100%_70%,78%_70%,78%_100%,22%_100%,22%_70%,0_70%)]" />
          <span
            className={`absolute top-1 left-1 h-1.5 w-1.5 rounded-full ${port.up ? "bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.7)]" : "bg-slate-600"}`}
            aria-label={port.up ? t("vsw.linkUp") : t("vsw.linkDown")}
          />
          {port.speed && port.up && <span className="absolute top-0.5 right-1 text-[8px] font-bold text-emerald-200">{speedLabel(port.speed)}</span>}
        </span>
      </span>
      <span className="line-clamp-1 text-[10px] font-medium text-slate-100">{port.label}</span>
      <span className="line-clamp-1 text-[9px] text-slate-400">{port.sub}</span>
    </button>
  );
}

/* ---------- Drop zone */
function DropZone({ id, onDrop, className, children }: { id: string; onDrop: (kind: Port["kind"], portId: string) => void; className: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      data-vlan={id}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        const d = JSON.parse(raw) as { kind: Port["kind"]; id: string };
        onDrop(d.kind, d.id);
      }}
      className={`${className} transition ${over ? "scale-[1.02] ring-2 ring-sky-300/70 shadow-[0_0_24px_rgba(56,189,248,0.35)]" : ""}`}
    >
      {children}
    </div>
  );
}

/* ---------- Patch cables: SVG curves from each port to the VLAN lanes it is on */
function Cables({ root, ports, color, deps }: { root: React.RefObject<HTMLDivElement | null>; ports: Port[]; color: (v: number | null) => string; deps: unknown }) {
  const [paths, setPaths] = useState<{ d: string; c: string; w: number }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const measure = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const at = (sel: string) => el.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
    const out: { d: string; c: string; w: number }[] = [];
    for (const p of ports) {
      if (p.mode === "unassigned") continue;
      const a = at(`[data-port="${CSS.escape(p.id)}"]`);
      if (!a) continue;
      const lanes = p.mode === "trunk" ? [p.access ?? 1, ...p.tagged] : [p.access ?? 1];
      for (const v of lanes) {
        const b = at(`[data-vlan="${v}"]`);
        if (!b) continue;
        const x1 = a.left + a.width / 2 - box.left, y1 = a.top + 44 - box.top + el.scrollTop;
        const x2 = b.left + b.width / 2 - box.left, y2 = b.top - box.top + el.scrollTop;
        const my = (y1 + y2) / 2;
        out.push({ d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, c: color(v), w: p.mode === "trunk" ? 1.5 : 2.2 });
      }
    }
    setPaths(out);
    setSize({ w: el.scrollWidth, h: el.scrollHeight });
  }, [root, ports, color]);
  useLayoutEffect(() => {
    measure();
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, root, deps]);
  return (
    <svg className="pointer-events-none absolute top-0 left-0 z-0" width={size.w} height={size.h} aria-hidden>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill="none" stroke={p.c} strokeOpacity={0.55} strokeWidth={p.w} strokeLinecap="round" strokeDasharray="6 6">
          {!reduce && <animate attributeName="stroke-dashoffset" from="24" to="0" dur="1.4s" repeatCount="indefinite" />}
        </path>
      ))}
    </svg>
  );
}

/* ---------- Banners */
function SafetyBanner({ pending, secondsLeft, busy, onApply, onDiscard, onConfirm, onRevert }: { pending: boolean; secondsLeft: number | null; busy: boolean; onApply: () => void; onDiscard: () => void; onConfirm: () => void; onRevert: () => void }) {
  const { t } = useTranslation();
  if (secondsLeft !== null)
    return (
      <div className="glass-soft sticky top-0 z-20 flex flex-wrap items-center gap-3 rounded-2xl border-amber-300/30 bg-amber-400/10 px-4 py-3 shadow-[0_0_30px_rgba(251,191,36,0.18)]" role="alert">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-400/20 text-sm font-bold text-amber-100 tabular-nums ring-2 ring-amber-300/50">{secondsLeft}</span>
        <div className="min-w-0 flex-1 text-xs text-amber-50">
          <div className="font-semibold">{t("vsw.rollback.title", { s: secondsLeft })}</div>
          <div className="text-amber-100/80">{t("vsw.rollback.hint")}</div>
        </div>
        <GlassButton variant="primary" disabled={busy} onClick={onConfirm}><ShieldCheck size={14} />{t("vsw.rollback.keep")}</GlassButton>
        <GlassButton variant="danger" disabled={busy} onClick={onRevert}><Undo2 size={14} />{t("vsw.rollback.revert")}</GlassButton>
      </div>
    );
  if (!pending) return null;
  return (
    <div className="glass-soft sticky top-0 z-20 flex flex-wrap items-center gap-3 rounded-2xl border-sky-300/30 bg-sky-400/10 px-4 py-3" role="status">
      <Layers size={18} className="text-sky-200" />
      <div className="min-w-0 flex-1 text-xs text-sky-50">
        <div className="font-semibold">{t("vsw.pending.title")}</div>
        <div className="text-sky-100/80">{t("vsw.pending.hint")}</div>
      </div>
      <GlassButton variant="ghost" disabled={busy} onClick={onDiscard}>{t("vsw.pending.discard")}</GlassButton>
      <GlassButton variant="primary" disabled={busy} onClick={onApply}><ShieldCheck size={14} />{t("vsw.pending.apply")}</GlassButton>
    </div>
  );
}

/* ---------- Main studio */
export default function VisualSwitchStudio() {
  const { t } = useTranslation();
  const { state, error, reload } = useSwitch();
  const clusterMode = state?.cluster?.mode === "cluster";
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string; bad: boolean }[]>([]);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [inspect, setInspect] = useState<Port | null>(null);
  const [editBridge, setEditBridge] = useState<Bridge | "new" | null>(null);
  const [vlanEdit, setVlanEdit] = useState<Vlan | "new" | null>(null);
  const [dhcpFor, setDhcpFor] = useState<Vlan | null>(null);
  const dhcpOn = useFeatureEnabled("vlan_dhcp");
  const [trunkFor, setTrunkFor] = useState<Port | null>(null);
  const [addNic, setAddNic] = useState<string | null>(null);
  const [ipFor, setIpFor] = useState<Port | null>(null);
  const [vipsOpen, setVipsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const toast = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { id, text, bad }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 4500);
  }, []);

  useEffect(() => {
    if (state?.rollback_seconds_left != null) setDeadline(Date.now() + state.rollback_seconds_left * 1000);
    else if (state) setDeadline(null);
  }, [state]);
  useEffect(() => {
    if (deadline === null) return;
    const i = setInterval(() => setNow(Date.now()), 500);
    const poll = setInterval(reload, 10000);
    return () => {
      clearInterval(i);
      clearInterval(poll);
    };
  }, [deadline, reload]);
  const secondsLeft = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  useEffect(() => {
    if (secondsLeft === 0) setTimeout(reload, 3000);
  }, [secondsLeft, reload]);

  /** Run a call, toast the outcome, arm the countdown when the backend applied a network change, then refresh. */
  const run = useCallback(
    async (fn: () => Promise<{ rollback_seconds_left?: number; pending?: boolean } | unknown>, ok: string): Promise<boolean> => {
      setBusy(true);
      try {
        const r = (await fn()) as { rollback_seconds_left?: number; pending?: boolean } | undefined;
        if (r?.rollback_seconds_left) setDeadline(Date.now() + r.rollback_seconds_left * 1000);
        toast(r?.pending ? `${ok} — ${t("vsw.toast.staged")}` : ok);
        await reload();
        return true;
      } catch (e) {
        toast((e as Error).message, true);
        await reload();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload, toast, t],
  );

  const vlanColor = useMemo(() => {
    const map = new Map((state?.vlans ?? []).map((v) => [v.vlan_id, v.color]));
    return (v: number | null) => map.get(v ?? 1) ?? DEFAULT_COLOR;
  }, [state?.vlans]);

  const ports = useMemo<Port[]>(() => {
    if (!state) return [];
    const uplinks = new Set(state.bridges.filter((b) => b.ipv4_gateway).flatMap((b) => b.member_ports));
    const phys = state.physical.map<Port>((p, i) => ({
      kind: "physical", id: p.name, bridge: p.assigned_bridge, label: `${t("vsw.port")} ${i + 1} · ${p.name}`,
      sub: uplinks.has(p.name) ? t("vsw.uplink") : p.driver ?? p.mac, mode: p.vlan_mode, access: p.access_vlan, tagged: p.tagged_vlans,
      up: p.link_up, speed: p.speed_mbps, physical: p,
    }));
    const host = state.host_vnics.map<Port>((h) => ({
      kind: "host_vnic", id: h.name, bridge: h.assigned_bridge, label: `${t("vsw.host")} · ${h.name}`,
      sub: h.ipv4_cidr ?? t(h.type === "vlan" ? "vsw.vnic.vlan" : h.type === "dummy" ? "vsw.vnic.dummy" : "vsw.vnic.veth"),
      mode: h.vlan_mode, access: h.access_vlan, tagged: h.tagged_vlans, up: h.link_up, speed: null, host: h,
    }));
    const guests = state.guest_vnics.map<Port>((g) => ({
      kind: "guest_vnic", id: `${g.guest_type}/${g.guest_id}/${g.net_id}`, bridge: g.bridge || null,
      label: `${g.guest_type === "vm" ? "VM" : "CT"} ${g.guest_id} · ${g.guest_name}`, sub: `${g.net_id}${g.ip_address ? ` · ${g.ip_address}` : ""}`,
      mode: g.link_disconnected ? "unassigned" : g.vlan_mode, access: g.vlan_tag ?? 1, tagged: g.trunks,
      up: g.status === "running" && !g.link_disconnected, speed: g.rate_mbps ? g.rate_mbps * 8 : null, guest: g,
    }));
    return [...phys, ...host, ...guests];
  }, [state, t]);

  const find = (kind: Port["kind"], id: string) => ports.find((p) => p.kind === kind && p.id === id);

  const assign = (p: Port, mode: VlanMode, bridge: string | null, vlan: number | null, tagged: number[] = []) =>
    run(
      () => api("/network/switch/assign-port", { method: "POST", json: { port_kind: p.kind, port: p.id, target_bridge: bridge, mode, vlan_id: vlan, tagged_vlans: tagged } }),
      mode === "unassigned" ? t("vsw.toast.unplugged", { port: p.label }) : t("vsw.toast.assigned", { port: p.label, vlan: vlan ?? 1 }),
    );

  const dropOnVlan = (v: Vlan | null) => (kind: Port["kind"], id: string) => {
    const p = find(kind, id);
    if (!p || !state) return;
    const bridge = v ? v.bridge : p.bridge ?? state.default_bridge;
    assign(p, "access", bridge, v ? v.vlan_id : 1);
  };

  if (!state)
    return (
      <div className="space-y-3 p-4">
        <Notice error={error} />
        {!error && <p className="text-xs text-slate-400">{t("common.loading")}</p>}
      </div>
    );

  const guestsOn = (b: string) => ports.filter((p) => p.kind !== "physical" && p.bridge === b);
  const unassigned = ports.filter((p) => p.kind === "physical" && !p.bridge);

  return (
    <div ref={root} className="relative h-full space-y-4 overflow-auto p-4">
      <Cables root={root} ports={ports} color={vlanColor} deps={state} />
      <div className="relative z-10 space-y-4">
        <SafetyBanner
          pending={state.pending}
          secondsLeft={secondsLeft}
          busy={busy}
          onApply={() => run(() => api("/network/switch/apply", { method: "POST" }), t("vsw.toast.applied"))}
          onDiscard={() => run(() => api("/network/switch/discard", { method: "POST" }), t("vsw.toast.discarded"))}
          onConfirm={() => run(() => api("/network/switch/confirm", { method: "POST" }), t("vsw.toast.confirmed")).then(() => setDeadline(null))}
          onRevert={() => run(() => api("/network/switch/revert", { method: "POST" }), t("vsw.toast.reverted")).then(() => setDeadline(null))}
        />

        <header className="flex flex-wrap items-center gap-2">
          <Network size={18} className="text-sky-300" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">{t("vsw.title")}</h2>
            <p className="text-[11px] text-slate-400">{t("vsw.intro")}</p>
          </div>
          <GlassButton onClick={reload} aria-label={t("common.refresh")}><RefreshCw size={13} /></GlassButton>
          {clusterMode && <GlassButton onClick={() => setVipsOpen(true)}><Globe size={13} />{t("cl.vips")}</GlassButton>}
          <GlassButton onClick={() => setAddNic(state.default_bridge)}><Cable size={13} />{t("vsw.addVnic")}</GlassButton>
          <GlassButton variant="primary" onClick={() => setEditBridge("new")}><Plus size={13} />{t("vsw.addSwitch")}</GlassButton>
        </header>

        <GroupZoomPills />

        {/* Faceplates */}
        {state.bridges.map((b) => (
          <section key={b.name} className="glass rounded-2xl p-0">
            <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border-b border-white/10 bg-gradient-to-r from-white/[0.07] to-transparent px-4 py-2.5">
              <Server size={15} className="text-slate-300" />
              <span className="font-mono text-sm font-semibold text-white">{b.name}</span>
              <span className="text-[11px] text-slate-300 tabular-nums">{b.ipv4_cidr ?? (b.method === "dhcp" ? t("vsw.dhcpClient") : t("vsw.noIp"))}{b.ipv6_cidr ? ` · ${b.ipv6_cidr}` : ""}</span>
              {b.vlan_aware && <GlassBadge tone="info">{t("vsw.vlanAware")}</GlassBadge>}
              <GlassBadge tone={b.mode === "nat" ? "warning" : b.mode === "isolated" ? "neutral" : "success"}>{t(`vsw.bmode.${b.mode}` as TKey)}</GlassBadge>
              {b.comment && <span className="truncate text-[11px] text-slate-400">{b.comment}</span>}
              {clusterMode && b.clustered && (b.synced_hosts ? <GlassBadge tone="success">{t("cl.syncedAcross", { n: b.synced_hosts })}</GlassBadge> : <GlassBadge tone="warning">{t("cl.notSynced")}</GlassBadge>)}
              <span className="flex-1" />
              {clusterMode && (
                <GlassSwitch
                  checked={!!b.clustered}
                  disabled={busy}
                  onChange={(on) =>
                    run(
                      () =>
                        api<{ ok: boolean; results?: Record<string, string> }>(`/network/switch/bridges/${b.name}/clustered`, { method: "PUT", json: { clustered: on } }).then((r) => {
                          if (!r.ok) throw new Error(Object.entries(r.results ?? {}).filter(([, v]) => v !== "ok").map(([h, v]) => `${h}: ${v}`).join(" · "));
                        }),
                      on ? t("cl.switchClustered", { name: b.name }) : t("cl.switchUnclustered", { name: b.name }),
                    )
                  }
                  label={t("cl.clusteredSwitch")}
                />
              )}
              <GlassButton size="xs" onClick={() => setAddNic(b.name)}><Plus size={12} />{t("vsw.addVnic")}</GlassButton>
              <GlassButton size="xs" onClick={() => setEditBridge(b)}><Pencil size={12} />{t("vsw.editBridge")}</GlassButton>
            </div>
            <div className="grid gap-3 p-3">
              <div className="rounded-xl bg-black/25 p-2 ring-1 ring-white/5 ring-inset">
                <div className="mb-1 px-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{t("vsw.physicalBank")}</div>
                <div className="flex flex-wrap">
                  {ports.filter((p) => p.kind === "physical" && p.bridge === b.name).map((p) => (
                    <Jack key={p.id} port={p} color={vlanColor} onOpen={() => setInspect(p)} selected={inspect?.id === p.id} />
                  ))}
                  {!b.member_ports.length && <p className="p-2 text-[11px] text-slate-500">{t(b.mode === "bridged" ? "vsw.noPhysical" : "vsw.internalOnly")}</p>}
                </div>
              </div>
              <div className="rounded-xl bg-black/25 p-2 ring-1 ring-white/5 ring-inset">
                <div className="mb-1 px-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{t("vsw.virtualBank")}</div>
                <div className="flex flex-wrap">
                  {guestsOn(b.name).map((p) => (
                    <Jack key={p.id} port={p} color={vlanColor} onOpen={() => setInspect(p)} selected={inspect?.id === p.id} />
                  ))}
                  {!guestsOn(b.name).length && <p className="p-2 text-[11px] text-slate-500">{t("vsw.noVirtual")}</p>}
                </div>
              </div>
            </div>
          </section>
        ))}

        {unassigned.length > 0 && (
          <section className="glass-soft rounded-2xl p-3">
            <div className="mb-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{t("vsw.unassignedPorts")}</div>
            <div className="flex flex-wrap">
              {unassigned.map((p) => <Jack key={p.id} port={p} color={vlanColor} onOpen={() => setInspect(p)} selected={inspect?.id === p.id} />)}
            </div>
          </section>
        )}

        {/* VLAN lanes (data-anchor: Global Search deep links) */}
        <div className="pt-6" data-anchor="vlan-lanes">
          <div className="mb-2 flex items-center gap-2">
            <Layers size={15} className="text-slate-300" />
            <h3 className="flex-1 text-xs font-semibold text-white">{t("vsw.lanes")}</h3>
            <span className="text-[11px] text-slate-400">{t("vsw.dragHint")}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {!state.vlans.some((v) => v.vlan_id === 1) && (
              <DropZone id="1" onDrop={dropOnVlan(null)} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: DEFAULT_COLOR }} />
                  <span className="text-xs font-semibold text-white">{t("vsw.vlan1")}</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">{t("vsw.vlan1Hint")}</p>
              </DropZone>
            )}
            {state.vlans.map((v) => (
              <DropZone key={v.vlan_id} id={String(v.vlan_id)} onDrop={dropOnVlan(v)} className="rounded-2xl border bg-white/[0.03] p-3" >
                <div className="flex items-center gap-2" style={{ borderColor: v.color }}>
                  <span className="h-3 w-3 rounded-full shadow-[0_0_10px_currentColor]" style={{ background: v.color, color: v.color }} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white">VLAN {v.vlan_id} · {v.name}</span>
                  {dhcpOn && <GlassBadge tone={v.dhcp_active ? "success" : "neutral"}>{v.dhcp_active ? t("vsw.dhcpOn") : t("vsw.dhcpOff")}</GlassBadge>}
                  <GlassButton size="xs" variant="ghost" onClick={() => setVlanEdit(v)} aria-label={t("common.edit")}><Pencil size={12} /></GlassButton>
                </div>
                <div className="mt-1 h-1 rounded-full" style={{ background: v.color }} />
                <p className="mt-1.5 text-[11px] text-slate-400">
                  {v.bridge}
                  {v.host_ipv4_cidr ? ` · ${t("vsw.gateway")} ${v.host_ipv4_cidr}` : ""}
                  {v.description ? ` · ${v.description}` : ""}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">{t("vsw.portsOnVlan", { n: ports.filter((p) => p.mode !== "unassigned" && (p.access === v.vlan_id || p.tagged.includes(v.vlan_id))).length })}</p>
                {dhcpOn && <GlassButton size="xs" className="mt-2" onClick={() => setDhcpFor(v)}><Router size={12} />{t("vsw.configureDhcp")}</GlassButton>}
              </DropZone>
            ))}
            <DropZone
              id="trunk"
              onDrop={(kind, id) => { const p = find(kind, id); if (p) setTrunkFor(p); }}
              className="rounded-2xl border border-dashed border-fuchsia-300/40 bg-gradient-to-br from-fuchsia-500/10 via-sky-500/5 to-emerald-500/10 p-3"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-white"><Wifi size={14} className="text-fuchsia-200" />{t("vsw.trunkZone")}</div>
              <p className="mt-1 text-[11px] text-slate-300">{t("vsw.trunkHint")}</p>
            </DropZone>
            <DropZone
              id="unassigned"
              onDrop={(kind, id) => { const p = find(kind, id); if (p) assign(p, "unassigned", null, null); }}
              className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-3"
            >
              <div className="text-xs font-semibold text-slate-200">{t("vsw.unplugZone")}</div>
              <p className="mt-1 text-[11px] text-slate-400">{t("vsw.unplugHint")}</p>
            </DropZone>
            <button type="button" onClick={() => setVlanEdit("new")} className="grid min-h-24 place-items-center rounded-2xl border border-dashed border-sky-300/30 text-xs text-sky-200 transition hover:bg-sky-400/10">
              <span className="flex items-center gap-1.5"><Plus size={14} />{t("vsw.createVlan")}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Toasts */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`glass-panel relative max-w-sm rounded-xl px-3 py-2 text-xs ${x.bad ? "text-rose-200" : "text-emerald-100"}`}>{x.text}</div>
        ))}
      </div>

      {inspect && (
        <PortInspector
          port={inspect}
          state={state}
          busy={busy}
          onClose={() => setInspect(null)}
          onAssign={(mode, bridge, vlan) => assign(inspect, mode, bridge, vlan).then((ok) => ok && setInspect(null))}
          onTrunk={() => { setTrunkFor(inspect); setInspect(null); }}
          onIp={() => { setIpFor(inspect); setInspect(null); }}
          run={run}
        />
      )}
      {trunkFor && <TrunkModal port={trunkFor} state={state} busy={busy} onClose={() => setTrunkFor(null)} onSave={(bridge, native, tagged) => assign(trunkFor, "trunk", bridge, native, tagged).then((ok) => ok && setTrunkFor(null))} />}
      <GlassModal open={vipsOpen} onClose={() => setVipsOpen(false)} title={t("cl.vips")} width="max-w-2xl">
        <VipsPanel />
      </GlassModal>
      {editBridge && <BridgeModal bridge={editBridge === "new" ? null : editBridge} state={state} busy={busy} onClose={() => setEditBridge(null)} run={run} />}
      {vlanEdit && <VlanModal vlan={vlanEdit === "new" ? null : vlanEdit} state={state} busy={busy} onClose={() => setVlanEdit(null)} run={run} />}
      {dhcpFor && <DhcpModal vlan={dhcpFor} state={state} busy={busy} onClose={() => setDhcpFor(null)} run={run} />}
      {addNic && <AddNicModal bridge={addNic} state={state} busy={busy} onClose={() => setAddNic(null)} run={run} />}
      {ipFor && <IpModal port={ipFor} busy={busy} onClose={() => setIpFor(null)} run={run} />}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;

/* ---------- Port inspector */
function PortInspector({ port, state, busy, onClose, onAssign, onTrunk, onIp, run }: { port: Port; state: SwitchState; busy: boolean; onClose: () => void; onAssign: (mode: VlanMode, bridge: string | null, vlan: number | null) => void; onTrunk: () => void; onIp: () => void; run: Run }) {
  const { t } = useTranslation();
  const [bridge, setBridge] = useState(port.bridge ?? state.default_bridge);
  const g = port.guest;
  const [model, setModel] = useState(g?.model ?? "virtio");
  const [mac, setMac] = useState(g?.mac ?? "");
  const [rate, setRate] = useState(g?.rate_mbps ? String(g.rate_mbps) : "");
  const vlans = state.vlans.filter((v) => v.bridge === bridge);
  const guestPath = g ? `/network/switch/vnics/guest/${g.guest_type}/${g.guest_id}/${g.net_id}` : "";
  const saveGuest = (link_disconnected = g?.link_disconnected ?? false) =>
    run(() => api(guestPath, { method: "PUT", json: { bridge: g!.bridge || bridge, vlan_tag: g!.vlan_tag, trunks: g!.trunks, model, mac: mac || null, rate_mbps: rate ? +rate : null, link_disconnected } }), t("vsw.toast.saved")).then((ok) => ok && onClose());
  return (
    <GlassModal open onClose={onClose} title={port.label} side width="max-w-md">
      <div className="space-y-4 text-xs text-slate-300">
        <OsiDisclosure
          kind={port.kind === "physical" ? "physical_nic" : "vnic"}
          name={port.label}
          values={osiValues({
            link: port.up ? `${t("vsw.linkUp")} ${speedLabel(port.speed)}` : t("vsw.linkDown"),
            mac: port.physical?.mac ?? g?.mac,
            vlan: port.mode === "unassigned" ? null : port.mode === "trunk" ? `${port.access ?? 1} + ${port.tagged.join(",")}` : port.access,
            model: port.physical?.driver ?? g?.model ?? port.host?.type,
            ip: port.physical?.ipv4_cidr ?? port.host?.ipv4_cidr ?? g?.ip_address,
          })}
        />
        <div className="grid grid-cols-2 gap-2">
          <Info k={t("vsw.mode")} v={t(`vsw.mode.${port.mode}` as TKey)} />
          <Info k={t("vsw.switch")} v={port.bridge ?? "—"} />
          <Info k={t("vsw.link")} v={port.up ? `${t("vsw.linkUp")} ${speedLabel(port.speed)}` : t("vsw.linkDown")} />
          <Info k="MAC" v={port.physical?.mac ?? g?.mac ?? "—"} />
          {port.physical && <Info k={t("vsw.driver")} v={`${port.physical.driver ?? "—"} · ${port.physical.pci_slot ?? ""}`} />}
          {(port.physical?.ipv4_cidr || port.host?.ipv4_cidr || g?.ip_address) && <Info k="IPv4" v={port.physical?.ipv4_cidr ?? port.host?.ipv4_cidr ?? g?.ip_address ?? ""} />}
          {port.mode === "trunk" && <Info k={t("vsw.tagged")} v={port.tagged.join(", ")} />}
          {port.mode !== "unassigned" && <Info k={t("vsw.untagged")} v={`VLAN ${port.access ?? 1}`} />}
        </div>
        <div className="space-y-1.5 rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10 ring-inset">
          <p className="flex gap-1.5"><CircleHelp size={13} className="mt-0.5 shrink-0 text-sky-300" /><span><b className="text-white">{t("vsw.mode.access")}:</b> {t("vsw.explain.access")}</span></p>
          <p className="flex gap-1.5"><CircleHelp size={13} className="mt-0.5 shrink-0 text-fuchsia-300" /><span><b className="text-white">{t("vsw.mode.trunk")}:</b> {t("vsw.explain.trunk")}</span></p>
        </div>
        {port.kind !== "host_vnic" || port.host?.type === "dummy" ? (
          <Field label={t("vsw.switch")}>
            <GlassSelect className="w-full" value={bridge} onChange={(e) => setBridge(e.target.value)}>
              {state.bridges.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </GlassSelect>
          </Field>
        ) : null}
        <div>
          <div className="mb-1.5 text-[11px] text-slate-400">{t("vsw.putOnVlan")}</div>
          <div className="flex flex-wrap gap-1.5">
            {port.kind !== "host_vnic" || port.host?.type !== "vlan" ? (
              <GlassButton size="xs" disabled={busy} onClick={() => onAssign("access", bridge, 1)}>
                <span className="h-2 w-2 rounded-full" style={{ background: DEFAULT_COLOR }} />VLAN 1
              </GlassButton>
            ) : null}
            {vlans.map((v) => (
              <GlassButton key={v.vlan_id} size="xs" disabled={busy} onClick={() => onAssign("access", bridge, v.vlan_id)}>
                <span className="h-2 w-2 rounded-full" style={{ background: v.color }} />
                {v.vlan_id} · {v.name}
              </GlassButton>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {port.host?.type !== "vlan" && <GlassButton disabled={busy} onClick={onTrunk}><Wifi size={13} />{t("vsw.makeTrunk")}</GlassButton>}
          {port.mode !== "unassigned" && <GlassButton disabled={busy} onClick={() => onAssign("unassigned", null, null)}>{t("vsw.unplug")}</GlassButton>}
          {(port.kind === "host_vnic" && port.host?.type !== "veth") || (port.kind === "physical" && !port.bridge) ? (
            <GlassButton disabled={busy} onClick={onIp}><Pencil size={13} />{t("vsw.editIp")}</GlassButton>
          ) : null}
          {port.kind === "host_vnic" && port.host?.type !== "veth" && (
            <GlassButton variant="danger" disabled={busy} onClick={() => run(() => api(`/network/switch/vnics/host/${port.id}`, { method: "DELETE" }), t("vsw.toast.removed")).then((ok) => ok && onClose())}><Trash2 size={13} />{t("vsw.removeNic")}</GlassButton>
          )}
        </div>
        {port.kind === "physical" && port.physical?.assigned_bridge && state.bridges.find((b) => b.name === port.bridge)?.ipv4_gateway && (
          <Notice error={t("vsw.uplinkWarn")} />
        )}
        {g && (
          <div className="space-y-2 border-t border-white/10 pt-3">
            <div className="text-[11px] font-semibold text-white">{t("vsw.vnicSettings")}</div>
            <div className="grid grid-cols-2 gap-2">
              {g.guest_type === "vm" && (
                <Field label={t("vsw.model")}>
                  <GlassSelect className="w-full" value={model} onChange={(e) => setModel(e.target.value)}>
                    {state.nic_models.map((m) => <option key={m}>{m}</option>)}
                  </GlassSelect>
                </Field>
              )}
              <Field label="MAC"><GlassInput className="w-full font-mono" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="BC:24:11:…" /></Field>
              <Field label={t("vsw.rate")}><GlassInput className="w-full" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} placeholder={t("vsw.unlimited")} /></Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <GlassButton variant="primary" disabled={busy} onClick={() => saveGuest()}>{t("common.save")}</GlassButton>
              <GlassButton disabled={busy} onClick={() => saveGuest(!g.link_disconnected)}>{g.link_disconnected ? t("vsw.connectCable") : t("vsw.disconnectCable")}</GlassButton>
              <GlassButton variant="danger" disabled={busy} onClick={() => run(() => api(guestPath, { method: "DELETE" }), t("vsw.toast.removed")).then((ok) => ok && onClose())}><Trash2 size={13} />{t("vsw.removeNic")}</GlassButton>
            </div>
          </div>
        )}
      </div>
    </GlassModal>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg bg-white/[0.04] px-2.5 py-1.5 ring-1 ring-white/5 ring-inset">
      <div className="text-[10px] text-slate-500">{k}</div>
      <div className="truncate text-[11px] text-slate-100">{v}</div>
    </div>
  );
}

/* ---------- Trunk: tick the tagged VLANs */
function TrunkModal({ port, state, busy, onClose, onSave }: { port: Port; state: SwitchState; busy: boolean; onClose: () => void; onSave: (bridge: string, native: number, tagged: number[]) => void }) {
  const { t } = useTranslation();
  const [bridge, setBridge] = useState(port.bridge ?? state.default_bridge);
  const [native, setNative] = useState(port.mode === "trunk" ? port.access ?? 1 : 1);
  const [tagged, setTagged] = useState<number[]>(port.mode === "trunk" ? port.tagged : []);
  const vlans = state.vlans.filter((v) => v.bridge === bridge && v.vlan_id !== native);
  return (
    <GlassModal
      open
      onClose={onClose}
      title={t("vsw.trunkTitle", { port: port.label })}
      footer={<><GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton><GlassButton variant="primary" disabled={busy || !tagged.length} onClick={() => onSave(bridge, native, tagged)}>{t("common.save")}</GlassButton></>}
    >
      <div className="space-y-3 text-xs">
        <p className="text-slate-300">{t("vsw.explain.trunk")}</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("vsw.switch")}>
            <GlassSelect className="w-full" value={bridge} onChange={(e) => setBridge(e.target.value)}>{state.bridges.map((b) => <option key={b.name}>{b.name}</option>)}</GlassSelect>
          </Field>
          <Field label={t("vsw.nativeVlan")} hint={t("vsw.nativeHint")}>
            <GlassSelect className="w-full" value={native} onChange={(e) => setNative(+e.target.value)}>
              <option value={1}>VLAN 1</option>
              {state.vlans.filter((v) => v.bridge === bridge).map((v) => <option key={v.vlan_id} value={v.vlan_id}>{v.vlan_id} · {v.name}</option>)}
            </GlassSelect>
          </Field>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {vlans.map((v) => (
            <label key={v.vlan_id} className="flex cursor-pointer items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-2 ring-1 ring-white/10 ring-inset">
              <input type="checkbox" checked={tagged.includes(v.vlan_id)} onChange={(e) => setTagged((x) => (e.target.checked ? [...x, v.vlan_id] : x.filter((y) => y !== v.vlan_id)))} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: v.color }} />
              <span className="text-slate-100">VLAN {v.vlan_id} · {v.name}</span>
            </label>
          ))}
          {!vlans.length && <p className="text-slate-500">{t("vsw.noVlansYet")}</p>}
        </div>
      </div>
    </GlassModal>
  );
}

/* ---------- Virtual switch editor */
function BridgeModal({ bridge, state, busy, onClose, run }: { bridge: Bridge | null; state: SwitchState; busy: boolean; onClose: () => void; run: Run }) {
  const { t } = useTranslation();
  const next = useMemo(() => {
    const used = new Set(state.bridges.map((b) => b.name));
    let i = 1;
    while (used.has(`${state.bridge_prefix}${i}`)) i++;
    return `${state.bridge_prefix}${i}`;
  }, [state]);
  const [f, setF] = useState({
    name: bridge?.name ?? next, mode: bridge?.mode ?? "bridged", vlan_aware: bridge?.vlan_aware ?? false,
    method: bridge ? (bridge.ipv4_cidr ? "static" : bridge.method === "dhcp" ? "dhcp" : "manual") : "manual",
    ipv4_cidr: bridge?.ipv4_cidr ?? "", ipv4_gateway: bridge?.ipv4_gateway ?? "", ipv6_cidr: bridge?.ipv6_cidr ?? "",
    dns: (bridge?.dns_servers ?? []).join(", "), mtu: bridge?.mtu ? String(bridge.mtu) : "", autostart: bridge?.autostart ?? true,
    ports: bridge?.member_ports ?? [], comment: bridge?.comment ?? "",
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const ipErr = f.method === "static" && !isCidr(f.ipv4_cidr) ? t("vsw.err.cidr") : f.ipv4_gateway && ip2n(f.ipv4_gateway) === null ? t("vsw.err.ip") : "";
  const free = state.physical.filter((p) => !p.assigned_bridge || p.assigned_bridge === bridge?.name);
  const save = async () => {
    const body = {
      name: f.name, mode: f.mode, vlan_aware: f.vlan_aware, autostart: f.autostart, comment: f.comment, mtu: f.mtu ? +f.mtu : null,
      ipv4_cidr: f.method === "static" ? f.ipv4_cidr : null, ipv4_gateway: f.method === "static" && f.ipv4_gateway ? f.ipv4_gateway : null,
      ipv6_cidr: f.ipv6_cidr || null, member_ports: f.mode === "bridged" ? f.ports : [],
    };
    const ok = await run(async () => {
      await api(bridge ? `/network/switch/bridges/${bridge.name}` : "/network/switch/bridges", { method: bridge ? "PUT" : "POST", json: body });
      return api(`/network/switch/interfaces/${f.name}`, {
        method: "PUT",
        json: { method: f.method, ipv4_cidr: body.ipv4_cidr, ipv4_gateway: body.ipv4_gateway, ipv6_cidr: body.ipv6_cidr, dns_servers: f.dns.split(/[\s,]+/).filter(Boolean), mtu: body.mtu, autostart: f.autostart },
      });
    }, bridge ? t("vsw.toast.saved") : t("vsw.toast.switchCreated", { name: f.name }));
    if (ok) onClose();
  };
  return (
    <GlassModal
      open
      onClose={onClose}
      title={bridge ? t("vsw.editSwitchTitle", { name: bridge.name }) : t("vsw.addSwitch")}
      width="max-w-xl"
      footer={
        <>
          {bridge && !bridge.protected && (
            <GlassButton variant="danger" className="mr-auto" disabled={busy} onClick={() => run(() => api(`/network/switch/bridges/${bridge.name}`, { method: "DELETE" }), t("vsw.toast.removed")).then((ok) => ok && onClose())}>
              <Trash2 size={13} />{t("common.delete")}
            </GlassButton>
          )}
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !!ipErr} onClick={save}>{t("common.save")}</GlassButton>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        {bridge && <OsiDisclosure kind={bridge.mode === "nat" ? "vrouter" : "vswitch"} name={bridge.name} values={osiValues({ link: bridge.member_ports.join(", "), vlan: bridge.vlan_aware ? "802.1Q" : null, ip: bridge.ipv4_cidr })} />}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("vsw.name")}><GlassInput className="w-full font-mono" value={f.name} disabled={!!bridge} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label={t("vsw.comment")}><GlassInput className="w-full" value={f.comment} maxLength={60} onChange={(e) => set({ comment: e.target.value })} /></Field>
        </div>
        <Field label={t("vsw.bridgeMode")} hint={t(`vsw.bmodeHint.${f.mode}` as TKey)}>
          <Segmented value={f.mode} onChange={(mode) => set({ mode, method: mode === "nat" ? "static" : f.method })} options={(["bridged", "nat", "isolated"] as const).map((id) => ({ id, label: t(`vsw.bmode.${id}`) }))} />
        </Field>
        <GlassSwitch checked={f.vlan_aware} onChange={(vlan_aware) => set({ vlan_aware })} label={t("vsw.vlanAwareToggle")} />
        {f.mode === "bridged" && (
          <Field label={t("vsw.memberPorts")}>
            <div className="flex flex-wrap gap-1.5">
              {free.map((p) => (
                <label key={p.name} className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-white/[0.04] px-2 py-1 ring-1 ring-white/10 ring-inset">
                  <input type="checkbox" checked={f.ports.includes(p.name)} onChange={(e) => set({ ports: e.target.checked ? [...f.ports, p.name] : f.ports.filter((x) => x !== p.name) })} />
                  <span className={`h-1.5 w-1.5 rounded-full ${p.link_up ? "bg-emerald-400" : "bg-slate-600"}`} />
                  <span className="font-mono text-slate-100">{p.name}</span>
                </label>
              ))}
              {!free.length && <span className="text-slate-500">{t("vsw.noFreePorts")}</span>}
            </div>
          </Field>
        )}
        <div className="space-y-2 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/10 ring-inset">
          <div className="text-[11px] font-semibold text-white">{t("vsw.ipConfig")}</div>
          <Segmented value={f.method} onChange={(method) => set({ method })} options={(["static", "dhcp", "manual"] as const).map((id) => ({ id, label: t(`vsw.method.${id}`) }))} />
          {f.method === "static" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("vsw.ipv4")}><GlassInput className="w-full font-mono" value={f.ipv4_cidr} onChange={(e) => set({ ipv4_cidr: e.target.value })} placeholder="10.10.10.1/24" /></Field>
              <Field label={t("vsw.gateway")}><GlassInput className="w-full font-mono" value={f.ipv4_gateway} onChange={(e) => set({ ipv4_gateway: e.target.value })} placeholder={t("vsw.optional")} /></Field>
              <Field label={t("vsw.dns")}><GlassInput className="w-full font-mono" value={f.dns} onChange={(e) => set({ dns: e.target.value })} placeholder="1.1.1.1, 9.9.9.9" /></Field>
              <Field label="IPv6"><GlassInput className="w-full font-mono" value={f.ipv6_cidr} onChange={(e) => set({ ipv6_cidr: e.target.value })} placeholder={t("vsw.optional")} /></Field>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="MTU"><GlassInput className="w-full" type="number" min={576} max={9216} value={f.mtu} onChange={(e) => set({ mtu: e.target.value })} placeholder="1500" /></Field>
            <div className="flex items-end pb-1"><GlassSwitch checked={f.autostart} onChange={(autostart) => set({ autostart })} label={t("vsw.autostart")} /></div>
          </div>
          {ipErr && <Notice error={ipErr} />}
        </div>
        <p className="text-[11px] text-slate-400">{t("vsw.stagedNote")}</p>
      </div>
    </GlassModal>
  );
}

/* ---------- VLAN template pill with an educational hover / focus tooltip */
function PresetPill({ preset: p, onPick }: { preset: Preset; onPick: () => void }) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const tipId = `vsw-preset-tip-${p.id}`;
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 328)); // 320px card + 8px margin
    // Flip above the pill when there is too little room below it.
    setPos(window.innerHeight - r.bottom > 300 ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
  };
  const hide = () => setPos(null);
  const reach = (ok: boolean, label: string) => <GlassBadge tone={ok ? "success" : "danger"}>{ok ? "✓" : "✕"} {label}</GlassBadge>;
  return (
    <>
      <GlassButton
        size="xs"
        onClick={onPick}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={hide}
        aria-describedby={pos ? tipId : undefined}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
        {p.id} · {t(presetKey(p))}
      </GlassButton>
      {pos &&
        createPortal(
          <div
            id={tipId}
            role="tooltip"
            className="glass-panel pointer-events-none fixed z-[10000] w-80 space-y-2 rounded-xl border border-[var(--sd-border-hairline)] p-3 text-[11px] leading-relaxed text-[var(--sd-text-secondary)]"
            style={{ ...pos, backgroundImage: "linear-gradient(var(--sd-surface-card), var(--sd-surface-card))" }}
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--sd-text-primary)]">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
              {p.id} · {t(presetKey(p))}
            </div>
            <div>
              <div className="font-semibold text-[var(--sd-text-primary)]">{t("vsw.tip.purpose")}</div>
              {t(presetKey(p, "purpose"))}
            </div>
            <div>
              <div className="font-semibold text-[var(--sd-text-primary)]">{t("vsw.tip.how")}</div>
              {t(presetKey(p, "how"))}
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px]">
              <span>{t("vsw.tip.l2")}</span>
              <span className="text-[var(--sd-text-primary)]">802.1Q · tag {p.id}</span>
              <span>{t("vsw.tip.l3")}</span>
              <span className="text-[var(--sd-text-primary)]">10.10.{p.id}.0/24 · gw 10.10.{p.id}.1</span>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-0.5">{t("vsw.tip.reaches")}</span>
              {reach(p.reach.wan, "WAN")}
              {reach(p.reach.lan, "LAN")}
              {reach(p.reach.mgmt, t("vsw.preset.mgmt"))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/* ---------- VLAN editor with presets + color picker */
function VlanModal({ vlan, state, busy, onClose, run }: { vlan: Vlan | null; state: SwitchState; busy: boolean; onClose: () => void; run: Run }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ vlan_id: vlan?.vlan_id ?? 10, name: vlan?.name ?? "", color: vlan?.color ?? SWATCHES[0], bridge: vlan?.bridge ?? state.default_bridge, host: vlan?.host_ipv4_cidr ?? "", description: vlan?.description ?? "" });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const taken = !vlan && state.vlans.some((v) => v.vlan_id === f.vlan_id);
  const bad = taken || f.vlan_id < 1 || f.vlan_id > 4094 || !f.name.trim() || (!!f.host && !isCidr(f.host));
  const save = () =>
    run(
      () =>
        vlan
          ? api(`/network/switch/vlans/${vlan.vlan_id}`, { method: "PUT", json: { name: f.name, color: f.color, description: f.description, host_ipv4_cidr: f.host || null } })
          : api("/network/switch/vlans", { method: "POST", json: { vlan_id: f.vlan_id, name: f.name, color: f.color, bridge: f.bridge, description: f.description, host_ipv4_cidr: f.host || null } }),
      t("vsw.toast.vlanSaved", { id: f.vlan_id }),
    ).then((ok) => ok && onClose());
  return (
    <GlassModal
      open
      onClose={onClose}
      title={vlan ? `VLAN ${vlan.vlan_id} · ${vlan.name}` : t("vsw.createVlan")}
      footer={
        <>
          {vlan && (
            <GlassButton variant="danger" className="mr-auto" disabled={busy} onClick={() => run(() => api(`/network/switch/vlans/${vlan.vlan_id}`, { method: "DELETE" }), t("vsw.toast.removed")).then((ok) => ok && onClose())}>
              <Trash2 size={13} />{t("common.delete")}
            </GlassButton>
          )}
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || bad} onClick={save}>{t("common.save")}</GlassButton>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        {vlan && <OsiDisclosure kind="vlan" name={`VLAN ${vlan.vlan_id} · ${vlan.name}`} values={osiValues({ vlan: vlan.vlan_id, model: vlan.bridge, ip: vlan.host_ipv4_cidr })} />}
        {!vlan && (
          <div>
            <div className="mb-1.5 text-[11px] text-slate-400">{t("vsw.presets")}</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <PresetPill key={p.id} preset={p} onPick={() => set({ vlan_id: p.id, name: t(presetKey(p)), color: p.color, host: `10.10.${p.id}.1/24`, description: t(presetKey(p, "desc")) })} />
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("vsw.vlanId")} hint="1 – 4094"><GlassInput className="w-full" type="number" min={1} max={4094} disabled={!!vlan} value={f.vlan_id} onChange={(e) => set({ vlan_id: +e.target.value })} /></Field>
          <Field label={t("vsw.name")}><GlassInput className="w-full" value={f.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label={t("vsw.switch")}>
            <GlassSelect className="w-full" value={f.bridge} disabled={!!vlan} onChange={(e) => set({ bridge: e.target.value })}>{state.bridges.map((b) => <option key={b.name}>{b.name}</option>)}</GlassSelect>
          </Field>
          <Field label={t("vsw.hostIp")} hint={t("vsw.hostIpHint")}><GlassInput className="w-full font-mono" value={f.host} onChange={(e) => set({ host: e.target.value })} placeholder="10.10.20.1/24" /></Field>
        </div>
        <Field label={t("vsw.description")}><GlassInput className="w-full" value={f.description} maxLength={120} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label={t("vsw.color")}>
          <div className="flex flex-wrap items-center gap-1.5">
            {SWATCHES.map((c) => (
              <button key={c} type="button" onClick={() => set({ color: c })} aria-label={c} className={`h-6 w-6 rounded-full ring-2 transition ${f.color === c ? "ring-white" : "ring-transparent"}`} style={{ background: c }} />
            ))}
            <input type="color" value={f.color} onChange={(e) => set({ color: e.target.value })} className="h-6 w-8 cursor-pointer rounded bg-transparent" aria-label={t("vsw.customColor")} />
          </div>
        </Field>
        {taken && <Notice error={t("vsw.err.vlanTaken", { id: f.vlan_id })} />}
      </div>
    </GlassModal>
  );
}

/* ---------- Per-VLAN DHCP & IP */
function DhcpModal({ vlan, state, busy, onClose, run }: { vlan: Vlan; state: SwitchState; busy: boolean; onClose: () => void; run: Run }) {
  const { t } = useTranslation();
  const guess = (n: number) => `10.10.${vlan.vlan_id % 256}.${n}`;
  const hostIp = vlan.host_ipv4_cidr?.split("/");
  const d = vlan.dhcp_config;
  const [f, setF] = useState({
    enabled: d?.enabled ?? true, gateway_ip: d?.gateway_ip ?? hostIp?.[0] ?? guess(1), prefix: d ? prefixOf(d.subnet_mask) : hostIp ? +hostIp[1] : 24,
    range_start: d?.range_start ?? guess(100), range_end: d?.range_end ?? guess(200), lease_time: d?.lease_time ?? "24h",
    dns: (d?.dns_servers ?? ["1.1.1.1", "9.9.9.9"]).join(", "), static_leases: d?.static_leases ?? [],
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [leases, setLeases] = useState<Lease[]>([]);
  const [missing, setMissing] = useState(!state.dnsmasq_installed);
  const [installing, setInstalling] = useState(false);
  const loadLeases = useCallback(() => api<{ leases: Lease[] }>(`/network/switch/vlans/${vlan.vlan_id}/leases`).then((r) => setLeases(r.leases), () => {}), [vlan.vlan_id]);
  useEffect(() => {
    loadLeases();
    const i = setInterval(loadLeases, 15000);
    return () => clearInterval(i);
  }, [loadLeases]);

  const gw = ip2n(f.gateway_ip), lo = ip2n(f.range_start), hi = ip2n(f.range_end);
  const mask = f.prefix === 0 ? 0 : (0xffffffff << (32 - f.prefix)) >>> 0;
  const net = gw === null ? null : (gw & mask) >>> 0;
  const bcast = net === null ? null : (net | (~mask >>> 0)) >>> 0;
  const inNet = (n: number | null) => n !== null && net !== null && ((n & mask) >>> 0) === net;
  const err =
    gw === null ? t("vsw.err.gateway") : lo === null || hi === null ? t("vsw.err.range") : !inNet(lo) || !inNet(hi) ? t("vsw.err.outside", { net: `${n2ip(net!)}/${f.prefix}` }) : lo > hi ? t("vsw.err.order") : gw >= lo && gw <= hi ? t("vsw.err.gwInRange") : "";
  const pct = (n: number) => (net === null || bcast === null || bcast === net ? 0 : ((n - net) / (bcast - net)) * 100);

  const body = (statics = f.static_leases) => ({
    enabled: f.enabled, gateway_ip: f.gateway_ip, subnet_mask: maskOf(f.prefix), range_start: f.range_start, range_end: f.range_end,
    lease_time: f.lease_time, dns_servers: f.dns.split(/[\s,]+/).filter(Boolean), static_leases: statics,
  });
  const save = async (statics = f.static_leases, msg = t("vsw.toast.dhcpSaved", { id: vlan.vlan_id })) => {
    const ok = await run(async () => {
      try {
        return await api(`/network/switch/vlans/${vlan.vlan_id}/dhcp`, { method: "PUT", json: body(statics) });
      } catch (e) {
        if (e instanceof ApiError && e.message === "dnsmasq_missing") {
          setMissing(true);
          throw new Error(t("vsw.dhcpMissing"));
        }
        throw e;
      }
    }, msg);
    if (ok) {
      set({ static_leases: statics });
      loadLeases();
    }
    return ok;
  };
  const install = async () => {
    setInstalling(true);
    try {
      const { job } = await api<{ job: string }>("/net/packages/dnsmasq/install", { method: "POST" });
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await api<{ running: boolean; exit_code: number | null }>(`/host/jobs/${job}`);
        if (!s.running) {
          setMissing(s.exit_code !== 0);
          break;
        }
      }
    } finally {
      setInstalling(false);
    }
  };
  const pin = (l: Lease) => save([...f.static_leases.filter((s) => s.mac.toLowerCase() !== l.mac.toLowerCase()), { mac: l.mac, ip: l.ip, hostname: l.hostname.replace(/[^A-Za-z0-9-]/g, "").slice(0, 63) }], t("vsw.toast.pinned", { ip: l.ip }));

  return (
    <GlassModal
      open
      onClose={onClose}
      title={<span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: vlan.color }} />{t("vsw.dhcpTitle", { id: vlan.vlan_id, name: vlan.name })}</span>}
      width="max-w-2xl"
      footer={<><GlassButton onClick={onClose}>{t("common.close")}</GlassButton><GlassButton variant="primary" disabled={busy || (f.enabled && !!err)} onClick={() => save().then((ok) => ok && onClose())}>{t("common.save")}</GlassButton></>}
    >
      <div className="space-y-4 text-xs">
        <OsiDisclosure
          kind="dhcp_server"
          name={t("vsw.dhcpTitle", { id: vlan.vlan_id, name: vlan.name })}
          values={osiValues({ vlan: vlan.vlan_id, ip: [vlan.dhcp_config?.gateway_ip ? `GW ${vlan.dhcp_config.gateway_ip}` : null, vlan.dhcp_config ? `${vlan.dhcp_config.range_start} – ${vlan.dhcp_config.range_end}` : null], ports: ["UDP 67/68"], app: vlan.dhcp_config ? [`Lease ${vlan.dhcp_config.lease_time}`, ...vlan.dhcp_config.dns_servers.map((d) => `DNS ${d}`)] : null })}
        />
        {missing && (
          <div className="flex items-center gap-3 rounded-xl bg-amber-400/10 px-3 py-2 text-amber-100 ring-1 ring-amber-300/30 ring-inset">
            <span className="flex-1">{t("vsw.dhcpMissing")}</span>
            <GlassButton size="xs" disabled={installing} onClick={install}>{installing ? t("vsw.installing") : t("vsw.installDhcp")}</GlassButton>
          </div>
        )}
        <GlassSwitch checked={f.enabled} onChange={(enabled) => set({ enabled })} label={t("vsw.enableDhcp")} />
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label={t("vsw.gatewayIp")} hint={t("vsw.gatewayHint", { iface: `${vlan.bridge}.${vlan.vlan_id}` })}><GlassInput className="w-full font-mono" value={f.gateway_ip} onChange={(e) => set({ gateway_ip: e.target.value })} /></Field>
          <Field label={t("vsw.subnet")}>
            <GlassSelect className="w-full" value={f.prefix} onChange={(e) => set({ prefix: +e.target.value })}>
              {[16, 20, 22, 23, 24, 25, 26, 27, 28].map((p) => <option key={p} value={p}>/{p} · {maskOf(p)}</option>)}
            </GlassSelect>
          </Field>
          <Field label={t("vsw.leaseTime")}>
            <GlassSelect className="w-full" value={f.lease_time} onChange={(e) => set({ lease_time: e.target.value })}>
              {["1h", "12h", "24h", "7d", "infinite"].map((l) => <option key={l} value={l}>{l === "infinite" ? t("vsw.leaseInfinite") : l}</option>)}
            </GlassSelect>
          </Field>
          <Field label={t("vsw.rangeStart")}><GlassInput className="w-full font-mono" value={f.range_start} onChange={(e) => set({ range_start: e.target.value })} /></Field>
          <Field label={t("vsw.rangeEnd")}><GlassInput className="w-full font-mono" value={f.range_end} onChange={(e) => set({ range_end: e.target.value })} /></Field>
          <Field label={t("vsw.dns")}><GlassInput className="w-full font-mono" value={f.dns} onChange={(e) => set({ dns: e.target.value })} /></Field>
        </div>
        {/* Visual range bar: subnet, handed-out range, gateway marker */}
        {net !== null && bcast !== null && lo !== null && hi !== null && !err && (
          <div>
            <div className="relative h-6 overflow-hidden rounded-full bg-white/[0.06] ring-1 ring-white/10 ring-inset">
              <div className="absolute inset-y-0 rounded-full opacity-70" style={{ left: `${pct(lo)}%`, width: `${Math.max(1, pct(hi) - pct(lo))}%`, background: vlan.color }} />
              <div className="absolute inset-y-0 w-1 bg-white" style={{ left: `${pct(gw!)}%` }} title={t("vsw.gateway")} />
              {f.static_leases.map((s) => ip2n(s.ip) !== null && <div key={s.mac} className="absolute inset-y-1 w-0.5 bg-amber-300" style={{ left: `${pct(ip2n(s.ip)!)}%` }} title={s.ip} />)}
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
              <span>{n2ip(net)}</span>
              <span className="text-slate-300">{t("vsw.rangeSummary", { n: hi - lo + 1 })}</span>
              <span>{n2ip(bcast)}</span>
            </div>
          </div>
        )}
        {f.enabled && err && <Notice error={err} />}

        <div>
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-white">{t("vsw.liveLeases")}<span className="font-normal text-slate-500">({leases.length})</span></div>
          <div className="divide-y divide-white/5 rounded-xl bg-white/[0.03] ring-1 ring-white/10 ring-inset">
            {leases.map((l) => (
              <div key={l.mac} className="flex items-center gap-2 px-3 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="w-28 font-mono text-slate-100">{l.ip}</span>
                <span className="min-w-0 flex-1 truncate text-slate-300">{l.hostname || "—"}</span>
                <span className="font-mono text-[10px] text-slate-500">{l.mac}</span>
                {l.is_static ? <GlassBadge tone="info">{t("vsw.static")}</GlassBadge> : <GlassButton size="xs" disabled={busy} onClick={() => pin(l)}>{t("vsw.pinStatic")}</GlassButton>}
              </div>
            ))}
            {!leases.length && <p className="px-3 py-2 text-slate-500">{t("vsw.noLeases")}</p>}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold text-white">{t("vsw.staticLeases")}</div>
          <div className="space-y-1">
            {f.static_leases.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <GlassInput className="w-40 font-mono" value={s.mac} onChange={(e) => set({ static_leases: f.static_leases.map((x, j) => (j === i ? { ...x, mac: e.target.value } : x)) })} />
                <GlassInput className="w-32 font-mono" value={s.ip} onChange={(e) => set({ static_leases: f.static_leases.map((x, j) => (j === i ? { ...x, ip: e.target.value } : x)) })} />
                <GlassInput className="min-w-0 flex-1" value={s.hostname} placeholder={t("vsw.hostname")} onChange={(e) => set({ static_leases: f.static_leases.map((x, j) => (j === i ? { ...x, hostname: e.target.value } : x)) })} />
                <GlassButton size="xs" variant="ghost" onClick={() => set({ static_leases: f.static_leases.filter((_, j) => j !== i) })} aria-label={t("common.delete")}><Trash2 size={12} /></GlassButton>
              </div>
            ))}
            <GlassButton size="xs" onClick={() => set({ static_leases: [...f.static_leases, { mac: "", ip: "", hostname: "" }] })}><Plus size={12} />{t("vsw.addReservation")}</GlassButton>
          </div>
        </div>
      </div>
    </GlassModal>
  );
}

/* ---------- Add a virtual NIC (host or guest) */
function AddNicModal({ bridge, state, busy, onClose, run }: { bridge: string; state: SwitchState; busy: boolean; onClose: () => void; run: Run }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<"guest" | "host">("guest");
  const [guests, setGuests] = useState<Guest[]>([]);
  const [f, setF] = useState({ guest: "", bridge, vlan: 0, model: "virtio", mac: "", type: "vlan" as "vlan" | "dummy", name: "dummy0", vid: state.vlans[0]?.vlan_id ?? 10, ip: "" });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  useEffect(() => {
    api<Guest[]>("/v1/guests").then((g) => { setGuests(g); setF((x) => ({ ...x, guest: x.guest || (g[0] ? `${g[0].type}/${g[0].vmid}` : "") })); }, () => {});
  }, []);
  const [gtype, gid] = f.guest.split("/");
  const save = () =>
    run(
      () =>
        target === "guest"
          ? api("/network/switch/vnics/guest", { method: "POST", json: { guest_type: gtype === "qemu" ? "vm" : "lxc", guest_id: +gid, bridge: f.bridge, vlan_tag: f.vlan || null, model: f.model, mac: f.mac || null } })
          : api("/network/switch/vnics/host", { method: "POST", json: f.type === "vlan" ? { type: "vlan", parent: f.bridge, vlan_id: f.vid, ipv4_cidr: f.ip || null } : { type: "dummy", name: f.name, ipv4_cidr: f.ip || null } }),
      t("vsw.toast.nicAdded"),
    ).then((ok) => ok && onClose());
  const vlans = state.vlans.filter((v) => v.bridge === f.bridge);
  return (
    <GlassModal
      open
      onClose={onClose}
      title={t("vsw.addVnic")}
      footer={<><GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton><GlassButton variant="primary" disabled={busy || (target === "guest" ? !f.guest : !!f.ip && !isCidr(f.ip))} onClick={save}>{t("common.add")}</GlassButton></>}
    >
      <div className="space-y-3 text-xs">
        <Segmented value={target} onChange={setTarget} options={[{ id: "guest", label: t("vsw.toGuest") }, { id: "host", label: t("vsw.toHost") }]} />
        {target === "guest" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("vsw.guest")} className="col-span-2">
              <GlassSelect className="w-full" value={f.guest} onChange={(e) => set({ guest: e.target.value })}>
                {guests.map((g) => <option key={`${g.type}/${g.vmid}`} value={`${g.type}/${g.vmid}`}>{g.type === "qemu" ? "VM" : "CT"} {g.vmid} · {g.name}</option>)}
              </GlassSelect>
            </Field>
            <Field label={t("vsw.switch")}><GlassSelect className="w-full" value={f.bridge} onChange={(e) => set({ bridge: e.target.value, vlan: 0 })}>{state.bridges.map((b) => <option key={b.name}>{b.name}</option>)}</GlassSelect></Field>
            <Field label="VLAN">
              <GlassSelect className="w-full" value={f.vlan} onChange={(e) => set({ vlan: +e.target.value })}>
                <option value={0}>VLAN 1 · {t("vsw.untaggedShort")}</option>
                {vlans.map((v) => <option key={v.vlan_id} value={v.vlan_id}>{v.vlan_id} · {v.name}</option>)}
              </GlassSelect>
            </Field>
            {gtype === "qemu" && <Field label={t("vsw.model")}><GlassSelect className="w-full" value={f.model} onChange={(e) => set({ model: e.target.value })}>{state.nic_models.map((m) => <option key={m}>{m}</option>)}</GlassSelect></Field>}
            <Field label="MAC" hint={t("vsw.macHint")}><GlassInput className="w-full font-mono" value={f.mac} onChange={(e) => set({ mac: e.target.value })} /></Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("vsw.nicType")} className="col-span-2" hint={t(f.type === "vlan" ? "vsw.vlanNicHint" : "vsw.dummyNicHint")}>
              <Segmented value={f.type} onChange={(type) => set({ type })} options={[{ id: "vlan", label: t("vsw.vnic.vlan") }, { id: "dummy", label: t("vsw.vnic.dummy") }]} />
            </Field>
            {f.type === "vlan" ? (
              <>
                <Field label={t("vsw.switch")}><GlassSelect className="w-full" value={f.bridge} onChange={(e) => set({ bridge: e.target.value })}>{state.bridges.map((b) => <option key={b.name}>{b.name}</option>)}</GlassSelect></Field>
                <Field label={t("vsw.vlanId")}><GlassInput className="w-full" type="number" min={2} max={4094} value={f.vid} onChange={(e) => set({ vid: +e.target.value })} /></Field>
              </>
            ) : (
              <Field label={t("vsw.name")}><GlassInput className="w-full font-mono" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            )}
            <Field label={t("vsw.ipv4")}><GlassInput className="w-full font-mono" value={f.ip} onChange={(e) => set({ ip: e.target.value })} placeholder={t("vsw.optional")} /></Field>
            <p className="col-span-2 text-[11px] text-slate-400">{t("vsw.stagedNote")}</p>
          </div>
        )}
      </div>
    </GlassModal>
  );
}

/* ---------- IP configurator for a standalone port or host vNIC */
function IpModal({ port, busy, onClose, run }: { port: Port; busy: boolean; onClose: () => void; run: Run }) {
  const { t } = useTranslation();
  const cur = port.physical ?? port.host;
  const [f, setF] = useState({ method: (cur?.ipv4_cidr ? "static" : cur?.method === "dhcp" ? "dhcp" : "manual") as "static" | "dhcp" | "manual", ip: cur?.ipv4_cidr ?? "", gw: "", dns: "", mtu: port.physical?.mtu ? String(port.physical.mtu) : "" });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const err = f.method === "static" && !isCidr(f.ip) ? t("vsw.err.cidr") : f.gw && ip2n(f.gw) === null ? t("vsw.err.ip") : "";
  const save = () =>
    run(() => api(`/network/switch/interfaces/${port.id}`, { method: "PUT", json: { method: f.method, ipv4_cidr: f.method === "static" ? f.ip : null, ipv4_gateway: f.method === "static" && f.gw ? f.gw : null, dns_servers: f.dns.split(/[\s,]+/).filter(Boolean), mtu: f.mtu ? +f.mtu : null, autostart: true } }), t("vsw.toast.saved")).then((ok) => ok && onClose());
  return (
    <GlassModal open onClose={onClose} title={t("vsw.ipTitle", { name: port.id })} footer={<><GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton><GlassButton variant="primary" disabled={busy || !!err} onClick={save}>{t("common.save")}</GlassButton></>}>
      <div className="space-y-3 text-xs">
        <Segmented value={f.method} onChange={(method) => set({ method })} options={(["static", "dhcp", "manual"] as const).map((id) => ({ id, label: t(`vsw.method.${id}`) }))} />
        {f.method === "static" && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("vsw.ipv4")}><GlassInput className="w-full font-mono" value={f.ip} onChange={(e) => set({ ip: e.target.value })} placeholder="192.168.10.2/24" /></Field>
            <Field label={t("vsw.gateway")}><GlassInput className="w-full font-mono" value={f.gw} onChange={(e) => set({ gw: e.target.value })} placeholder={t("vsw.optional")} /></Field>
            <Field label={t("vsw.dns")}><GlassInput className="w-full font-mono" value={f.dns} onChange={(e) => set({ dns: e.target.value })} placeholder="1.1.1.1" /></Field>
            <Field label="MTU"><GlassInput className="w-full" type="number" value={f.mtu} onChange={(e) => set({ mtu: e.target.value })} placeholder="1500" /></Field>
          </div>
        )}
        {err && <Notice error={err} />}
        <p className="text-[11px] text-slate-400">{t("vsw.stagedNote")}</p>
      </div>
    </GlassModal>
  );
}
