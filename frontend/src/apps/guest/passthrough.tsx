import { useEffect, useState } from "react";
import { Cpu, Usb } from "lucide-react";
import { api } from "../../lib/api";
import { GlassBadge, GlassSwitch } from "../../components/ui/GlassKit";

/* Device passthrough pickers shared by the Create VM wizard and the guest drawer. */

export interface GpuDevice {
  id: string;
  name: string;
  vendor: string;
  subsystem: string;
  driver: string | null;
  iommu_group: number | null;
  audio_function: string | null;
  iommu_shared_with: string[];
  warnings: string[];
  passthrough_ready: boolean;
}

export interface PciDev {
  id: string;
  iommugroup: number;
  vendor_name: string;
  device_name: string;
  category: "gpu" | "audio" | "nvme" | "usb-controller" | "network" | "other";
  driver: string | null;
  iommu_shared_with: string[];
  warnings: string[];
}

export interface UsbDev {
  host: string;
  port: string | null;
  product: string;
  manufacturer: string;
  speed: string;
  usb3: boolean;
}

export interface PciSel {
  id: string;
  pcie: boolean;
  rombar: boolean;
  x_vga: boolean;
  include_audio: boolean;
}

export interface UsbSel {
  host: string;
  usb3: boolean;
}

export interface Devices {
  gpus: GpuDevice[];
  pci: PciDev[];
  usb: UsbDev[];
  loading: boolean;
  error: string;
}

const short = (id: string) => id.replace(/^0000:/, "");

/** Loads host GPUs (lspci over the SSH bridge), PCI devices and USB devices while `enabled`. */
export function usePassthroughDevices(enabled: boolean): Devices {
  const [d, setD] = useState<Devices>({ gpus: [], pci: [], usb: [], loading: true, error: "" });
  useEffect(() => {
    if (!enabled) return;
    setD((x) => ({ ...x, loading: true }));
    Promise.allSettled([
      api<GpuDevice[]>("/pve/hardware/gpus"),
      api<PciDev[]>("/pve/hardware/pci"),
      api<{ devices: UsbDev[] }>("/pve/hardware/usb"),
    ]).then(([g, p, u]) =>
      setD({
        gpus: g.status === "fulfilled" ? g.value : [],
        pci: p.status === "fulfilled" ? p.value : [],
        usb: u.status === "fulfilled" ? u.value.devices : [],
        loading: false,
        error: [g, p, u].map((r) => (r.status === "rejected" ? (r.reason as Error).message : "")).find(Boolean) ?? "",
      }),
    );
  }, [enabled]);
  return d;
}

const CATEGORIES: { id: PciDev["category"]; label: string }[] = [
  { id: "audio", label: "Audio controllers" },
  { id: "nvme", label: "NVMe drives" },
  { id: "usb-controller", label: "USB controllers" },
  { id: "network", label: "Network cards" },
  { id: "other", label: "Other PCI devices" },
];

function IommuBadge({ group, shared }: { group: number | null; shared: string[] }) {
  if (group === null || group < 0) return <GlassBadge tone="danger">NO IOMMU</GlassBadge>;
  return shared.length ? (
    <GlassBadge tone="warning" className="whitespace-nowrap">
      GROUP {group} · SHARED
    </GlassBadge>
  ) : (
    <GlassBadge tone="success" className="whitespace-nowrap">
      GROUP {group} · ISOLATED
    </GlassBadge>
  );
}

function DriverBadge({ driver }: { driver: string | null }) {
  const tone = driver === "vfio-pci" ? "success" : !driver ? "neutral" : ["nvidia", "nouveau", "i915", "xe", "amdgpu", "radeon"].includes(driver) ? "warning" : "info";
  return <GlassBadge tone={tone}>{driver ?? "NO DRIVER"}</GlassBadge>;
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-[10px] text-amber-200/90">
      {items.map((w) => (
        <li key={w}>⚠ {w}</li>
      ))}
    </ul>
  );
}

