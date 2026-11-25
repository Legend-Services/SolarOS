import { useCallback, useEffect, useState, type ReactNode } from "react";
import { edition } from "@edition";
import { Copy, Cpu, Download, MonitorCog, RefreshCw, Repeat } from "lucide-react";
import { api } from "../lib/api";
import { bytes, copyText, percent, tempColor } from "../lib/format";
import { usePoll, useRunner } from "../lib/hooks";
import { Bar } from "../components/charts";
import { JobLog } from "../components/JobLog";
import { ConfirmModal, GlassBadge, GlassButton, Notice } from "../components/ui/GlassKit";

/* ---------------- Types (GET /api/hardware/inventory) ---------------- */

interface GpuMetrics {
  name: string;
  driver_version: string;
  vram_total_mib: number | null;
  vram_used_mib: number | null;
  util_pct: number | null;
  temp_c: number | null;
  power_w: number | null;
}

interface Gpu {
  id: string;
  name: string;
  vendor: "nvidia" | "intel" | "amd" | "other";
  driver: string | null;
  iommu_group: number | null;
  audio_function: string | null;
  warnings: string[];
  mode: "host" | "passthrough";
  reboot_required: boolean;
  passthrough_ready: boolean;
  metrics: GpuMetrics | null;
  vram_bytes: number | null;
  firmware?: { enable_guc: string | null; guc: string | null; huc: string | null };
}

interface Inventory {
  system: Record<"manufacturer" | "product" | "board_manufacturer" | "board" | "board_version" | "bios_vendor" | "bios_version" | "bios_date" | "kernel", string | null>;
  virtualization: { cpu: string | null; iommu: boolean; cmdline: string };
  cpu: {
    model: string | null;
    sockets: number | null;
    cores: number | null;
    threads: number | null;
    max_mhz: number | null;
    mhz: { min: number; avg: number; max: number } | null;
    package_c: number | null;
    cores_c: { label: string; c: number }[];
  };
  memory: {
    total: number;
    available: number;
    used: number;
    cached: number;
    arc: number;
    swap_total: number;
    swap_used: number;
    dimms: { locator: string; bank: string; size: string | null; type: string | null; speed: string | null; configured_speed: string | null; manufacturer: string | null; part_number: string | null }[];
  };
  gpus: Gpu[];
  storage: {
    controllers: { id: string; name: string; class_name: string; driver: string | null }[];
    drives: { devpath: string; model: string; serial: string; size: number; type: string; wearout: number | string | null; health: string | null; temp_c: number | null }[];
  };
  network: { name: string; mac: string; state: string; mtu: number; master: string | null; addresses: string[]; speed_mbps: number | null; driver: string | null; physical: boolean }[];
  packages: Record<string, string | null>;
  ssh_bridge_connected: boolean;
  ssh_bridge_message: string;
  ssh_setup_command: string | null;
}

/** Bridge status; when the key isn't authorized yet, a 1-click copy of the command to paste into the host shell. */
function BridgeStatus({ inv }: { inv: Inventory }) {
  const [copied, setCopied] = useState(false);
  if (inv.ssh_bridge_connected) return <GlassBadge tone="success">SSH BRIDGE CONNECTED</GlassBadge>;
  return (
    <div className="space-y-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-400/20 ring-inset">
      <div className="flex items-center gap-2">
        <GlassBadge tone="warning">SSH BRIDGE NOT CONNECTED</GlassBadge>
        <span className="flex-1">Showing what {edition.platformApi} reports. Sensors, DIMMs, BIOS details and GPU drivers need the SSH bridge.</span>
      </div>
      <p className="font-mono text-[10px] break-all text-amber-300/80">{inv.ssh_bridge_message}</p>
      {inv.ssh_setup_command && (
        <div className="flex items-center gap-2">
          <span className="flex-1">Run this once in {edition.host} shell (as root), then click Refresh:</span>
          <GlassButton size="xs" onClick={() => copyText(inv.ssh_setup_command!).then(() => setCopied(true))}>
            <Copy size={12} /> {copied ? "Copied" : "Copy SSH Setup Command"}
          </GlassButton>
        </div>
      )}
    </div>
  );
}

