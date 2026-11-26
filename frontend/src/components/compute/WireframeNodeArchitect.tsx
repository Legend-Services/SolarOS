import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Cable, Cpu, CreditCard, Dices, FlaskConical, HardDrive, MemoryStick, Mic, Monitor, Music, Network, Phone, RefreshCw, Server, ShieldCheck, Shuffle, Timer, Usb, Webcam, X } from "lucide-react";
import { api } from "../../lib/api";
import { ink } from "../../lib/format";
import { useRunner } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation, type TKey } from "../../i18n";
import { Field, GlassBadge, GlassButton, GlassInput, GlassSelect, GlassSwitch, Notice } from "../ui/GlassKit";

/* Shapes of GET /api/virtual-hardware/{guest_type}/{guest_id}/detailed (backend/app/virtual_hardware.py). */
interface Identity {
  device_name: string;
  vendor_id: string;
  device_id: string;
  serial_number: string;
  pci_or_usb_address: string;
  bus_type: string;
  native_vendor_id: string | null;
  native_device_id: string | null;
  guest_visible: string[];
}
interface VDev {
  id: string;
  type: string;
  options: Record<string, string | number>;
  bus: string;
  category: string;
  hotplug: boolean;
  identity: Identity;
}
interface Vlan {
  vlan_id: number;
  name: string;
  color: string | null;
  subnet_cidr: string | null;
  gateway_ip: string | null;
  dns_servers: string[];
  dhcp_active: boolean;
}
export interface WfNic {
  net_id: string;
  interface_name: string;
  label: string;
  mac_address: string | null;
  model: string;
  pci_slot: string | null;
  vendor_id: string | null;
  device_id: string | null;
  bridge: string;
  vlan_tag: number | null;
  trunks: number[];
  ipv4_addresses: string[];
  link_up: boolean;
  rate_mbps: number | null;
  vlan: Vlan | null;
  lab: { lab_id: string; name: string; subnet_cidr: string } | null;
}
interface Placement {
  mode: "standalone" | "cluster";
  host?: string | null;
  host_ip?: string | null;
  cluster_name?: string;
  ha_enabled?: boolean;
  preferred_active_host?: string | null;
  passive_standby_hosts?: string[];
  replication_interval_minutes?: number | null;
  floating_vips?: { address: string; label?: string; bridge: string }[];
}
interface Detailed {
  running: boolean;
  name: string;
  cores: number | null;
  sockets: number | null;
  memory_mb: number | null;
  os_profile: string | null;
  devices: VDev[];
  nics: WfNic[];
  passthrough: { pci: { key: string; id: string; x_vga: boolean; pcie: boolean }[]; usb: { key: string; host: string; usb3: boolean }[] };
  disks: { key: string; volume: string; size: string | null }[];
  placement: Placement;
}
interface OptionSpec {
  key: string;
  kind: "select" | "text" | "number";
  choices?: string[];
  default: string | number;
  min?: number;
  max?: number;
  when?: [string, string];
}
interface Bridge {
  name: string;
  mode: string;
  member_ports: string[];
}
interface SwitchState {
  bridges: Bridge[];
  vlans: { vlan_id: number; name: string; bridge: string; lab?: string }[];
}
interface Lab {
  id: string;
  name: string;
  bridge: string;
}

type Sel = { kind: "nic" | "vdev" | "pci" | "usb" | "disk"; id: string };
type Section = "net" | "pcie" | "peripheral" | "storage";
interface Slot {
  sel: Sel;
  section: Section;
  label: string;
  sub: string;
  icon: ReactNode;
}

