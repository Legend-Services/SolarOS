import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Camera, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useCapabilities } from "../store/capabilitiesStore";
import type { Guest, GuestConfig, StorageVolume, SystemInfo } from "../lib/types";
import { bytes } from "../lib/format";
import { useRunner } from "../lib/hooks";
import { useTelemetry } from "../lib/stores";
import { GuideBanner } from "../components/wizards/GuidedWizardModal";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";
import { TaskLog } from "../components/TaskCenter";
import { PassthroughPicker, usePassthroughDevices, type PciSel, type UsbSel } from "./guest/passthrough";
import { HaPolicyForm } from "../components/cluster/ClusterDialogs";
import VirtualHardwarePanel from "../components/compute/VirtualHardwarePanel";
import WireframeNodeArchitect from "../components/compute/WireframeNodeArchitect";
import SerialConsole from "../components/compute/SerialConsole";
import { useTranslation } from "../i18n";

type Tab = "resources" | "hardware" | "virtual" | "network" | "cloudinit" | "snapshots" | "ha" | "serial" | "options";

interface HostPci {
  key: string;
  index: number;
  raw: string;
  id: string;
  pcie: boolean;
  rombar: boolean;
  x_vga: boolean;
  all_functions: boolean;
}
interface UsbDevice {
  key: string;
  index: number;
  host: string;
  usb3: boolean;
}
interface Nic {
  key: string;
  index: number;
  model?: string;
  name?: string;
  macaddr: string | null;
  bridge: string;
  tag: number | null;
  firewall: boolean;
  rate: number | null;
  ip?: string | null;
  gw?: string | null;
  ip6?: string | null;
}
interface CloudInit {
  ciuser: string | null;
  nameserver: string | null;
  searchdomain: string | null;
  citype: string | null;
  sshkeys: string;
  password_set: boolean;
  ipconfig: Record<string, string>;
  drive: string | null;
}
interface Hardware {
  devices: { hostpci: HostPci[]; usb: UsbDevice[]; net: Nic[] };
  cloudinit: CloudInit | null;
  options: Record<string, string | number | null>;
  pending: string[];
  cdrom?: { iso: string | null } | null;
}
interface Snapshot {
  name: string;
  description: string;
  parent: string | null;
  snaptime: number | null;
  vmstate: boolean;
  current: boolean;
}

const nextFree = (used: number[], max: number) => Array.from({ length: max + 1 }, (_, i) => i).find((i) => !used.includes(i));

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-soft rounded-xl p-3">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="flex-1 text-xs font-semibold text-slate-200">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ---------------- Resources (moved from Compute Manager's former Edit dialog) ---------------- */

function ResourcesTab({ guest, onSaved }: { guest: Guest; onSaved: () => void }) {
  const [cfg, setCfg] = useState<GuestConfig | null>(null);
  const [f, setF] = useState({ cores: 1, memory: 512, swap: 0, onboot: false, description: "", tags: "" });
  const [disk, setDisk] = useState("");
  const [grow, setGrow] = useState(0);
  const { busy, error, notice, run, setError } = useRunner();

  const load = useCallback(() => {
    api<GuestConfig>(`/v1/guests/${guest.type}/${guest.vmid}/config`).then((c) => {
      setCfg(c);
      setF({ cores: c.cores, memory: c.memory, swap: c.swap ?? 0, onboot: c.onboot, description: c.description, tags: c.tags });
      setDisk(c.disks.find((d) => d.resizable)?.key ?? "");
    }, (e) => setError(e.message));
  }, [guest, setError]);
  useEffect(load, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!cfg) return;
    // Only send what changed, so untouched settings never become pending changes.
    const json: Record<string, unknown> = {};
    (["cores", "memory", "onboot", "description", "tags"] as const).forEach((k) => f[k] !== cfg[k] && (json[k] = f[k]));
    if (guest.type === "lxc" && f.swap !== (cfg.swap ?? 0)) json.swap = f.swap;
    if (grow > 0 && disk) Object.assign(json, { resize_disk: disk, resize_to: `+${grow}G` });
    if (!Object.keys(json).length) return;
    if (await run(() => api(`/v1/guests/${guest.type}/${guest.vmid}/config`, { method: "PATCH", json }), "Saved.")) {
      setGrow(0);
      load();
      onSaved();
    }
  };

  const resizable = cfg?.disks.filter((d) => d.resizable) ?? [];
  if (!cfg) return error ? <Notice error={error} /> : <p className="text-sm text-slate-400">Loading configuration…</p>;
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={guest.type === "qemu" ? `CPU cores (× ${cfg.sockets} socket${cfg.sockets > 1 ? "s" : ""})` : "CPU cores"}>
          <GlassInput type="number" min={1} max={512} className="w-full" value={f.cores} onChange={(e) => setF({ ...f, cores: Number(e.target.value) })} required />
        </Field>
        <Field label="Memory (MB)" hint={bytes(f.memory * 1024 * 1024)}>
          <GlassInput type="number" min={64} step={64} className="w-full" value={f.memory} onChange={(e) => setF({ ...f, memory: Number(e.target.value) })} required />
        </Field>
        {guest.type === "lxc" && (
          <Field label="Swap (MB)">
            <GlassInput type="number" min={0} step={64} className="w-full" value={f.swap} onChange={(e) => setF({ ...f, swap: Number(e.target.value) })} />
          </Field>
        )}
        <Field label="Tags" hint="Separated by ; or ,">
          <GlassInput className="w-full" value={f.tags} pattern="[A-Za-z0-9_.;, \-]*" onChange={(e) => setF({ ...f, tags: e.target.value })} />
        </Field>
      </div>
      <Field label="Description / notes">
        <textarea className="glass-field h-16 w-full resize-none" value={f.description} maxLength={8000} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <GlassSwitch checked={f.onboot} onChange={(v) => setF({ ...f, onboot: v })} label="Start at boot" />
      <div className="glass-soft rounded-xl p-3">
        <p className="mb-2 text-[11px] text-slate-400">Expand disk (disks can only grow)</p>
        {resizable.length === 0 ? (
          <p className="text-[11px] text-slate-500">No resizable disks.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Disk">
              <GlassSelect value={disk} onChange={(e) => setDisk(e.target.value)}>
                {resizable.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.key} · {d.size} · {d.volume}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            <Field label="Add (GB)">
              <GlassInput type="number" min={0} max={65536} className="w-24" value={grow} onChange={(e) => setGrow(Math.max(0, Number(e.target.value)))} />
            </Field>
          </div>
        )}
      </div>
      <Notice error={error} notice={notice} />
      <div className="flex justify-end">
        <GlassButton type="submit" variant="primary" disabled={busy}>
          Save changes
        </GlassButton>
      </div>
    </form>
  );
}