type Action = "nvidia-install" | "intel-install" | "amd-install" | "mode-passthrough" | "mode-host";

const ACTIONS: Record<Action, { label: string; job: string; message: string }> = {
  "nvidia-install": {
    label: "Install / update NVIDIA driver + CUDA tools",
    job: "gpu-nvidia-install",
    message: `Installs ${edition.kernelHeaders}, blacklists nouveau, installs the latest official NVIDIA driver (DKMS) with nvidia-smi, and nvidia-container-toolkit. A reboot may be needed if nouveau is still loaded.`,
  },
  "intel-install": {
    label: "Install Intel media / Quick Sync + GuC/HuC",
    job: "gpu-intel-install",
    message: `Installs intel-media-va-driver-non-free (enabling Debian non-free if needed), intel-gpu-tools and vainfo, and sets i915.enable_guc=3. The GuC/HuC firmware comes with ${edition.firmwareSource}. Reboot afterwards.`,
  },
  "amd-install": {
    label: "Install AMD tools / ROCm",
    job: "gpu-amd-install",
    message: `Installs radeontop, plus rocminfo / rocm-smi when available. The amdgpu firmware comes with ${edition.firmwareSource}.`,
  },
  "mode-passthrough": {
    label: "Switch to VM Passthrough Mode (vfio-pci)",
    job: "gpu-mode",
    message: "Binds every function of this GPU to vfio-pci at boot, blacklists the host driver and rebuilds the initramfs. After the reboot the host (and its console) can no longer use this GPU; it can be passed through to one VM.",
  },
  "mode-host": {
    label: "Switch to Host Driver Mode",
    job: "gpu-mode",
    message: "Removes this GPU from the vfio-pci binding so the host driver (nvidia / i915 / amdgpu) claims it again after the reboot. VMs using it lose the device.",
  },
};

/* ---------------- Small layout helpers (Control Panel look) ---------------- */

