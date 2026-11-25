import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Rocket } from "lucide-react";
import { api } from "../lib/api";
import { useCapabilities } from "../store/capabilitiesStore";
import type { StorageVolume, SystemInfo, TaskState, ZfsDatasetInfo } from "../lib/types";
import { PassthroughPicker, usePassthroughDevices, type PciSel, type UsbSel } from "./guest/passthrough";
import { bytes } from "../lib/format";
import { useRunner } from "../lib/hooks";
import { useTelemetry } from "../lib/stores";
import { GuideBanner } from "../components/wizards/GuidedWizardModal";
import { Field, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";
import { TaskLog } from "../components/TaskCenter";

export type GuestKind = "qemu" | "lxc";

const STEPS: Record<GuestKind, string[]> = {
  qemu: ["General", "OS / ISO", "Disk & Storage", "CPU & Memory", "Network & Passthrough", "Review & Deploy"],
  lxc: ["General", "Template", "Disk & Storage", "CPU & Memory", "Network & Mounts", "Review & Deploy"],
};

const OSTYPES = [
  { id: "l26", label: "Linux (kernel 2.6 – 6.x)" },
  { id: "win11", label: "Windows 11 / Server 2022+" },
  { id: "win10", label: "Windows 10 / Server 2016–2019" },
  { id: "other", label: "Other" },
];

const NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

import { useHypervisorDefaults } from "../store/hypervisorStore";

const initial = {
  vmid: 0,
  name: "",
  password: "",
  iso: "",
  ostype: "l26",
  template: "",
  storage: "",
  disk: 32,
  bios: "ovmf" as "ovmf" | "seabios",
  efidisk: true,
  cores: 2,
  sockets: 1,
  memory: 2048,
  swap: 512,
  bridge: "",
  dhcp: true,
  cidr: "",
  gateway: "",
  nesting: true,
  onboot: false,
  hostpci: [] as PciSel[],
  usb: [] as UsbSel[],
  bind: "",
};

/** Lists volumes of one content type across every active storage that holds it. */
async function volumes(content: "iso" | "vztmpl", stores: string[]) {
  const lists = await Promise.all(stores.map((s) => api<StorageVolume[]>(`/v1/storage/${s}/content?content=${content}`).catch(() => [])));
  return lists.flat();
}

export default function GuestWizard({ kind, open, onClose, onCreated }: { kind: GuestKind | null; open: boolean; onClose: () => void; onCreated?: () => void }) {
  const k: GuestKind = kind ?? "qemu";
  const steps = STEPS[k];
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const refreshStorage = useTelemetry((s) => s.refreshStorage);
  const [step, setStep] = useState(0);
  const [f, setF] = useState(initial);
  const [isos, setIsos] = useState<StorageVolume[]>([]);
  const [bridges, setBridges] = useState<string[]>([]);
  const devices = usePassthroughDevices(open && k === "qemu");
  const [datasets, setDatasets] = useState<string[]>([]);
  const [job, setJob] = useState<{ vmid: number; upid: string } | null>(null);
  const [state, setState] = useState<TaskState | null>(null);
  const { busy, error, run, setError } = useRunner();
  const set = (patch: Partial<typeof initial>) => setF((v) => ({ ...v, ...patch }));

  const active = targets.filter((t) => t.active);
  const diskStores = active.filter((t) => t.content.includes(k === "qemu" ? "images" : "rootdir"));

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setJob(null);
    setState(null);
    setError("");
    const d = useHypervisorDefaults.getState();
    setF({ ...initial, ...(k === "qemu" ? d.vm : d.lxc), nesting: d.nesting });
    refreshStorage();
    api<{ vmid: number }>("/v1/nextid").then((r) => set({ vmid: r.vmid }), (e) => setError(e.message));
    api<SystemInfo>("/system/info").then(
      (i) => {
        const b = i.network.filter((n) => n.type === "bridge").map((n) => n.iface);
        const dflt = useCapabilities.getState().capabilities.default_bridge;
        setBridges(b.length ? b : [dflt].filter(Boolean));
        set({ bridge: b.includes(dflt) || !b.length ? dflt : b[0] });
      },
      () => setBridges([useCapabilities.getState().capabilities.default_bridge].filter(Boolean)),
    );
    if (k === "lxc")
      api<ZfsDatasetInfo[]>("/v1/zfs/datasets").then(
        (d) => setDatasets(d.filter((x) => x.type === "filesystem" && !x.guest_volume && x.name.includes("/")).map((x) => x.name)),
        () => setDatasets([]),
      );
  }, [open, k, refreshStorage, setError]);

  // ISO / template lists once storages are known.
  const contentStores = useMemo(() => active.filter((t) => t.content.includes(k === "qemu" ? "iso" : "vztmpl")).map((t) => t.storage).join(","), [active, k]);
  useEffect(() => {
    if (!open || !contentStores) return;
    volumes(k === "qemu" ? "iso" : "vztmpl", contentStores.split(",")).then((v) => {
      setIsos(v);
      if (k === "lxc" && v.length) set({ template: v[0].volid });
    });
  }, [open, k, contentStores]);

  useEffect(() => {
    if (open && !f.storage && diskStores.length) {
      // Same preference as the installer: ZFS, then local-lvm, then anything.
      const preferred = useHypervisorDefaults.getState().storage;
      const pick = diskStores.find((t) => t.storage === preferred) ?? diskStores.find((t) => t.type === "zfspool") ?? diskStores.find((t) => t.storage === "local-lvm") ?? diskStores[0];
      set({ storage: pick.storage });
    }
  }, [open, f.storage, diskStores]);

  const valid = [
    f.vmid >= 100 && (k === "qemu" ? NAME_RE.test(f.name) : HOST_RE.test(f.name) && f.password.length >= 5),
    k === "qemu" || !!f.template,
    !!f.storage && f.disk >= 1,
    f.cores >= 1 && f.memory >= 64,
    f.dhcp || (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(f.cidr) && /^\d+\.\d+\.\d+\.\d+$/.test(f.gateway)),
    true,
  ];

  const deploy = () =>
    run(async () => {
      const body =
        k === "qemu"
          ? {
              vmid: f.vmid, name: f.name, cores: f.cores, sockets: f.sockets, memory: f.memory, bios: f.bios, efidisk: f.efidisk,
              iso_volume: f.iso || null, storage: f.storage, disk_gb: f.disk, bridge: f.bridge, ostype: f.ostype,
              start_on_boot: f.onboot, hostpci: f.hostpci, usb: f.usb,
            }
          : {
              vmid: f.vmid, hostname: f.name, cores: f.cores, memory: f.memory, swap: f.swap, ostemplate: f.template,
              storage: f.storage, disk_gb: f.disk, bridge: f.bridge, password: f.password, nesting: f.nesting,
              ip_config: f.dhcp ? "dhcp" : { cidr: f.cidr, gateway: f.gateway }, bind_dataset: f.bind || null,
            };
      setJob(await api<{ vmid: number; upid: string }>(`/v1/guests/${k}`, { method: "POST", json: body }));
    });

  const title = k === "qemu" ? "Create Virtual Machine" : "Create Container";

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-2xl"
      footer={
        job ? (
          <GlassButton variant="primary" onClick={() => (onCreated?.(), onClose())} disabled={state === "running" || state === null}>
            <Check size={13} /> Done
          </GlassButton>
        ) : (
          <>
            <GlassButton onClick={step ? () => setStep(step - 1) : onClose}>
              {step ? (
                <>
                  <ChevronLeft size={13} /> Back
                </>
              ) : (
                "Cancel"
              )}
            </GlassButton>
            {step < steps.length - 1 ? (
              <GlassButton variant="primary" disabled={!valid[step]} onClick={() => setStep(step + 1)}>
                Next <ChevronRight size={13} />
              </GlassButton>
            ) : (
              <GlassButton variant="primary" disabled={busy || !valid.every(Boolean)} onClick={deploy}>
                <Rocket size={13} /> {busy ? "Deploying…" : "Deploy"}
              </GlassButton>
            )}
          </>
        )
      }
    >
      {/* Step indicator */}
      <ol className="mb-4 flex flex-wrap gap-1.5">
        {steps.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              disabled={!!job || i > step || busy}
              onClick={() => setStep(i)}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition ${
                i === step ? "bg-sky-400/20 text-sky-100 ring-1 ring-sky-300/30" : i < step ? "text-emerald-200 hover:bg-white/5" : "text-slate-500"
              }`}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${i < step ? "bg-emerald-400/30" : "bg-white/10"}`}>
                {i < step ? <Check size={10} /> : i + 1}
              </span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      {job ? (
        <div className="space-y-3 text-xs">
          <p className="text-slate-300">
            Creating {k === "qemu" ? "VM" : "container"} <span className="font-semibold text-white">{f.name}</span> ({job.vmid}).
            {(f.hostpci.length > 0 || f.usb.length > 0 || f.bind) && " Host options (device passthrough / bind mount) were applied after creation."}
          </p>
          <TaskLog upid={job.upid} className="h-56" onDone={setState} />
          {state === "ok" && <Notice notice={`${k === "qemu" ? "VM" : "Container"} ${job.vmid} is ready. Start it from Compute Manager.`} />}
          {state === "error" && <Notice error="The task failed; see the log above." />}
        </div>
      ) : (
        <div className="space-y-3">
          {step === 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="VM ID" hint="Next free ID suggested by the host">
                <GlassInput type="number" min={100} className="w-full" value={f.vmid || ""} onChange={(e) => set({ vmid: Number(e.target.value) })} />
              </Field>
              <Field label={k === "qemu" ? "Name" : "Hostname"} hint={k === "qemu" ? "Letters, digits, dots and dashes" : "Lowercase letters, digits and dashes"}>
                <GlassInput className="w-full" value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus placeholder={k === "qemu" ? "ubuntu-server" : "my-container"} />
              </Field>
              {k === "lxc" && (
                <Field label="Root password" hint="At least 5 characters">
                  <GlassInput type="password" className="w-full" value={f.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
                </Field>
              )}
              <div className="flex items-end pb-1 sm:col-span-2">
                <GlassSwitch checked={f.onboot} onChange={(v) => set({ onboot: v })} label="Start at boot" disabled={k === "lxc"} />
                {k === "lxc" && <span className="ml-2 text-[10px] text-slate-500">Set later in Edit</span>}
              </div>
            </div>
          )}

          {step === 1 && k === "qemu" && (
            <div className="grid gap-3">
              <Field label="Installation media (ISO)" hint={isos.length ? `${isos.length} ISO image(s) found` : "No ISOs yet — download one in the ISO & Templates tab"}>
                <GlassSelect className="w-full" value={f.iso} onChange={(e) => set({ iso: e.target.value })}>
                  <option value="">No media (PXE / attach later)</option>
                  {isos.map((v) => (
                    <option key={v.volid} value={v.volid}>
                      {v.volid.split("/").pop()} · {bytes(v.size)} · {v.storage}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label="Guest OS type">
                <GlassSelect className="w-full" value={f.ostype} onChange={(e) => set({ ostype: e.target.value })}>
                  {OSTYPES.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
              {f.ostype === "win11" && <p className="text-[11px] text-amber-200/90">A TPM 2.0 state disk is added automatically for Windows 11. Keep UEFI (OVMF) firmware.</p>}
            </div>
          )}

          {step === 1 && k === "lxc" && (
            <Field label="Container template" hint={isos.length ? `${isos.length} template(s) found` : "No templates yet — download one in the ISO & Templates tab"}>
              <GlassSelect className="w-full" value={f.template} onChange={(e) => set({ template: e.target.value })}>
                {!isos.length && <option value="">No templates available</option>}
                {isos.map((v) => (
                  <option key={v.volid} value={v.volid}>
                    {v.volid.split("/").pop()} · {bytes(v.size)} · {v.storage}
                  </option>
                ))}
              </GlassSelect>
            </Field>
          )}

          {step === 2 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Storage">
                <GlassSelect className="w-full" value={f.storage} onChange={(e) => set({ storage: e.target.value })}>
                  {!diskStores.length && <option value="">No storage for {k === "qemu" ? "disk images" : "container volumes"}</option>}
                  {diskStores.map((t) => (
                    <option key={t.storage} value={t.storage}>
                      {t.storage} ({t.type}) · {bytes(t.avail)} free
                    </option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label="Disk size (GB)">
                <GlassInput type="number" min={1} max={65536} className="w-full" value={f.disk} onChange={(e) => set({ disk: Number(e.target.value) })} />
              </Field>
              {k === "qemu" && (
                <>
                  <Field label="Firmware">
                    <Segmented
                      value={f.bios}
                      onChange={(v) => set({ bios: v })}
                      options={[
                        { id: "ovmf", label: "UEFI (OVMF)" },
                        { id: "seabios", label: "Legacy BIOS (SeaBIOS)" },
                      ]}
                    />
                  </Field>
                  <div className="flex items-end pb-1">
                    <GlassSwitch checked={f.bios === "ovmf" && f.efidisk} disabled={f.bios !== "ovmf"} onChange={(v) => set({ efidisk: v })} label="Add EFI vars disk" />
                  </div>
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="CPU cores">
                <GlassInput type="number" min={1} max={512} className="w-full" value={f.cores} onChange={(e) => set({ cores: Number(e.target.value) })} />
              </Field>
              {k === "qemu" ? (
                <Field label="Sockets">
                  <GlassInput type="number" min={1} max={8} className="w-full" value={f.sockets} onChange={(e) => set({ sockets: Number(e.target.value) })} />
                </Field>
              ) : (
                <Field label="Swap (MB)">
                  <GlassInput type="number" min={0} step={64} className="w-full" value={f.swap} onChange={(e) => set({ swap: Number(e.target.value) })} />
                </Field>
              )}
              <Field label="Memory (MB)" hint={bytes(f.memory * 1024 * 1024)}>
                <GlassInput type="number" min={64} step={64} className="w-full" value={f.memory} onChange={(e) => set({ memory: Number(e.target.value) })} />
              </Field>
              {k === "lxc" && (
                <div className="flex items-end pb-1">
                  <GlassSwitch checked={f.nesting} onChange={(v) => set({ nesting: v })} label="Nesting (Docker, systemd)" />
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Bridge">
                  <GlassSelect className="w-full" value={f.bridge} onChange={(e) => set({ bridge: e.target.value })}>
                    {bridges.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </GlassSelect>
                </Field>
                {k === "lxc" && (
                  <Field label="IPv4">
                    <Segmented
                      value={f.dhcp ? "dhcp" : "static"}
                      onChange={(v) => set({ dhcp: v === "dhcp" })}
                      options={[
                        { id: "dhcp", label: "DHCP" },
                        { id: "static", label: "Static" },
                      ]}
                    />
                  </Field>
                )}
                {k === "lxc" && !f.dhcp && (
                  <>
                    <Field label="Address (CIDR)">
                      <GlassInput className="w-full font-mono" placeholder="192.168.1.50/24" value={f.cidr} onChange={(e) => set({ cidr: e.target.value })} />
                    </Field>
                    <Field label="Gateway">
                      <GlassInput className="w-full font-mono" placeholder="192.168.1.1" value={f.gateway} onChange={(e) => set({ gateway: e.target.value })} />
                    </Field>
                  </>
                )}
              </div>
              {k === "qemu" ? (
                <div className="glass-soft max-h-80 overflow-auto rounded-xl p-3">
                  <GuideBanner className="mb-2" guide="compute-passthrough" text="Passing a GPU or USB device needs IOMMU turned on. See what that means and how to do it safely." />
                  <p className="mb-2 text-[11px] text-slate-400">Device passthrough (optional). Needs IOMMU on the host; devices sharing an IOMMU group move to the VM together.</p>
                  <PassthroughPicker devices={devices} hostpci={f.hostpci} usb={f.usb} onChange={(hostpci, usb) => set({ hostpci, usb })} />
                </div>
              ) : (
                <Field label="Bind-mount a ZFS dataset (optional)" hint="Mounted at /mnt/storage/<dataset> inside the container">
                  <GlassSelect className="w-full" value={f.bind} onChange={(e) => set({ bind: e.target.value })}>
                    <option value="">None</option>
                    {datasets.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </GlassSelect>
                </Field>
              )}
            </div>
          )}

          {step === 5 && (
            <dl className="glass-soft grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 rounded-xl p-4 text-xs">
              {(
                [
                  ["Type", k === "qemu" ? "Virtual machine (QEMU/KVM)" : "Unprivileged LXC container"],
                  ["ID / name", `${f.vmid} · ${f.name}`],
                  [k === "qemu" ? "ISO" : "Template", (k === "qemu" ? f.iso : f.template).split("/").pop() || "None"],
                  ...(k === "qemu" ? [["OS type", OSTYPES.find((o) => o.id === f.ostype)?.label ?? f.ostype], ["Firmware", f.bios === "ovmf" ? `UEFI${f.efidisk ? " + EFI disk" : ""}` : "SeaBIOS"]] : []),
                  ["Disk", `${f.disk} GB on ${f.storage}`],
                  ["CPU", k === "qemu" ? `${f.cores} core(s) × ${f.sockets} socket(s)` : `${f.cores} core(s)`],
                  ["Memory", `${f.memory} MB${k === "lxc" ? ` + ${f.swap} MB swap` : ""}`],
                  ["Network", `${f.bridge} · ${k === "qemu" || f.dhcp ? "DHCP" : `${f.cidr} via ${f.gateway}`}`],
                  ...(k === "qemu" ? [
                        ["PCI passthrough", f.hostpci.map((p) => `${p.id}${p.include_audio ? " (+audio)" : ""}${p.x_vga ? " primary" : ""}`).join(", ") || "None"],
                        ["USB passthrough", f.usb.map((u) => u.host + (u.usb3 ? " (USB 3)" : "")).join(", ") || "None"],
                        ["Start at boot", f.onboot ? "Yes" : "No"],
                      ] : [["Nesting", f.nesting ? "On" : "Off"], ["Bind mount", f.bind || "None"]]),
                ] as [string, string][]
              ).map(([a, b]) => (
                <div key={a} className="contents">
                  <dt className="text-slate-400">{a}</dt>
                  <dd className="truncate text-slate-100">{b}</dd>
                </div>
              ))}
            </dl>
          )}
          <Notice error={error} />
        </div>
      )}
    </GlassModal>
  );
}