/* ---------------- CD/DVD drive (QEMU) ---------------- */

/** Load an ISO into the VM's install drive or eject it (applies at once on the native driver, otherwise at the next start if running). */
function CdromCard({ guest, hw, reload }: { guest: Guest; hw: Hardware; reload: () => void }) {
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const stores = targets.filter((t) => t.active && t.content.split(",").includes("iso")).map((t) => t.storage).join(",");
  const [isos, setIsos] = useState<StorageVolume[]>([]);
  const current = hw.cdrom?.iso ?? "";
  const [pick, setPick] = useState(current);
  const { busy, error, notice, run } = useRunner(reload);
  useEffect(() => setPick(current), [current]);
  useEffect(() => {
    if (!stores) return;
    Promise.all(stores.split(",").map((s) => api<StorageVolume[]>(`/v1/storage/${s}/content?content=iso`).catch(() => []))).then((l) => setIsos(l.flat()));
  }, [stores]);
  const [restart, setRestart] = useState(false);
  const set = (iso: string | null) =>
    run(async () => {
      const r = await api<{ restart_required?: boolean }>(`/v1/guests/qemu/${guest.vmid}/cdrom`, { method: "PUT", json: { iso_volume: iso } });
      setRestart(!!r.restart_required);
    }, iso ? "ISO loaded." : "Drive ejected.");

  return (
    <div className="glass-soft space-y-2 rounded-2xl p-3">
      <div className="text-xs font-medium text-slate-200">CD/DVD drive</div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Installation media (ISO)" hint={isos.length ? undefined : "No ISOs yet: add one in ISO & Templates (upload or download)."}>
          <GlassSelect className="w-72 max-w-full" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Empty</option>
            {isos.map((v) => (
              <option key={v.volid} value={v.volid}>
                {v.volid.split("/").pop()}
              </option>
            ))}
            {current && !isos.some((v) => v.volid === current) && <option value={current}>{current}</option>}
          </GlassSelect>
        </Field>
        <GlassButton variant="primary" size="sm" disabled={busy || pick === current || !pick} onClick={() => set(pick)}>
          Load ISO
        </GlassButton>
        <GlassButton size="sm" disabled={busy || !current} onClick={() => set(null)}>
          Eject
        </GlassButton>
      </div>
      <Notice error={error} notice={notice} />
      {restart && <p className="text-[11px] text-amber-300">This VM had no CD/DVD drive yet: stop and start it to boot from the ISO.</p>}
    </div>
  );
}

/* ---------------- Hardware & Passthrough (QEMU) ---------------- */