const ICONS: Record<string, ReactNode> = {
  hd_audio: <Mic size={14} />,
  legacy_audio: <Music size={14} />,
  virtual_camera: <Webcam size={14} />,
  sas_hba: <Server size={14} />,
  virtual_nvme: <HardDrive size={14} />,
  hayes_modem: <Phone size={14} />,
  vtpm: <ShieldCheck size={14} />,
  smartcard: <CreditCard size={14} />,
  watchdog: <Timer size={14} />,
  virtio_rng: <Dices size={14} />,
};
const QEMU_MODELS = ["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "ne2k_pci", "pcnet"];
const SECTIONS: Section[] = ["net", "pcie", "peripheral", "storage"];

/* Blueprint geometry (SVG user units = px; the canvas scrolls rather than scales, so popovers line up). */
const W = 1100;
const CX = 20; // chassis
const CW = 380;
const RW = 320;
const RX = W - 20 - RW; // right-hand topology nodes
/** Inspector body: every field visible at a glance under the full-width canvas. */
const GRID = "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3";
/** Sticks to the bottom of the drawer's scroll area so Save & Apply stays reachable while the inspector is in view. */
const FOOTER = "sticky bottom-0 -mx-5 -mb-5 flex flex-wrap items-center justify-end gap-3 rounded-b-2xl border-t border-[var(--sd-border-hairline)] bg-[var(--sd-surface-panel)] px-5 py-4";
const SLOT_H = 30;
const SLOT_STEP = 36;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A random locally administered unicast MAC (first byte xxxxxx10). */
export const randomMac = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  b[0] = (b[0] & 0xfc) | 0x02;
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(":").toUpperCase();
};
const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} C${x1 + 90} ${y1}, ${x2 - 90} ${y2}, ${x2} ${y2}`;
const shown = (o: OptionSpec, v: Record<string, string | number>) => !o.when || v[o.when[0]] === o.when[1];

function slotsOf(d: Detailed, t: (k: TKey, v?: Record<string, string | number>) => string): Slot[] {
  const out: Slot[] = d.nics.map((n) => ({
    sel: { kind: "nic", id: n.net_id },
    section: "net",
    label: `${n.net_id} · ${n.interface_name !== n.net_id ? n.interface_name : n.model}`,
    sub: `${n.model} · ${n.mac_address ?? "—"}`,
    icon: <Network size={14} />,
  }));
  d.passthrough.pci.forEach((p) =>
    out.push({ sel: { kind: "pci", id: p.key }, section: "pcie", label: p.x_vga ? t("wf.gpu") : t("wf.pciDevice"), sub: `${p.key} · ${p.id}`, icon: <Cpu size={14} /> }),
  );
  d.devices
    .filter((v) => v.type !== "legacy_nic") // shown as its NIC
    .forEach((v) =>
      out.push({
        sel: { kind: "vdev", id: v.id },
        section: v.category === "storage" ? "storage" : v.bus === "PCIe" ? "pcie" : "peripheral",
        label: v.identity.device_name || t(`vhw.dev.${v.type}` as TKey),
        sub: `${v.bus}${v.identity.native_vendor_id ? ` · ${v.identity.vendor_id || v.identity.native_vendor_id}:${v.identity.device_id || v.identity.native_device_id}` : ""}`,
        icon: ICONS[v.type] ?? <Cpu size={14} />,
      }),
    );
  d.passthrough.usb.forEach((u) => out.push({ sel: { kind: "usb", id: u.key }, section: "peripheral", label: t("wf.usbDevice"), sub: `${u.key} · ${u.host}`, icon: <Usb size={14} /> }));
  d.disks.forEach((k) => out.push({ sel: { kind: "disk", id: k.key }, section: "storage", label: `${k.key}${k.size ? ` · ${k.size}` : ""}`, sub: k.volume, icon: <HardDrive size={14} /> }));
  return out;
}

/* ---------------- Inspector & editor ---------------- */

function NicEditor({ gt, vmid, nic, bridges, onSaved }: { gt: "vm" | "lxc"; vmid: number; nic: WfNic; bridges: Bridge[]; onSaved: (msg: string) => void }) {
  const { t } = useTranslation();
  const init = useMemo(
    () => ({
      interface_name: nic.label || (gt === "lxc" ? nic.interface_name : ""),
      mac_address: nic.mac_address ?? "",
      model: nic.model,
      bridge: nic.bridge,
      vlan_tag: nic.vlan_tag ? String(nic.vlan_tag) : "",
      trunks: nic.trunks.join(","),
      link_up: nic.link_up,
      rate_mbps: nic.rate_mbps ? String(nic.rate_mbps) : "",
    }),
    [nic, gt],
  );
  const [f, setF] = useState(init);
  useEffect(() => setF(init), [init]);
  const { busy, error, run } = useRunner();
  const save = () =>
    run(async () => {
      const json: Record<string, unknown> = {};
      if (f.interface_name !== init.interface_name) json.interface_name = f.interface_name;
      if (f.mac_address !== init.mac_address && f.mac_address) json.mac_address = f.mac_address.toUpperCase();
      if (gt === "vm" && f.model !== init.model) json.model = f.model;
      if (f.bridge !== init.bridge) json.bridge = f.bridge;
      if (f.vlan_tag !== init.vlan_tag) json.vlan_tag = f.vlan_tag ? Number(f.vlan_tag) : null;
      if (f.trunks !== init.trunks) json.trunks = f.trunks.split(/[,; ]+/).filter(Boolean).map(Number);
      if (f.link_up !== init.link_up) json.link_up = f.link_up;
      if (f.rate_mbps !== init.rate_mbps) json.rate_mbps = f.rate_mbps ? Number(f.rate_mbps) : null;
      if (!Object.keys(json).length) return;
      await api(`/virtual-hardware/${gt}/${vmid}/devices/${nic.net_id}`, { method: "PUT", json });
      onSaved(t("wf.saved", { name: nic.net_id }));
    });
  return (
    <div className="space-y-4">
      <div className={GRID}>
      <Field label={gt === "lxc" ? t("wf.ifaceName") : t("wf.ifaceLabel")} hint={gt === "lxc" ? "eth0 … eth99" : t("wf.ifaceLabelHint")}>
        <GlassInput className="w-full" value={f.interface_name} onChange={(e) => setF({ ...f, interface_name: e.target.value })} maxLength={31} />
      </Field>
      <Field label={t("wf.mac")}>
        <div className="flex gap-2">
          <GlassInput className="w-full font-mono" value={f.mac_address} pattern="([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}" onChange={(e) => setF({ ...f, mac_address: e.target.value })} />
          <GlassButton title={t("wf.randomMac")} aria-label={t("wf.randomMac")} onClick={() => setF({ ...f, mac_address: randomMac() })}>
            <Shuffle size={14} />
          </GlassButton>
        </div>
      </Field>
      {gt === "vm" && (
        <Field label={t("wf.model")}>
          <GlassSelect className="w-full" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
            {QEMU_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </GlassSelect>
        </Field>
      )}
        <Field label={t("wf.switch")}>
          <GlassSelect className="w-full" value={f.bridge} onChange={(e) => setF({ ...f, bridge: e.target.value })}>
            {!bridges.some((b) => b.name === f.bridge) && <option value={f.bridge}>{f.bridge}</option>}
            {bridges.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <Field label={t("wf.vlanTag")}>
          <GlassInput className="w-full" type="number" min={1} max={4094} placeholder={t("wf.untagged")} value={f.vlan_tag} onChange={(e) => setF({ ...f, vlan_tag: e.target.value })} />
        </Field>
        <Field label={t("wf.trunks")}>
          <GlassInput className="w-full" placeholder="—" value={f.trunks} pattern="[0-9, ;]*" onChange={(e) => setF({ ...f, trunks: e.target.value })} />
        </Field>
        <Field label={t("wf.rate")}>
          <GlassInput className="w-full" type="number" min={1} placeholder={t("wf.unlimited")} value={f.rate_mbps} onChange={(e) => setF({ ...f, rate_mbps: e.target.value })} />
        </Field>
        <div className="flex items-end pb-1">
          <GlassSwitch checked={f.link_up} onChange={(v) => setF({ ...f, link_up: v })} label={t("wf.linkUp")} />
        </div>
      </div>
      <dl className={GRID}>
        <Meta k={t("wf.pciSlot")} v={nic.pci_slot ?? t("wf.auto")} />
        <Meta k={t("wf.vidPid")} v={nic.vendor_id ? `${nic.vendor_id}:${nic.device_id}` : t("wf.vethPair")} />
        <Meta k="IPv4" v={nic.ipv4_addresses.join(", ") || "—"} />
      </dl>
      <p className="text-[11px] text-slate-400">{t("wf.nicIdsHint")}</p>
      <Footer error={error} busy={busy} onSave={save} />
    </div>
  );
}

function DeviceEditor({ gt, vmid, dev, spec, onSaved }: { gt: "vm" | "lxc"; vmid: number; dev: VDev; spec: OptionSpec[]; onSaved: (msg: string) => void }) {
  const { t } = useTranslation();
  const init = useMemo(() => ({ ...dev.identity }), [dev]);
  const [id, setId] = useState(init);
  const [opts, setOpts] = useState(dev.options);
  useEffect(() => (setId(init), setOpts(dev.options)), [init, dev.options]);
  const { busy, error, run } = useRunner();
  const visible = (k: string) => dev.identity.guest_visible.includes(k);
  const tag = (k: string) => (visible(k) ? <GlassBadge tone="success">{t("wf.guestVisible")}</GlassBadge> : null);
  const save = () =>
    run(async () => {
      const identity = Object.fromEntries(
        (["device_name", "vendor_id", "device_id", "serial_number", "pci_or_usb_address"] as const).filter((k) => id[k] !== init[k]).map((k) => [k, id[k]]),
      );
      const changedOpts = spec.filter((o) => shown(o, opts)).some((o) => opts[o.key] !== dev.options[o.key]);
      const json: Record<string, unknown> = {};
      if (Object.keys(identity).length) json.identity = identity;
      if (changedOpts) json.options = Object.fromEntries(spec.filter((o) => shown(o, opts)).map((o) => [o.key, opts[o.key]]));
      if (!Object.keys(json).length) return;
      const r = await api<{ restart_required: boolean; notes: string[] }>(`/virtual-hardware/${gt}/${vmid}/devices/${dev.id}`, { method: "PUT", json });
      const extra = [
        ...(r.restart_required ? [t("vhw.restartNote")] : []),
        ...(r.notes.includes("camera_name_applies_at_reload") ? [t("wf.noteCameraReload")] : []),
        ...(r.notes.includes("modem_applies_at_start") ? [t("wf.noteModemStart")] : []),
      ];
      onSaved([t("wf.saved", { name: t(`vhw.dev.${dev.type}` as TKey) }), ...extra].join(" "));
    });
  const field = (k: keyof typeof id, label: string, props: Record<string, unknown> = {}) => (
    <Field label={<span className="flex items-center gap-2">{label}{tag(k)}</span>}>
      <GlassInput className="w-full" value={String(id[k] ?? "")} onChange={(e) => setId({ ...id, [k]: e.target.value })} {...props} />
    </Field>
  );
  return (
    <div className="space-y-4">
      <div className={GRID}>
        {field("device_name", t("wf.displayName"), { placeholder: t(`vhw.dev.${dev.type}` as TKey), maxLength: 31, pattern: "[A-Za-z0-9][A-Za-z0-9 ._()+\\-]{0,30}" })}
        {field("vendor_id", t("wf.vendorId"), { placeholder: dev.identity.native_vendor_id ?? "0x0000", className: "w-full font-mono", pattern: "(0x)?[0-9A-Fa-f]{4}" })}
        {field("device_id", t("wf.deviceId"), { placeholder: dev.identity.native_device_id ?? "0x0000", className: "w-full font-mono", pattern: "(0x)?[0-9A-Fa-f]{4}" })}
        {field("serial_number", t("wf.serial"), { maxLength: 20, pattern: "[A-Za-z0-9\\-]{0,20}", className: "w-full font-mono" })}
        {field("pci_or_usb_address", t("wf.address"), { className: "w-full font-mono" })}
      </div>
      <p className="text-[11px] text-slate-400">
        {dev.identity.guest_visible.length ? t("wf.identityPartial") : t("wf.identityLabelOnly")}
        {dev.identity.native_vendor_id && ` ${t("wf.nativeIds", { ids: `${dev.identity.native_vendor_id}:${dev.identity.native_device_id}` })}`}
      </p>
      {spec.filter((o) => shown(o, opts)).length > 0 && (
        <div className="space-y-3 rounded-xl border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-card)] p-3">
          <div className="text-[11px] font-semibold text-slate-300">{t("wf.deviceSettings")}</div>
          <div className={GRID}>
          {spec
            .filter((o) => shown(o, opts))
            .map((o) => (
              <Field key={o.key} label={t(`vhw.opt.${o.key}` as TKey)}>
                {o.kind === "select" ? (
                  <GlassSelect className="w-full" value={String(opts[o.key] ?? o.default)} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.value })}>
                    {o.choices!.map((c) => (
                      <option key={c} value={c}>
                        {o.key === "source" || o.key === "action" ? t(`vhw.choice.${c}` as TKey) : c.toUpperCase().replace("_", " ")}
                      </option>
                    ))}
                  </GlassSelect>
                ) : (
                  <GlassInput
                    className="w-full"
                    type={o.kind === "number" ? "number" : "text"}
                    min={o.min}
                    max={o.max}
                    value={opts[o.key] ?? ""}
                    onChange={(e) => setOpts({ ...opts, [o.key]: o.kind === "number" ? Number(e.target.value) : e.target.value })}
                  />
                )}
              </Field>
            ))}
          </div>
        </div>
      )}
      <Footer error={error} busy={busy} onSave={save} />
    </div>
  );
}

/** Inspector footer row: the save error beside a right-aligned Save & Apply. */
function Footer({ error, busy, onSave }: { error: string; busy: boolean; onSave: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={FOOTER}>
      <div className="min-w-0 flex-1">
        <Notice error={error} />
      </div>
      <GlassButton variant="primary" disabled={busy} onClick={onSave}>
        {t("wf.saveApply")}
      </GlassButton>
    </div>
  );
}

/** One read-only metadata cell (bus, PCI slot, IDs, IPv4). */
function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-card)] px-3 py-2 text-[11px]">
      <dt className="text-slate-400">{k}</dt>
      <dd className="font-mono break-all text-slate-200">{v}</dd>
    </div>
  );
}

/* ---------------- Endpoint re-patch popover ---------------- */

function RepatchPopover({ gt, vmid, nic, sw, labs, labsOnly, x, y, onClose, onDone }: {
  gt: "vm" | "lxc";
  vmid: number;
  nic: WfNic;
  sw: SwitchState | null;
  labs: Lab[];
  labsOnly: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const current = nic.lab ? `l:${nic.lab.lab_id}` : nic.vlan_tag ? `v:${nic.bridge}:${nic.vlan_tag}` : `b:${nic.bridge}`;
  const [target, setTarget] = useState(current);
  const { busy, error, run } = useRunner();
  // Boundary-aware: the canvas scales to its column, so map SVG units to pixels and keep the whole popover inside it.
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return;
    const k = host.clientWidth / W;
    const clamp = (v: number, room: number) => Math.max(8, Math.min(v, room - 8));
    setPos({ left: clamp(x * k, host.clientWidth - el.offsetWidth), top: clamp(y * k, host.clientHeight - el.offsetHeight) });
  }, [x, y]);
  const labBridges = new Set(labs.map((l) => l.bridge));
  const kindOf = (b: Bridge) => (b.mode === "nat" ? t("wf.routerBridge") : b.member_ports.length ? t("wf.physicalBridge", { ports: b.member_ports.join(", ") }) : t("wf.virtualSwitch"));
  const apply = () =>
    run(async () => {
      const [k, a, b] = target.split(":");
      const json = k === "l" ? { net_id: nic.net_id, lab_id: a } : { net_id: nic.net_id, bridge: a, vlan_tag: k === "v" ? Number(b) : null };
      await api(`/virtual-hardware/${gt}/${vmid}/repatch-endpoint`, { method: "POST", json });
      onDone(t("wf.repatched", { name: nic.net_id }));
    });
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t("wf.changeEndpoint")}
      className="absolute z-20 w-80 max-w-[calc(100%-16px)] space-y-2 rounded-xl border border-[var(--sd-accent-border)] bg-[var(--sd-surface-panel)] p-3 shadow-2xl backdrop-blur-xl"
      style={pos ?? { left: 8, top: 8, visibility: "hidden" }}
    >
      <div className="flex items-center">
        <h4 className="flex-1 text-xs font-semibold text-white">{labsOnly ? t("wf.switchLab") : t("wf.changeEndpoint")}</h4>
        <button className="text-slate-400 hover:text-white" onClick={onClose} aria-label={t("common.close")}>
          <X size={14} />
        </button>
      </div>
      <GlassSelect className="w-full" value={target} onChange={(e) => setTarget(e.target.value)} size={8}>
        {!labsOnly && (
          <optgroup label={t("wf.switches")}>
            {(sw?.bridges ?? [])
              .filter((b) => !labBridges.has(b.name))
              .map((b) => (
                <option key={b.name} value={`b:${b.name}`}>
                  {b.name} — {kindOf(b)}
                </option>
              ))}
          </optgroup>
        )}
        {!labsOnly && (
          <optgroup label={t("wf.vlans")}>
            {(sw?.vlans ?? [])
              .filter((v) => !v.lab && !labBridges.has(v.bridge))
              .map((v) => (
                <option key={v.vlan_id} value={`v:${v.bridge}:${v.vlan_id}`}>
                  VLAN {v.vlan_id} · {v.name} ({v.bridge})
                </option>
              ))}
          </optgroup>
        )}
        <optgroup label={t("wf.labs")}>
          {labs.map((l) => (
            <option key={l.id} value={`l:${l.id}`}>
              {l.name} ({l.bridge})
            </option>
          ))}
        </optgroup>
        {labsOnly && (
          <optgroup label={t("wf.leaveLab")}>
            {(sw?.bridges ?? [])
              .filter((b) => !labBridges.has(b.name))
              .map((b) => (
                <option key={b.name} value={`b:${b.name}`}>
                  {b.name} — {kindOf(b)}
                </option>
              ))}
          </optgroup>
        )}
      </GlassSelect>
      <Notice error={error} />
      <GlassButton variant="primary" className="w-full" disabled={busy || target === current} onClick={apply}>
        {t("wf.applyNow")}
      </GlassButton>
    </div>
  );
}

/* ---------------- Main ---------------- */

export default function WireframeNodeArchitect({ guest, onChanged }: { guest: Guest; onChanged?: () => void }) {
  const { t } = useTranslation();
  const gt = guest.type === "qemu" ? "vm" : "lxc";
  const [d, setD] = useState<Detailed | null>(null);
  const [sw, setSw] = useState<SwitchState | null>(null);
  const [labs, setLabs] = useState<Lab[]>([]);
  const [spec, setSpec] = useState<Record<string, OptionSpec[]>>({});
  const [sel, setSel] = useState<Sel | null>(null);
  const [pop, setPop] = useState<{ net: string; x: number; y: number; labsOnly: boolean } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inspector = useRef<HTMLElement>(null);
  // The inspector opens below the canvas: bring it into view when a device is picked.
  useEffect(() => {
    inspector.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [sel]);
  const load = useCallback(() => {
    api<Detailed>(`/virtual-hardware/${gt}/${guest.vmid}/detailed`).then((r) => (setD(r), setError("")), (e) => setError(e.message));
    api<SwitchState>("/network/switch/state").then(setSw, () => setSw(null));
    api<{ labs: Lab[] }>("/virtual-hardware/labs/sandbox").then((r) => setLabs(r.labs), () => setLabs([]));
  }, [gt, guest.vmid]);
  useEffect(() => {
    load();
    api<{ devices: { type: string; options: OptionSpec[] }[] }>("/virtual-hardware/catalog").then((c) => setSpec(Object.fromEntries(c.devices.map((x) => [x.type, x.options]))), () => {});
  }, [load]);
  const done = (msg: string) => (setNotice(msg), setPop(null), load(), onChanged?.());

  const slots = useMemo(() => (d ? slotsOf(d, t) : []), [d, t]);
  const layout = useMemo(() => {
    if (!d) return null;
    let y = 20 + 84;
    const pos: Record<string, number> = {};
    const heads: { section: Section; y: number }[] = [];
    for (const s of SECTIONS) {
      const items = slots.filter((x) => x.section === s);
      if (!items.length) continue;
      heads.push({ section: s, y });
      y += 24;
      items.forEach((x) => ((pos[`${x.sel.kind}:${x.sel.id}`] = y), (y += SLOT_STEP)));
      y += 8;
    }
    const chassisH = Math.max(y - 20 + 8, 200);
    const cluster = d.placement.mode === "cluster";
    const ph = cluster ? 140 : 80;
    let ry = 20 + ph + 24;
    const ends: Record<string, number> = {};
    d.nics.forEach((n) => {
      const want = pos[`nic:${n.net_id}`] + SLOT_H / 2 - 36;
      ends[n.net_id] = Math.max(want, ry);
      ry = ends[n.net_id] + 72 + 14;
    });
    return { pos, heads, chassisH, ph, ends, height: Math.max(20 + chassisH, ry) + 20 };
  }, [d, slots]);

  if (!d || !layout) return error ? <Notice error={error} /> : <p className="text-sm text-slate-400">{t("common.loading")}</p>;
  const isSel = (s: Sel) => sel?.kind === s.kind && sel.id === s.id;
  const pick = (s: Sel) => (setSel(isSel(s) ? null : s), setPop(null));
  const keyAct = (fn: () => void) => (e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fn());
  const selNic = sel?.kind === "nic" ? d.nics.find((n) => n.net_id === sel.id) : undefined;
  const selDev = sel?.kind === "vdev" ? d.devices.find((v) => v.id === sel.id) : undefined;
  const selSlot = sel ? slots.find((s) => isSel(s.sel)) : undefined;
  const p = d.placement;
  const memGb = d.memory_mb ? `${(d.memory_mb / 1024).toFixed(d.memory_mb % 1024 ? 1 : 0)} GB` : "—";
  const vcpu = (d.cores ?? 1) * (d.sockets ?? 1);
  const openPop = (n: WfNic, labsOnly: boolean) => setPop({ net: n.net_id, x: RX - 20, y: Math.min(layout.ends[n.net_id] + 76, layout.height - 40), labsOnly });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[11px] text-slate-400">{t("wf.intro")}</p>
        <GlassButton onClick={load} aria-label={t("common.refresh")}>
          <RefreshCw size={14} />
        </GlassButton>
      </div>
      <Notice notice={notice} />
      {/* Canvas full width on top; the device inspector stacks below it (never beside it), for VMs and containers alike. */}
      <div className="flex flex-col gap-4">
        <div className="relative w-full rounded-xl border border-[var(--bp-border)] bg-[var(--sd-surface-canvas)]">
          <svg viewBox={`0 0 ${W} ${layout.height}`} className="block h-auto w-full select-none" role="img" aria-label={t("wf.canvasLabel", { name: d.name })}>
            <defs>
              <pattern id="wf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M20 0H0V20" fill="none" stroke="var(--bp-grid)" />
              </pattern>
            </defs>
            <style>{`@keyframes wfdash{to{stroke-dashoffset:-24}}.wf-flow{stroke-dasharray:6 6;animation:wfdash 1.2s linear infinite}
              @media (prefers-reduced-motion:reduce){.wf-flow{animation:none}}.wf-hit{cursor:pointer}.wf-hit:focus{outline:none}.wf-hit:focus-visible>rect{stroke:#fde047}`}</style>
            <rect width={W} height={layout.height} fill="url(#wf-grid)" />

            {/* Chassis */}
            <rect x={CX} y={20} width={CW} height={layout.chassisH} rx={14} fill="var(--bp-node)" fillOpacity=".55" stroke={ink("#7dd3fc")} strokeWidth={1.5} />
            <rect x={CX + 8} y={28} width={CW - 16} height={68} rx={8} fill="none" stroke={ink("#7dd3fc")} strokeOpacity=".45" strokeDasharray="3 3" />
            <circle cx={CX + 26} cy={48} r={5} fill={ink(d.running ? "#4ade80" : "#64748b")}>
              {d.running && <animate attributeName="opacity" values="1;.35;1" dur="2s" repeatCount="indefinite" />}
            </circle>
            <text x={CX + 40} y={53} fill="var(--bp-text)" fontSize={15} fontWeight={600}>
              {clip(d.name, 28)}
            </text>
            <text x={CX + 20} y={78} fill="var(--bp-label)" fontSize={11} fontFamily="ui-monospace,monospace">
              {`${vcpu} vCPU · ${memGb} RAM · ${d.os_profile ? (d.os_profile.startsWith("l2") ? "Linux" : d.os_profile) : gt === "lxc" ? t("wf.container") : "—"} · ${d.running ? t("wf.running") : t("wf.stopped")}`}
            </text>
            <text x={CX + CW - 18} y={53} fill="var(--bp-label)" fontSize={10} textAnchor="end">
              {gt === "vm" ? "VM" : "CT"} {guest.vmid}
            </text>
            {layout.heads.map((h) => (
              <text key={h.section} x={CX + 16} y={h.y + 15} fill="var(--bp-label)" fontSize={10} fontWeight={600} letterSpacing={1.2}>
                {t(`wf.section.${h.section}` as TKey).toUpperCase()}
              </text>
            ))}
            {slots.map((s) => {
              const y = layout.pos[`${s.sel.kind}:${s.sel.id}`];
              const on = isSel(s.sel);
              return (
                <g key={`${s.sel.kind}:${s.sel.id}`} className="wf-hit" role="button" tabIndex={0} aria-pressed={on} aria-label={`${s.label} — ${t("wf.inspect")}`} onClick={() => pick(s.sel)} onKeyDown={keyAct(() => pick(s.sel))}>
                  <rect x={CX + 16} y={y} width={CW - 32} height={SLOT_H} rx={6} fill={on ? "var(--bp-slot-on)" : "var(--bp-node)"} fillOpacity={on ? 1 : 0.8} stroke={ink(on ? "#22d3ee" : "#7dd3fc")} strokeOpacity={on ? 1 : 0.5} strokeWidth={on ? 2 : 1} style={on ? { filter: "drop-shadow(0 0 6px #22d3ee)" } : undefined} />
                  <g transform={`translate(${CX + 24} ${y + 8})`} color="var(--bp-text-2)">
                    {s.icon}
                  </g>
                  <text x={CX + 46} y={y + 13} fill="var(--bp-text)" fontSize={11} fontWeight={500}>
                    {clip(s.label, 34)}
                  </text>
                  <text x={CX + 46} y={y + 25} fill="var(--bp-label)" fontSize={9} fontFamily="ui-monospace,monospace">
                    {clip(s.sub, 48)}
                  </text>
                  {s.sel.kind === "nic" && <circle cx={CX + CW} cy={y + SLOT_H / 2} r={4} fill="var(--bp-node)" stroke={ink("#22d3ee")} strokeWidth={2} />}
                </g>
              );
            })}

            {/* Host & cluster placement */}
            <path d={curve(CX + CW, 62, RX, 20 + layout.ph / 2)} fill="none" stroke={ink("#a78bfa")} strokeWidth={1.5} className="wf-flow" />
            <g aria-label={t("wf.placement")}>
              <rect x={RX} y={20} width={RW} height={layout.ph} rx={10} fill="var(--bp-node-violet)" stroke={ink("#a78bfa")} strokeWidth={1.5} />
              <g transform={`translate(${RX + 12} 32)`} color="var(--bp-violet-text)">
                <Server size={14} />
              </g>
              <text x={RX + 32} y={44} fill="var(--bp-violet-text)" fontSize={12} fontWeight={600}>
                {p.mode === "cluster" ? t("wf.clusterMode", { name: p.cluster_name ?? "" }) : t("wf.standaloneMode")}
              </text>
              <text x={RX + 14} y={64} fill="var(--bp-violet-text)" fontSize={10} fontFamily="ui-monospace,monospace">
                {`${p.host ?? "—"}${p.host_ip ? ` · ${p.host_ip}` : ""}`}
              </text>
              {p.mode === "cluster" && (
                <>
                  <text x={RX + 14} y={82} fill="var(--bp-violet-text)" fontSize={10}>
                    {`${t("wf.preferredActive")}: ${p.preferred_active_host ?? "—"}${p.ha_enabled ? "" : ` (${t("wf.noHa")})`}`}
                  </text>
                  <text x={RX + 14} y={98} fill="var(--bp-violet-text)" fontSize={10}>
                    {`${t("wf.standbyHosts")}: ${p.passive_standby_hosts?.join(", ") || "—"}`}
                  </text>
                  <text x={RX + 14} y={114} fill="var(--bp-violet-text)" fontSize={10}>
                    {`${t("wf.zfsSync")}: ${p.replication_interval_minutes ? t("wf.everyMin", { n: p.replication_interval_minutes }) : "—"}`}
                  </text>
                  <text x={RX + 14} y={130} fill="var(--bp-violet-text)" fontSize={10}>
                    {`${t("wf.floatingVip")}: ${clip(p.floating_vips?.map((v) => v.address).join(", ") || "—", 36)}`}
                  </text>
                </>
              )}
            </g>

            {/* NIC → switch / VLAN / lab endpoints */}
            {d.nics.map((n) => {
              const y1 = layout.pos[`nic:${n.net_id}`] + SLOT_H / 2;
              const ey = layout.ends[n.net_id];
              const lab = n.lab;
              const color = lab ? "#f59e0b" : n.vlan?.color || "#22d3ee";
              const open = () => openPop(n, !!lab);
              return (
                <g key={n.net_id}>
                  <path d={curve(CX + CW, y1, RX, ey + 36)} fill="none" stroke="transparent" strokeWidth={14} className="wf-hit" onClick={open} />
                  <path d={curve(CX + CW, y1, RX, ey + 36)} fill="none" stroke={ink(color)} strokeWidth={n.link_up ? 2 : 1} strokeOpacity={n.link_up ? 1 : 0.4} className={n.link_up ? "wf-flow" : ""} pointerEvents="none" />
                  <g className="wf-hit" role="button" tabIndex={0} aria-label={`${lab ? lab.name : n.bridge} — ${lab ? t("wf.switchLab") : t("wf.changeEndpoint")}`} onClick={open} onKeyDown={keyAct(open)}>
                    <rect x={RX} y={ey} width={RW} height={72} rx={10} fill={lab ? "var(--bp-node-amber)" : "var(--bp-node-sky)"} stroke={ink(color)} strokeWidth={1.5} />
                    <g transform={`translate(${RX + 12} ${ey + 11})`} color={ink(color)}>
                      {lab ? <FlaskConical size={14} /> : <Cable size={14} />}
                    </g>
                    <text x={RX + 32} y={ey + 23} fill="var(--bp-text)" fontSize={12} fontWeight={600}>
                      {clip(lab ? `${t("wf.isolatedLab")}: ${lab.name}` : n.bridge || t("wf.unconnected"), 30)}
                    </text>
                    {n.vlan && !lab && (
                      <g>
                        <rect x={RX + RW - 92} y={ey + 10} width={80} height={17} rx={8.5} fill={ink(color)} fillOpacity=".25" stroke={ink(color)} />
                        <text x={RX + RW - 52} y={ey + 22} fill="var(--bp-text)" fontSize={9.5} textAnchor="middle">
                          {clip(`VLAN ${n.vlan.vlan_id}`, 12)}
                        </text>
                      </g>
                    )}
                    {lab && (
                      <text x={RX + RW - 12} y={ey + 22} fill="var(--bp-warn-text)" fontSize={9.5} textAnchor="end">
                        {t("wf.labBadge")}
                      </text>
                    )}
                    <text x={RX + 14} y={ey + 42} fill="var(--bp-text-2)" fontSize={10} fontFamily="ui-monospace,monospace">
                      {clip(`${n.net_id} · ${n.ipv4_addresses[0] ?? t("wf.noIp")}${n.vlan_tag && !n.vlan ? ` · tag ${n.vlan_tag}` : ""}${n.trunks.length ? ` · trunk ${n.trunks.join(",")}` : ""}`, 46)}
                    </text>
                    {(() => {
                      const dhcp = lab ? true : !!n.vlan?.dhcp_active;
                      const dns = lab ? false : !!n.vlan?.dns_servers.length;
                      return (
                        <text x={RX + 14} y={ey + 60} fontSize={9.5}>
                          <tspan fill={dhcp ? ink("#4ade80") : "var(--bp-pill-off-text)"}>● DHCP</tspan>
                          <tspan dx={10} fill={dns ? ink("#4ade80") : "var(--bp-pill-off-text)"}>● DNS</tspan>
                          <tspan dx={10} fill="var(--bp-label)">
                            {clip(lab?.subnet_cidr ?? n.vlan?.subnet_cidr ?? "", 20)}
                          </tspan>
                        </text>
                      );
                    })()}
                  </g>
                </g>
              );
            })}
            {!d.nics.length && (
              <text x={RX} y={20 + layout.ph + 44} fill="var(--bp-label)" fontSize={11}>
                {t("wf.noNics")}
              </text>
            )}
          </svg>

          {pop && (() => {
            const n = d.nics.find((x) => x.net_id === pop.net);
            return n ? <RepatchPopover gt={gt} vmid={guest.vmid} nic={n} sw={sw} labs={labs} labsOnly={pop.labsOnly} x={pop.x} y={pop.y} onClose={() => setPop(null)} onDone={done} /> : null;
          })()}
        </div>

        {sel && (
          <section ref={inspector} className="w-full rounded-2xl border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-panel)] p-5" aria-label={t("wf.inspectorTitle")}>
            <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-[var(--sd-border-hairline)] pb-3">
              <span className="text-[var(--sd-accent)]">{selSlot?.icon ?? <MemoryStick size={14} />}</span>
              <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                {t("wf.inspectorTitle")}
                {selSlot && <span className="font-normal text-slate-300"> · {selSlot.label}</span>}
              </h4>
              {selNic && (
                <GlassButton onClick={() => openPop(selNic, false)}>
                  <Cable size={14} /> {t("wf.changeEndpoint")}
                </GlassButton>
              )}
              <GlassButton onClick={() => setSel(null)} aria-label={t("common.close")}>
                <X size={14} /> {t("common.close")}
              </GlassButton>
            </div>
            {selNic ? (
              <NicEditor gt={gt} vmid={guest.vmid} nic={selNic} bridges={(sw?.bridges ?? []).filter((b) => !labs.some((l) => l.bridge === b.name))} onSaved={done} />
            ) : selDev ? (
              <DeviceEditor gt={gt} vmid={guest.vmid} dev={selDev} spec={spec[selDev.type] ?? []} onSaved={done} />
            ) : (
              <ReadOnly d={d} sel={sel} />
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ReadOnly({ d, sel }: { d: Detailed; sel: Sel }) {
  const { t } = useTranslation();
  const row =
    sel.kind === "pci"
      ? d.passthrough.pci.find((x) => x.key === sel.id)
      : sel.kind === "usb"
        ? d.passthrough.usb.find((x) => x.key === sel.id)
        : d.disks.find((x) => x.key === sel.id);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-white">
        {sel.kind === "disk" ? <HardDrive size={14} /> : sel.kind === "usb" ? <Usb size={14} /> : <Monitor size={14} />}
        {sel.id}
      </div>
      <dl className={GRID}>
        {Object.entries(row ?? {}).map(([k, v]) => (
          <Meta key={k} k={k} v={String(v ?? "—")} />
        ))}
      </dl>
      <p className="text-[11px] text-slate-400">{t("wf.managedInForm")}</p>
    </div>
  );
}