function Card({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="glass-soft rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-6 gap-y-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-400">{k}</dt>
          <dd className="min-w-0 truncate text-slate-100">{v || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            {head.map((h) => (
              <th key={h} className="py-1.5 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/5">
              {r.map((c, j) => (
                <td key={j} className="py-2 pr-3 text-slate-200">
                  {c ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const C = (c: number | null | undefined) => (c == null ? "—" : <span className={tempColor(c)}>{c.toFixed(0)} °C</span>);
const driverTone = (d: string | null) => (d === "vfio-pci" ? "info" : d ? "success" : "warning");

/* ---------------- Sections ---------------- */

function CpuCard({ cpu, virt }: { cpu: Inventory["cpu"]; virt: Inventory["virtualization"] }) {
  return (
    <Card title="CPU" action={cpu.package_c != null && <span className="text-xs">Package {C(cpu.package_c)}</span>}>
      <Rows
        rows={[
          ["Model", cpu.model],
          ["Topology", cpu.cores ? `${cpu.sockets ?? 1} socket · ${cpu.cores} cores · ${cpu.threads} threads` : null],
          ["Clock", cpu.mhz ? `${cpu.mhz.min.toFixed(0)}–${cpu.mhz.max.toFixed(0)} MHz (avg ${cpu.mhz.avg}) · max ${cpu.max_mhz ?? "?"} MHz` : null],
          ["Virtualization", <span className="flex gap-1.5">
            <GlassBadge tone={virt.cpu ? "success" : "danger"}>{virt.cpu ?? "NO VT-x / AMD-V"}</GlassBadge>
            <GlassBadge tone={virt.iommu ? "success" : "warning"}>{virt.iommu ? "IOMMU ON" : "IOMMU OFF"}</GlassBadge>
          </span>],
          ["Kernel cmdline", <span className="font-mono text-[10px]">{virt.cmdline}</span>],
        ]}
      />
      {cpu.cores_c.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {cpu.cores_c.map((c) => (
            <div key={c.label} className="text-[11px]">
              <div className="flex justify-between text-slate-400">
                <span>{c.label}</span>
                {C(c.c)}
              </div>
              {/* 100 °C ≈ Tjunction max of current desktop/mobile CPUs. */}
              <Bar value={c.c} className="bg-emerald-400" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function MemoryCard({ m }: { m: Inventory["memory"] }) {
  return (
    <Card title="Memory" action={<span className="text-xs text-slate-300">{bytes(m.total)}</span>}>
      <Bar value={percent(m.used, m.total)} className="bg-violet-400" />
      <div className="mt-3">
        <Rows
          rows={[
            ["Used", `${bytes(m.used)} (${percent(m.used, m.total).toFixed(0)}%)`],
            ["Available", bytes(m.available)],
            ["Page cache", bytes(m.cached)],
            ["ZFS ARC", bytes(m.arc)],
            ["Swap", m.swap_total ? `${bytes(m.swap_used)} / ${bytes(m.swap_total)}` : "None"],
          ]}
        />
      </div>
      {m.dimms.length > 0 && (
        <div className="mt-4">
          <Table
            head={["Slot", "Size", "Type", "Speed", "Configured", "Manufacturer", "Part number"]}
            rows={m.dimms.map((d) => [<span className="font-mono">{d.locator}</span>, d.size ?? <span className="text-slate-500">Empty</span>, d.type, d.speed, d.configured_speed, d.manufacturer, d.part_number])}
          />
        </div>
      )}
    </Card>
  );
}

function GpuCard({ g, live }: { g: Gpu; live: GpuMetrics | null }) {
  const m = live ?? g.metrics;
  const vram = m?.vram_total_mib ? m.vram_total_mib * 1024 * 1024 : g.vram_bytes;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <MonitorCog size={15} /> {g.name}
        </span>
      }
      action={
        <span className="flex gap-1.5">
          <GlassBadge tone={driverTone(g.driver)}>{g.driver ?? "NO DRIVER"}</GlassBadge>
          <GlassBadge tone={g.iommu_group == null ? "warning" : "neutral"}>IOMMU {g.iommu_group ?? "—"}</GlassBadge>
        </span>
      }
    >
      <Rows
        rows={[
          ["PCI slot", <span className="font-mono">{g.id}</span>],
          ["Vendor", g.vendor.toUpperCase()],
          ["HDMI audio", g.audio_function ? <span className="font-mono">{g.audio_function}</span> : null],
          ["VRAM", vram ? bytes(vram) : g.vendor === "intel" ? "Shared system memory" : "Shown once the driver is active"],
          ["Mode", g.mode === "passthrough" ? "VM passthrough (vfio-pci)" : "Host driver"],
          ...(g.firmware ? ([["GuC / HuC", `${g.firmware.guc ?? "?"} / ${g.firmware.huc ?? "?"} (enable_guc=${g.firmware.enable_guc ?? "?"})`]] as [string, ReactNode][]) : []),
          ...(m ? ([["Driver version", m.driver_version]] as [string, ReactNode][]) : []),
        ]}
      />
      {m && (
        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
          <div>
            <div className="text-slate-400">Utilization {m.util_pct ?? "—"}%</div>
            <Bar value={m.util_pct ?? 0} />
          </div>
          <div>
            <div className="text-slate-400">
              VRAM {m.vram_used_mib ?? "—"} / {m.vram_total_mib ?? "—"} MiB
            </div>
            <Bar value={percent(m.vram_used_mib ?? 0, m.vram_total_mib ?? 0)} className="bg-violet-400" />
          </div>
          <div className="text-slate-400">Temperature {C(m.temp_c)}</div>
          <div className="text-slate-400">Power {m.power_w != null ? `${m.power_w.toFixed(0)} W` : "—"}</div>
        </div>
      )}
      {g.reboot_required && <p className="mt-3 text-[11px] text-amber-300">A reboot is required to apply the configured driver / mode.</p>}
      {g.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-[11px] text-amber-200/90">
          {g.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DriversCard({ inv, onChanged }: { inv: Inventory; onChanged: () => void }) {
  const [ask, setAsk] = useState<{ gpu: Gpu; action: Action } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const { busy, error, run } = useRunner();
  const p = inv.packages;
  const start = async () => {
    if (!ask) return;
    const ok = await run(() => api(`/hardware/gpu-drivers/${ask.action}`, { method: "POST", json: { gpu: ask.gpu.id } }));
    if (ok) (setActive(ACTIONS[ask.action].job), setAsk(null));
  };
  const done = useCallback(() => (setActive(null), onChanged()), [onChanged]);
  const actionsFor = (g: Gpu): Action[] => [
    ...(g.vendor === "nvidia" ? (["nvidia-install"] as Action[]) : g.vendor === "intel" ? (["intel-install"] as Action[]) : g.vendor === "amd" ? (["amd-install"] as Action[]) : []),
    ...(g.vendor !== "intel" ? [g.mode === "passthrough" ? ("mode-host" as Action) : ("mode-passthrough" as Action)] : []),
  ];
  const pkg = (name: string) => (p[name] ? <GlassBadge tone="success">{p[name]}</GlassBadge> : <GlassBadge>not installed</GlassBadge>);
  return (
    <Card title="GPU & Drivers">
      <div className="space-y-4">
        {inv.gpus.map((g) => (
          <div key={g.id} className="rounded-xl bg-black/20 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-slate-100">{g.name}</span>
              <span className="font-mono text-slate-500">{g.id}</span>
              <GlassBadge tone={driverTone(g.driver)}>{g.driver ?? "no driver"}</GlassBadge>
              <GlassBadge tone={g.mode === "passthrough" ? "info" : "neutral"}>{g.mode === "passthrough" ? "PASSTHROUGH MODE" : "HOST MODE"}</GlassBadge>
              {g.reboot_required && <GlassBadge tone="warning">REBOOT REQUIRED</GlassBadge>}
            </div>
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
              {g.vendor === "nvidia" && (
                <>
                  <span>Driver {g.metrics ? <GlassBadge tone="success">{g.metrics.driver_version}</GlassBadge> : <GlassBadge>not active</GlassBadge>}</span>
                  <span>Container toolkit {pkg("nvidia-container-toolkit")}</span>
                </>
              )}
              {g.vendor === "intel" && (
                <>
                  <span>Media driver {pkg("intel-media-va-driver-non-free")}</span>
                  <span>intel-gpu-tools {pkg("intel-gpu-tools")}</span>
                  <span>Firmware {pkg(edition.firmwarePackage)}</span>
                </>
              )}
              {g.vendor === "amd" && (
                <>
                  <span>Firmware {pkg(edition.firmwarePackage)}</span>
                  <span>radeontop {pkg("radeontop")}</span>
                  <span>ROCm {pkg("rocminfo")}</span>
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {actionsFor(g).map((a) => (
                <GlassButton key={a} variant={a.startsWith("mode") ? "secondary" : "primary"} disabled={busy || !!active} onClick={() => setAsk({ gpu: g, action: a })}>
                  {a.startsWith("mode") ? <Repeat size={13} /> : <Download size={13} />} {ACTIONS[a].label}
                </GlassButton>
              ))}
            </div>
          </div>
        ))}
        {(["gpu-nvidia-install", "gpu-intel-install", "gpu-amd-install", "gpu-mode"] as const).map((j) => (
          <JobLog key={j} name={j} active={active === j} onDone={done} />
        ))}
        <Notice error={error} />
      </div>
      <ConfirmModal
        open={!!ask}
        onClose={() => setAsk(null)}
        onConfirm={start}
        busy={busy}
        error={error}
        title={ask ? `${ACTIONS[ask.action].label} — ${ask.gpu.name}` : ""}
        confirmLabel="Run on host"
        message={
          ask && (
            <>
              <p>{ACTIONS[ask.action].message}</p>
              <p className="mt-2 text-amber-300">This changes kernel modules on {edition.host} and needs a host reboot to take effect.</p>
            </>
          )
        }
      />
    </Card>
  );
}

/* ---------------- Panel ---------------- */

export default function HardwarePanel() {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [live, setLive] = useState<Record<string, GpuMetrics>>({});
  const { busy, error, run } = useRunner();
  const load = useCallback(() => run(() => api<Inventory>("/hardware/inventory").then(setInv)), [run]);
  useEffect(() => {
    load();
  }, [load]);
  // Live GPU metrics only while this panel is mounted, and only if a driver reports them.
  const hasLive = !!inv?.gpus.some((g) => g.metrics || g.vram_bytes);
  const poll = useCallback(() => {
    if (hasLive) api<{ nvidia: Record<string, GpuMetrics> }>("/hardware/gpu-metrics").then((r) => setLive(r.nvidia), () => {});
  }, [hasLive]);
  usePoll(poll, 5000);

  if (!inv) return busy ? <p className="text-sm text-slate-400">Reading host hardware…</p> : <Notice error={error} />;
  const s = inv.system;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Cpu size={15} className="text-slate-400" />
        <span className="flex-1 text-xs text-slate-400">Read live from {edition.host} over the SSH bridge.</span>
        {inv.ssh_bridge_connected && <BridgeStatus inv={inv} />}
        <GlassButton size="xs" onClick={load} disabled={busy}>
          <RefreshCw size={12} /> Refresh
        </GlassButton>
      </div>
      {!inv.ssh_bridge_connected && <BridgeStatus inv={inv} />}
      <Notice error={error} />
      <Card title="System & Motherboard">
        <Rows
          rows={[
            ["System", [s.manufacturer, s.product].filter(Boolean).join(" ")],
            ["Motherboard", [s.board_manufacturer, s.board, s.board_version].filter(Boolean).join(" ")],
            ["BIOS", [s.bios_vendor, s.bios_version, s.bios_date && `(${s.bios_date})`].filter(Boolean).join(" ")],
            ["Kernel", s.kernel],
          ]}
        />
      </Card>
      <CpuCard cpu={inv.cpu} virt={inv.virtualization} />
      <MemoryCard m={inv.memory} />
      {inv.gpus.map((g) => (
        <GpuCard key={g.id} g={g} live={live[g.id] ?? null} />
      ))}
      <DriversCard inv={inv} onChanged={load} />
      <Card title="Storage">
        <Table
          head={["Controller", "PCI", "Driver"]}
          rows={inv.storage.controllers.map((c) => [c.name, <span className="font-mono">{c.id}</span>, c.driver])}
        />
        <div className="mt-4">
          <Table
            head={["Device", "Model", "Serial", "Type", "Size", "Temp", "Wearout", "Health"]}
            rows={inv.storage.drives.map((d) => [
              <span className="font-mono">{d.devpath}</span>,
              d.model,
              <span className="font-mono">{d.serial}</span>,
              d.type,
              d.size ? bytes(d.size) : null,
              C(d.temp_c),
              d.wearout != null && d.wearout !== "N/A" ? `${d.wearout}%` : null,
              d.health && <GlassBadge tone={/PASSED|OK/i.test(d.health) ? "success" : "danger"}>{d.health}</GlassBadge>,
            ])}
          />
        </div>
      </Card>
      <Card title="Network interfaces">
        <Table
          head={["Name", "Kind", "State", "Speed", "Driver", "MAC", "Addresses"]}
          rows={inv.network.map((n) => [
            <span className="font-mono">{n.name}</span>,
            n.physical ? "Physical" : n.master ? `Virtual → ${n.master}` : "Virtual",
            <GlassBadge tone={n.state === "UP" ? "success" : n.state === "DOWN" ? "danger" : "neutral"}>{n.state}</GlassBadge>,
            n.speed_mbps ? (n.speed_mbps >= 1000 ? `${n.speed_mbps / 1000} Gb/s` : `${n.speed_mbps} Mb/s`) : null,
            n.driver,
            <span className="font-mono">{n.mac}</span>,
            <span className="font-mono">{n.addresses.join(", ") || "—"}</span>,
          ])}
        />
      </Card>
    </div>
  );
}