function HardwareTab({ guest, hw, reload }: { guest: Guest; hw: Hardware; reload: () => void }) {
  const [adding, setAdding] = useState<"pci" | "usb" | null>(null);
  const [pciSel, setPciSel] = useState<PciSel[]>([]);
  const [usbSel, setUsbSel] = useState<UsbSel[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const devices = usePassthroughDevices(adding !== null);
  const { busy, error, notice, run } = useRunner(reload);
  const base = `/v1/guests/qemu/${guest.vmid}`;
  const { hostpci, usb } = hw.devices;

  const open = (kind: "pci" | "usb") => (setPciSel([]), setUsbSel([]), setAdding(kind));
  const save = async () => {
    const ok = await run(async () => {
      const w: string[] = [];
      const usedPci = hostpci.map((d) => d.index);
      for (const p of pciSel) {
        const idx = nextFree(usedPci, 15);
        if (idx === undefined) throw new Error("All 16 hostpci slots are in use");
        usedPci.push(idx);
        w.push(...(await api<{ warnings: string[] }>(`${base}/hostpci/${idx}`, { method: "PUT", json: p })).warnings);
      }
      const usedUsb = usb.map((d) => d.index);
      for (const u of usbSel) {
        const idx = nextFree(usedUsb, 4);
        if (idx === undefined) throw new Error("All 5 USB slots are in use");
        usedUsb.push(idx);
        await api(`${base}/usb/${idx}`, { method: "PUT", json: u });
      }
      setWarnings([...new Set(w)]);
    }, "Devices added. Restart the VM for passthrough changes to take effect.");
    if (ok) setAdding(null);
  };
  const remove = (key: string, kind: "hostpci" | "usb", idx: number) => run(() => api(`${base}/${kind}/${idx}`, { method: "DELETE" }), `${key} removed.`);

  return (
    <div className="space-y-3">
      {hw.cdrom !== undefined && hw.cdrom !== null && <CdromCard guest={guest} hw={hw} reload={reload} />}
      {guest.type === "qemu" && <GuideBanner guide="compute-passthrough" text="Learn how GPU, USB and audio passthrough work and what to check before you add a device." />}
      <Section
        title="PCI / GPU passthrough"
        action={
          <GlassButton size="xs" onClick={() => open("pci")}>
            <Plus size={12} /> Add PCI/GPU device
          </GlassButton>
        }
      >
        {!hostpci.length && <p className="text-[11px] text-slate-500">No PCI devices passed through.</p>}
        <ul className="space-y-1">
          {hostpci.map((d) => (
            <li key={d.key} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--sd-surface-card)] px-2 py-1.5 text-[11px]">
              <span className="font-mono text-slate-400">{d.key}</span>
              <span className="font-mono text-slate-100">{d.id}</span>
              {d.all_functions && <GlassBadge tone="info">ALL FUNCTIONS</GlassBadge>}
              {d.pcie && <GlassBadge>PCIe</GlassBadge>}
              {d.x_vga && <GlassBadge tone="info">PRIMARY GPU</GlassBadge>}
              {!d.rombar && <GlassBadge>ROM BAR OFF</GlassBadge>}
              {hw.pending.includes(d.key) && <GlassBadge tone="warning">PENDING</GlassBadge>}
              <GlassButton size="xs" variant="ghost" className="ml-auto" disabled={busy} onClick={() => remove(d.key, "hostpci", d.index)} aria-label={`Remove ${d.key}`}>
                <Trash2 size={12} />
              </GlassButton>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title="USB passthrough"
        action={
          <GlassButton size="xs" onClick={() => open("usb")}>
            <Plus size={12} /> Add USB device
          </GlassButton>
        }
      >
        {!usb.length && <p className="text-[11px] text-slate-500">No USB devices passed through.</p>}
        <ul className="space-y-1">
          {usb.map((d) => (
            <li key={d.key} className="flex items-center gap-2 rounded-lg bg-[var(--sd-surface-card)] px-2 py-1.5 text-[11px]">
              <span className="font-mono text-slate-400">{d.key}</span>
              <span className="font-mono text-slate-100">{d.host}</span>
              {d.usb3 && <GlassBadge tone="info">USB 3</GlassBadge>}
              {hw.pending.includes(d.key) && <GlassBadge tone="warning">PENDING</GlassBadge>}
              <GlassButton size="xs" variant="ghost" className="ml-auto" disabled={busy} onClick={() => remove(d.key, "usb", d.index)} aria-label={`Remove ${d.key}`}>
                <Trash2 size={12} />
              </GlassButton>
            </li>
          ))}
        </ul>
      </Section>
      {warnings.length > 0 && (
        <ul className="space-y-0.5 rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
      <Notice error={error} notice={notice} />
      <GlassModal
        open={adding !== null}
        onClose={() => setAdding(null)}
        title={adding === "usb" ? "Add USB device" : "Add PCI / GPU device"}
        width="max-w-2xl"
        footer={
          <>
            <GlassButton onClick={() => setAdding(null)}>Cancel</GlassButton>
            <GlassButton variant="primary" disabled={busy || !(pciSel.length || usbSel.length)} onClick={save}>
              {busy ? "Adding…" : "Add selected"}
            </GlassButton>
          </>
        }
      >
        <PassthroughPicker
          devices={devices}
          hostpci={pciSel}
          usb={usbSel}
          onChange={(p, u) => (setPciSel(p), setUsbSel(u))}
          sections={adding === "usb" ? ["usb"] : ["gpu", "pci"]}
        />
        <div className="mt-3">
          <Notice error={error} />
        </div>
      </GlassModal>
    </div>
  );
}

/* ---------------- Network ---------------- */

const MODELS = ["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"];

function NetworkTab({ guest, hw, reload }: { guest: Guest; hw: Hardware; reload: () => void }) {
  const lxc = guest.type === "lxc";
  const dflt = useCapabilities((s) => s.capabilities.default_bridge);
  const [bridges, setBridges] = useState<string[]>([dflt].filter(Boolean));
  const [edit, setEdit] = useState<{ index: number; isNew: boolean } | null>(null);
  const [f, setF] = useState({ model: "virtio", bridge: dflt, tag: "", firewall: true, macaddr: "", rate: "", name: "", static: false, cidr: "", gw: "", ip6: "" });
  const { busy, error, notice, run } = useRunner(reload);
  const nics = hw.devices.net;

  useEffect(() => {
    api<SystemInfo>("/system/info").then((i) => {
      const b = i.network.filter((n) => n.type === "bridge").map((n) => n.iface);
      if (b.length) setBridges(b);
    }, () => {});
  }, []);

  const openEdit = (n?: Nic) => {
    const index = n ? n.index : nextFree(nics.map((x) => x.index), 7);
    if (index === undefined) return;
    const ip = n?.ip ?? "dhcp";
    setF({
      model: n?.model ?? "virtio", bridge: n?.bridge ?? bridges[0], tag: n?.tag ? String(n.tag) : "", firewall: n?.firewall ?? true,
      macaddr: n?.macaddr ?? "", rate: n?.rate ? String(n.rate) : "", name: n?.name ?? `eth${index}`,
      static: !["dhcp", "manual"].includes(ip), cidr: ["dhcp", "manual"].includes(ip) ? "" : ip, gw: n?.gw ?? "", ip6: n?.ip6 ?? "",
    });
    setEdit({ index, isNew: !n });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const json = {
      bridge: f.bridge, tag: f.tag ? Number(f.tag) : null, firewall: f.firewall, macaddr: f.macaddr || null, rate: f.rate ? Number(f.rate) : null,
      ...(lxc ? { name: f.name, ip: f.static ? f.cidr : "dhcp", gw: f.static && f.gw ? f.gw : null, ip6: f.ip6 || null } : { model: f.model }),
    };
    if (await run(() => api(`/v1/guests/${guest.type}/${guest.vmid}/net/${edit.index}`, { method: "PUT", json }), `net${edit.index} saved.`)) setEdit(null);
  };

  return (
    <div className="space-y-3">
      <Section
        title="Network interfaces"
        action={
          <GlassButton size="xs" disabled={nics.length >= 8} onClick={() => openEdit()}>
            <Plus size={12} /> Add interface
          </GlassButton>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-[11px]">
            <thead className="text-slate-400">
              <tr>
                <th className="py-1 font-medium">Interface</th>
                <th className="px-2 font-medium">{lxc ? "Name" : "Model"}</th>
                <th className="px-2 font-medium">Bridge</th>
                <th className="px-2 font-medium">VLAN</th>
                <th className="px-2 font-medium">MAC</th>
                {lxc && <th className="px-2 font-medium">IP</th>}
                <th className="px-2 font-medium">Firewall</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {nics.map((n) => (
                <tr key={n.key} className="border-t border-white/5">
                  <td className="py-1.5 font-mono text-slate-100">
                    {n.key} {hw.pending.includes(n.key) && <GlassBadge tone="warning">PENDING</GlassBadge>}
                  </td>
                  <td className="px-2 text-slate-300">{lxc ? n.name : n.model}</td>
                  <td className="px-2 font-mono text-slate-300">{n.bridge}</td>
                  <td className="px-2 text-slate-300">{n.tag ?? "—"}</td>
                  <td className="px-2 font-mono text-slate-400">{n.macaddr ?? "auto"}</td>
                  {lxc && <td className="px-2 font-mono text-slate-300">{n.ip ?? "—"}</td>}
                  <td className="px-2">{n.firewall ? <GlassBadge tone="success">ON</GlassBadge> : <GlassBadge>OFF</GlassBadge>}</td>
                  <td className="text-right whitespace-nowrap">
                    <GlassButton size="xs" variant="ghost" onClick={() => openEdit(n)} aria-label={`Edit ${n.key}`}>
                      <Pencil size={12} />
                    </GlassButton>
                    <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => run(() => api(`/v1/guests/${guest.type}/${guest.vmid}/net/${n.index}`, { method: "DELETE" }), `${n.key} removed.`)} aria-label={`Remove ${n.key}`}>
                      <Trash2 size={12} />
                    </GlassButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!nics.length && <p className="py-2 text-[11px] text-slate-500">No network interfaces.</p>}
        </div>
      </Section>
      <Notice error={error} notice={notice} />
      <GlassModal open={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.isNew ? "Add" : "Edit"} net${edit.index}` : ""}>
        <form onSubmit={save} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {lxc ? (
              <Field label="Name">
                <GlassInput className="w-full font-mono" pattern="eth[0-9]{1,2}" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
              </Field>
            ) : (
              <Field label="Model">
                <GlassSelect className="w-full" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
                  {MODELS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </GlassSelect>
              </Field>
            )}
            <Field label="Bridge">
              <GlassSelect className="w-full" value={f.bridge} onChange={(e) => setF({ ...f, bridge: e.target.value })}>
                {[...new Set([...bridges, f.bridge])].map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </GlassSelect>
            </Field>
            <Field label="VLAN tag" hint="1–4094, empty for untagged">
              <GlassInput type="number" min={1} max={4094} className="w-full" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} />
            </Field>
            <Field label="MAC address" hint="Empty = generate">
              <GlassInput className="w-full font-mono" pattern="([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}" value={f.macaddr} onChange={(e) => setF({ ...f, macaddr: e.target.value })} />
            </Field>
            <Field label="Rate limit (MB/s)" hint="Empty = unlimited">
              <GlassInput type="number" min={0} step="any" className="w-full" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
            </Field>
            {lxc && (
              <Field label="IPv4">
                <Segmented
                  value={f.static ? "static" : "dhcp"}
                  onChange={(v) => setF({ ...f, static: v === "static" })}
                  options={[
                    { id: "dhcp", label: "DHCP" },
                    { id: "static", label: "Static" },
                  ]}
                />
              </Field>
            )}
            {lxc && f.static && (
              <>
                <Field label="Address (CIDR)">
                  <GlassInput className="w-full font-mono" placeholder="192.168.1.50/24" value={f.cidr} onChange={(e) => setF({ ...f, cidr: e.target.value })} required />
                </Field>
                <Field label="Gateway">
                  <GlassInput className="w-full font-mono" placeholder="192.168.1.1" value={f.gw} onChange={(e) => setF({ ...f, gw: e.target.value })} />
                </Field>
              </>
            )}
            {lxc && (
              <Field label="IPv6">
                <GlassSelect className="w-full" value={f.ip6} onChange={(e) => setF({ ...f, ip6: e.target.value })}>
                  <option value="">None</option>
                  <option value="auto">SLAAC (auto)</option>
                  <option value="dhcp">DHCPv6</option>
                  <option value="manual">Manual</option>
                </GlassSelect>
              </Field>
            )}
          </div>
          <GlassSwitch checked={f.firewall} onChange={(v) => setF({ ...f, firewall: v })} label="Host firewall" />
          <Notice error={error} />
          <div className="flex justify-end gap-2">
            <GlassButton onClick={() => setEdit(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="primary" disabled={busy}>
              Save
            </GlassButton>
          </div>
        </form>
      </GlassModal>
    </div>
  );
}

/* ---------------- Cloud-Init (QEMU) ---------------- */

function CloudInitTab({ guest, ci, reload }: { guest: Guest; ci: CloudInit; reload: () => void }) {
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const stores = targets.filter((t) => t.active && t.content.includes("images")).map((t) => t.storage);
  const [f, setF] = useState({ ciuser: "", cipassword: "", sshkeys: "", ipconfig0: "", nameserver: "", searchdomain: "", citype: "", storage: "" });
  const { busy, error, notice, run } = useRunner(reload);
  useEffect(() => {
    setF({
      ciuser: ci.ciuser ?? "", cipassword: "", sshkeys: ci.sshkeys, ipconfig0: ci.ipconfig.ipconfig0 ?? "", nameserver: ci.nameserver ?? "",
      searchdomain: ci.searchdomain ?? "", citype: ci.citype ?? "", storage: "",
    });
  }, [ci]);
  const base = `/v1/guests/qemu/${guest.vmid}/cloudinit`;
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(
      () =>
        api(base, {
          method: "PUT",
          json: {
            ciuser: f.ciuser, cipassword: f.cipassword || null, sshkeys: f.sshkeys, nameserver: f.nameserver, searchdomain: f.searchdomain,
            citype: f.citype || null, ipconfig: { ipconfig0: f.ipconfig0 }, add_drive_storage: !ci.drive && f.storage ? f.storage : null,
          },
        }),
      "Cloud-init settings saved. They apply on the next boot (regenerate the image to rebuild it now).",
    );
  };
  return (
    <form onSubmit={save} className="space-y-3">
      {ci.drive ? (
        <p className="text-[11px] text-slate-400">
          Cloud-init drive: <span className="font-mono text-slate-200">{ci.drive}</span>
        </p>
      ) : (
        <div className="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          This VM has no cloud-init drive. Pick a storage to add one when saving:
          <GlassSelect className="ml-2" value={f.storage} onChange={(e) => setF({ ...f, storage: e.target.value })}>
            <option value="">Don't add</option>
            {stores.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </GlassSelect>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="User">
          <GlassInput className="w-full" value={f.ciuser} pattern="[a-z_][a-z0-9_\-]{0,31}" onChange={(e) => setF({ ...f, ciuser: e.target.value })} />
        </Field>
        <Field label="Password" hint={ci.password_set ? "A password is set; leave empty to keep it" : undefined}>
          <GlassInput type="password" className="w-full" value={f.cipassword} autoComplete="new-password" onChange={(e) => setF({ ...f, cipassword: e.target.value })} />
        </Field>
        <Field label="IP config (net0)" hint='e.g. "ip=dhcp" or "ip=10.0.0.5/24,gw=10.0.0.1"'>
          <GlassInput className="w-full font-mono" value={f.ipconfig0} onChange={(e) => setF({ ...f, ipconfig0: e.target.value })} />
        </Field>
        <Field label="Type">
          <GlassSelect className="w-full" value={f.citype} onChange={(e) => setF({ ...f, citype: e.target.value })}>
            <option value="">Default (nocloud / configdrive2 for Windows)</option>
            <option value="nocloud">nocloud</option>
            <option value="configdrive2">configdrive2</option>
            <option value="opennebula">opennebula</option>
          </GlassSelect>
        </Field>
        <Field label="DNS servers" hint="Space-separated; empty = host settings">
          <GlassInput className="w-full font-mono" value={f.nameserver} onChange={(e) => setF({ ...f, nameserver: e.target.value })} />
        </Field>
        <Field label="Search domain">
          <GlassInput className="w-full" value={f.searchdomain} onChange={(e) => setF({ ...f, searchdomain: e.target.value })} />
        </Field>
      </div>
      <Field label="SSH public keys" hint="One key per line">
        <textarea className="glass-field h-24 w-full resize-none font-mono text-[11px]" value={f.sshkeys} onChange={(e) => setF({ ...f, sshkeys: e.target.value })} spellCheck={false} />
      </Field>
      <Notice error={error} notice={notice} />
      <div className="flex justify-end gap-2">
        <GlassButton disabled={busy || !ci.drive} onClick={() => run(() => api(`${base}/regenerate`, { method: "POST" }), "Cloud-init image regenerated.")}>
          <RefreshCw size={12} /> Regenerate image
        </GlassButton>
        <GlassButton type="submit" variant="primary" disabled={busy}>
          Save
        </GlassButton>
      </div>
    </form>
  );
}

/* ---------------- Snapshots ---------------- */

function SnapshotsTab({ guest }: { guest: Guest }) {
  const [items, setItems] = useState<Snapshot[] | null>(null);
  const [f, setF] = useState({ name: "", description: "", vmstate: false });
  const [ask, setAsk] = useState<{ snap: string; action: "rollback" | "delete" } | null>(null);
  const [upid, setUpid] = useState("");
  const base = `/v1/guests/${guest.type}/${guest.vmid}/snapshots`;
  const load = useCallback(() => {
    api<Snapshot[]>(base).then(setItems, () => setItems([]));
  }, [base]);
  useEffect(load, [load]);
  const { busy, error, run } = useRunner();

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(() => api<{ upid: string }>(base, { method: "POST", json: f }).then((r) => (setUpid(r.upid), setF({ name: "", description: "", vmstate: false }))));
  };
  const confirm = async () => {
    if (!ask) return;
    const ok = await run(() =>
      api<{ upid: string }>(ask.action === "rollback" ? `${base}/${ask.snap}/rollback` : `${base}/${ask.snap}`, { method: ask.action === "rollback" ? "POST" : "DELETE" }).then((r) =>
        setUpid(r.upid),
      ),
    );
    if (ok) setAsk(null);
  };

  // Order as a tree: children follow their parent, indented by depth.
  const tree: { s: Snapshot; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) =>
    (items ?? []).filter((s) => (s.parent ?? null) === parent).forEach((s) => (tree.push({ s, depth }), walk(s.name, depth + 1)));
  walk(null, 0);

  return (
    <div className="space-y-3">
      <Section title="Take snapshot">
        <form onSubmit={create} className="flex flex-wrap items-end gap-2">
          <Field label="Name">
            <GlassInput className="w-40" pattern="[A-Za-z][A-Za-z0-9_\-]{1,39}" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </Field>
          <Field label="Description" className="min-w-40 flex-1">
            <GlassInput className="w-full" value={f.description} maxLength={1000} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          {guest.type === "qemu" && <GlassSwitch checked={f.vmstate} onChange={(v) => setF({ ...f, vmstate: v })} label="Include RAM" disabled={guest.status !== "running"} />}
          <GlassButton type="submit" variant="primary" disabled={busy}>
            <Camera size={12} /> Snapshot
          </GlassButton>
        </form>
      </Section>
      {upid && <TaskLog key={upid} upid={upid} className="h-28" onDone={load} />}
      <Section title="Snapshots">
        {items === null ? (
          <p className="text-[11px] text-slate-500">Loading…</p>
        ) : tree.length <= 1 ? (
          <p className="text-[11px] text-slate-500">No snapshots yet.</p>
        ) : (
          <ul className="space-y-1">
            {tree.map(({ s, depth }) => (
              <li key={s.name} className="flex items-center gap-2 rounded-lg bg-[var(--sd-surface-card)] px-2 py-1.5 text-[11px]" style={{ marginLeft: depth * 14 }}>
                <span className={`font-medium ${s.current ? "text-sky-200" : "text-slate-100"}`}>{s.current ? "NOW (current state)" : s.name}</span>
                {s.vmstate && <GlassBadge tone="info">RAM</GlassBadge>}
                <span className="min-w-0 flex-1 truncate text-slate-400">{s.description}</span>
                {s.snaptime && <span className="text-slate-500">{new Date(s.snaptime * 1000).toLocaleString()}</span>}
                {!s.current && (
                  <>
                    <GlassButton size="xs" variant="ghost" onClick={() => setAsk({ snap: s.name, action: "rollback" })} aria-label={`Roll back to ${s.name}`}>
                      <RotateCcw size={12} />
                    </GlassButton>
                    <GlassButton size="xs" variant="ghost" onClick={() => setAsk({ snap: s.name, action: "delete" })} aria-label={`Delete ${s.name}`}>
                      <Trash2 size={12} />
                    </GlassButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Notice error={!ask ? error : ""} />
      <ConfirmModal
        open={!!ask}
        onClose={() => setAsk(null)}
        onConfirm={confirm}
        busy={busy}
        error={error}
        title={ask?.action === "rollback" ? "Roll back snapshot" : "Delete snapshot"}
        confirmLabel={ask?.action === "rollback" ? "Roll back" : "Delete"}
        expect={ask?.action === "rollback" ? ask.snap : undefined}
        message={
          ask?.action === "rollback"
            ? `Return ${guest.name} to snapshot "${ask.snap}"? Everything changed since then is lost.`
            : `Delete snapshot "${ask?.snap}"? The guest's current state is not affected.`
        }
      />
    </div>
  );
}

/* ---------------- Options ---------------- */

const OSTYPES = ["l26", "l24", "win11", "win10", "win8", "win7", "w2k8", "wxp", "solaris", "other"];

function OptionsTab({ guest, hw, reload }: { guest: Guest; hw: Hardware; reload: () => void }) {
  const qemu = guest.type === "qemu";
  const o = hw.options;
  const str = (k: string) => (o[k] == null ? "" : String(o[k]));
  const flag = (k: string, dflt = false) => (o[k] == null ? dflt : String(o[k]).split(",")[0] === "1");
  const initial = () => ({
    name: str(qemu ? "name" : "hostname"), startup: str("startup"), boot: str("boot"), cpu: str("cpu"), machine: str("machine"), hotplug: str("hotplug"),
    ostype: str("ostype"), bios: str("bios"), features: str("features"),
    onboot: flag("onboot"), protection: flag("protection"), agent: flag("agent"), numa: flag("numa"), tablet: flag("tablet", true),
  });
  const [f, setF] = useState(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setF(initial()), [hw]);
  const { busy, error, notice, run } = useRunner(reload);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const start = initial();
    const keys = qemu
      ? (["name", "startup", "boot", "cpu", "machine", "hotplug", "ostype", "bios", "onboot", "protection", "agent", "numa", "tablet"] as const)
      : (["name", "startup", "features", "onboot", "protection"] as const);
    const json: Record<string, unknown> = {};
    keys.forEach((k) => f[k] !== start[k] && (json[k === "name" && !qemu ? "hostname" : k] = f[k]));
    if (!Object.keys(json).length) return;
    run(() => api(`/v1/guests/${guest.type}/${guest.vmid}/options`, { method: "PATCH", json }), "Options saved.");
  };
  const text = (k: keyof ReturnType<typeof initial>, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <GlassInput className="w-full font-mono" value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );
  const sw = (k: keyof ReturnType<typeof initial>, label: string) => <GlassSwitch checked={f[k] as boolean} onChange={(v) => setF({ ...f, [k]: v })} label={label} />;

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {text("name", qemu ? "Name" : "Hostname")}
        {text("startup", "Start/shutdown order", "e.g. order=1,up=30,down=60")}
        {qemu && (
          <>
            {text("boot", "Boot order", "e.g. order=scsi0;ide2;net0")}
            {text("cpu", "CPU type", "e.g. host, x86-64-v2-AES")}
            {text("machine", "Machine", "q35 or pc (i440fx)")}
            {text("hotplug", "Hotplug", "e.g. network,disk,usb")}
            <Field label="OS type">
              <GlassSelect className="w-full" value={f.ostype} onChange={(e) => setF({ ...f, ostype: e.target.value })}>
                <option value="">—</option>
                {OSTYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </GlassSelect>
            </Field>
            <Field label="Firmware">
              <GlassSelect className="w-full" value={f.bios} onChange={(e) => setF({ ...f, bios: e.target.value })}>
                <option value="">Default (SeaBIOS)</option>
                <option value="seabios">SeaBIOS</option>
                <option value="ovmf">UEFI (OVMF)</option>
              </GlassSelect>
            </Field>
          </>
        )}
        {!qemu && text("features", "Features", "e.g. nesting=1,keyctl=1")}
        {!qemu && (
          <Field label="Container type">
            <span className="block py-1.5 text-xs text-slate-200">{flag("unprivileged") ? "Unprivileged" : "Privileged"} (fixed at creation)</span>
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {sw("onboot", "Start at boot")}
        {sw("protection", "Protection (block removal)")}
        {qemu && sw("agent", "QEMU guest agent")}
        {qemu && sw("numa", "NUMA")}
        {qemu && sw("tablet", "Tablet pointer")}
      </div>
      <Notice error={error} notice={notice} />
      <div className="flex justify-end">
        <GlassButton type="submit" variant="primary" disabled={busy}>
          Save options
        </GlassButton>
      </div>
    </form>
  );
}

/* ---------------- Delete ---------------- */

/** Permanently removes a stopped guest and its disks (purge); the name must be typed to confirm. */
function DeleteCard({ guest, onDeleted }: { guest: Guest; onDeleted: () => void }) {
  const kind = guest.type === "qemu" ? "VM" : "container";
  const [ask, setAsk] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  const { busy, error, run } = useRunner();
  const stopped = guest.status === "stopped";
  const remove = () =>
    run(async () => {
      const r = await api<{ upid?: string | null; task?: string | null }>(`/v1/guests/${guest.type}/${guest.vmid}`, { method: "DELETE" });
      setAsk(false);
      if (r.upid || r.task) setTask(r.upid || r.task || null);
      else onDeleted();
    });

  return (
    <div className="mt-6 space-y-2 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-3">
      <div className="text-xs font-medium text-rose-200">Delete {kind}</div>
      <p className="text-[11px] text-slate-400">
        Permanently removes {guest.name} ({guest.vmid}) and its disks. Backups are kept.
        {!stopped && ` Stop the ${kind} first.`}
      </p>
      <GlassButton variant="danger" size="sm" disabled={!stopped || busy || !!task} onClick={() => setAsk(true)}>
        <Trash2 size={13} /> Delete {kind}
      </GlassButton>
      {task && <TaskLog upid={task} className="h-24" onDone={(state) => state !== "running" && onDeleted()} />}
      <Notice error={error} />
      <ConfirmModal
        open={ask}
        onClose={() => setAsk(false)}
        onConfirm={remove}
        busy={busy}
        error={error}
        title={`Delete ${kind}`}
        confirmLabel={`Delete ${kind}`}
        expect={guest.name}
        message={`Delete ${guest.name} (${guest.vmid}) and all of its disks? This cannot be undone. Type the name to confirm.`}
      />
    </div>
  );
}

/* ---------------- Drawer ---------------- */

export default function GuestDrawer({ guest, onClose, onSaved, clustered = false }: { guest: Guest | null; onClose: () => void; onSaved: () => void; clustered?: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("resources");
  const [mode, setMode] = useState<"form" | "wireframe">("form");
  const [hw, setHw] = useState<Hardware | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!guest) return;
    api<Hardware>(`/v1/guests/${guest.type}/${guest.vmid}/hardware`).then((h) => (setHw(h), setError("")), (e) => setError(e.message));
  }, [guest]);
  useEffect(() => {
    setHw(null);
    setTab("resources");
    load();
  }, [load]);
  const reload = useCallback(() => (load(), onSaved()), [load, onSaved]);

  const qemu = guest?.type === "qemu";
  const tabs: { id: Tab; label: string }[] = [
    { id: "resources", label: "Resources" },
    ...(qemu ? [{ id: "hardware" as Tab, label: "Hardware & Passthrough" }] : []),
    { id: "virtual", label: t("vhw.tab") },
    { id: "network", label: "Network" },
    ...(qemu ? [{ id: "cloudinit" as Tab, label: "Cloud-Init" }] : []),
    { id: "snapshots", label: "Snapshots" },
    { id: "serial", label: t("serial.tab") },
    ...(clustered ? [{ id: "ha" as Tab, label: t("cl.haTab") }] : []),
    { id: "options", label: "Options" },
  ];

  return (
    <GlassModal open={!!guest} onClose={onClose} side width={mode === "wireframe" ? "max-w-6xl" : "max-w-3xl"} title={guest ? `${guest.name} (${guest.vmid}) · ${qemu ? "VM" : "Container"}` : ""}>
      {guest && (
        <div className="space-y-4">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { id: "form", label: t("wf.formView") },
              { id: "wireframe", label: t("wf.wireframeView") },
            ]}
          />
          {mode === "wireframe" ? (
            <WireframeNodeArchitect key={`${guest.type}${guest.vmid}`} guest={guest} onChanged={reload} />
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={tab} onChange={setTab} options={tabs} />
            {hw && hw.pending.length > 0 && (
              <GlassBadge tone="warning" className="ml-auto">
                PENDING: {hw.pending.join(", ")}
              </GlassBadge>
            )}
          </div>
          {hw && hw.pending.length > 0 && <p className="text-[11px] text-amber-300/90">Some changes are pending and take effect after the next guest restart.</p>}
          <Notice error={error} />
          {tab === "resources" ? (
            <ResourcesTab guest={guest} onSaved={reload} />
          ) : tab === "snapshots" ? (
            <SnapshotsTab guest={guest} />
          ) : tab === "ha" ? (
            <HaPolicyForm key={`${guest.type}${guest.vmid}`} guestType={guest.type} guestId={guest.vmid} />
          ) : tab === "serial" ? (
            <SerialConsole key={`${guest.type}${guest.vmid}`} guestType={guest.type} guestId={guest.vmid} />
          ) : tab === "virtual" ? (
            <VirtualHardwarePanel key={`${guest.type}${guest.vmid}`} guest={guest} />
          ) : !hw ? (
            !error && <p className="text-sm text-slate-400">Loading…</p>
          ) : tab === "hardware" ? (
            <HardwareTab guest={guest} hw={hw} reload={reload} />
          ) : tab === "network" ? (
            <NetworkTab guest={guest} hw={hw} reload={reload} />
          ) : tab === "cloudinit" && hw.cloudinit ? (
            <CloudInitTab guest={guest} ci={hw.cloudinit} reload={reload} />
          ) : (
            <>
              <OptionsTab guest={guest} hw={hw} reload={reload} />
              <DeleteCard guest={guest} onDeleted={() => (onSaved(), onClose())} />
            </>
          )}
          </>
          )}
        </div>
      )}
    </GlassModal>
  );
}