/** GPU cards + grouped PCI devices + USB devices. `sections` limits what is shown (drawer "Add" dialogs). */
export function PassthroughPicker({
  devices,
  hostpci,
  usb,
  onChange,
  sections = ["gpu", "pci", "usb"],
}: {
  devices: Devices;
  hostpci: PciSel[];
  usb: UsbSel[];
  onChange: (hostpci: PciSel[], usb: UsbSel[]) => void;
  sections?: ("gpu" | "pci" | "usb")[];
}) {
  const sel = (id: string) => hostpci.find((p) => short(p.id) === short(id));
  const togglePci = (id: string, gpu: boolean) =>
    onChange(sel(id) ? hostpci.filter((p) => short(p.id) !== short(id)) : [...hostpci, { id, pcie: true, rombar: true, x_vga: false, include_audio: gpu }], usb);
  const patchPci = (id: string, patch: Partial<PciSel>) => onChange(hostpci.map((p) => (short(p.id) === short(id) ? { ...p, ...patch } : p)), usb);
  const usbSel = (host: string) => usb.find((u) => u.host === host);
  const toggleUsb = (d: UsbDev) => onChange(hostpci, usbSel(d.host) ? usb.filter((u) => u.host !== d.host) : [...usb, { host: d.host, usb3: d.usb3 }]);
  // GPUs and their paired HDMI audio functions are covered by the GPU cards.
  const gpuSlots = new Set(devices.gpus.map((g) => short(g.id).split(".")[0]));
  const others = devices.pci.filter((d) => d.category !== "gpu" && !gpuSlots.has(short(d.id).split(".")[0]));

  if (devices.loading) return <p className="text-[11px] text-slate-500">Loading host devices…</p>;
  return (
    <div className="space-y-4">
      {devices.error && <p className="text-[11px] text-amber-200/90">Some devices could not be listed: {devices.error}</p>}
      {sections.includes("gpu") && (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
            <Cpu size={12} /> GPUs
          </h4>
          {!devices.gpus.length && <p className="text-[11px] text-slate-500">No GPUs found.</p>}
          <div className="grid gap-2">
            {devices.gpus.map((g) => {
              const s = sel(g.id);
              return (
                <div key={g.id} className={`rounded-xl p-3 ring-1 ring-inset transition ${s ? "bg-sky-400/10 ring-sky-300/30" : "bg-white/[0.03] ring-white/10"}`}>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="checkbox" className="mt-0.5" checked={!!s} onChange={() => togglePci(g.id, true)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-slate-100">{g.name}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <span className="font-mono text-[10px] text-slate-400">{g.id}</span>
                        <DriverBadge driver={g.driver} />
                        <IommuBadge group={g.iommu_group} shared={g.iommu_shared_with} />
                        {g.passthrough_ready && <GlassBadge tone="success">READY</GlassBadge>}
                      </span>
                    </span>
                  </label>
                  <Warnings items={g.warnings} />
                  {s && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 pl-6">
                      <GlassSwitch checked={s.x_vga} onChange={(v) => patchPci(g.id, { x_vga: v })} label="Primary GPU (x-vga)" />
                      <GlassSwitch checked={s.rombar} onChange={(v) => patchPci(g.id, { rombar: v })} label="ROM BAR" />
                      <GlassSwitch checked={s.pcie} onChange={(v) => patchPci(g.id, { pcie: v })} label="PCI Express" />
                      {g.audio_function && (
                        <GlassSwitch checked={s.include_audio} onChange={(v) => patchPci(g.id, { include_audio: v })} label={`Include HDMI audio (${g.audio_function})`} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
      {sections.includes("pci") && (
        <section className="space-y-2">
          {CATEGORIES.map((c) => {
            const list = others.filter((d) => d.category === c.id);
            if (!list.length) return null;
            return (
              <div key={c.id}>
                <h4 className="mb-1 text-[11px] font-semibold text-slate-300">{c.label}</h4>
                <ul className="space-y-1">
                  {list.map((d) => (
                    <li key={d.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[11px] hover:bg-white/5">
                        <input type="checkbox" checked={!!sel(d.id)} onChange={() => togglePci(d.id, false)} />
                        <span className="font-mono text-slate-400">{short(d.id)}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-200">
                          {d.vendor_name} {d.device_name}
                        </span>
                        {d.driver && <span className="font-mono text-[10px] text-slate-500">{d.driver}</span>}
                        <IommuBadge group={d.iommugroup} shared={d.iommu_shared_with} />
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
      {sections.includes("usb") && (
        <section>
          <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
            <Usb size={12} /> USB devices
          </h4>
          {!devices.usb.length && <p className="text-[11px] text-slate-500">No USB devices found.</p>}
          <ul className="space-y-1">
            {devices.usb.map((d) => {
              const s = usbSel(d.host);
              return (
                <li key={`${d.host}-${d.port}`} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] hover:bg-white/5">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={!!s} onChange={() => toggleUsb(d)} />
                    <span className="font-mono text-slate-400">{d.host}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-200">
                      {d.manufacturer} {d.product}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {d.port ? `port ${d.port} · ` : ""}
                      {Number(d.speed) >= 1000 ? `${Number(d.speed) / 1000} Gb/s` : `${d.speed} Mb/s`}
                    </span>
                  </label>
                  {s && <GlassSwitch checked={s.usb3} onChange={(v) => onChange(hostpci, usb.map((u) => (u.host === d.host ? { ...u, usb3: v } : u)))} label="USB 3" />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
