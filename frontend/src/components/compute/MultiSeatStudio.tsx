import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cable, Cpu, Lock, MonitorUp, Play, Plus, Power, RefreshCw, Scale, Trash2, Usb, X, Zap } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation } from "../../i18n";
import GuestWizard from "../../apps/GuestWizard";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassCheckbox, GlassInput, GlassSelect, Notice } from "../ui/GlassKit";

/* Shapes of /api/multiseat (backend/app/multiseat.py). */
interface Gpu {
  slot: string;
  name: string;
  driver: string | null;
  boot_vga: boolean;
  external: boolean;
  audio_function: string | null;
  connectors: { name: string; status: string }[];
  passthrough_ready: boolean;
  seat_id: string | null;
}
interface Controller {
  slot: string;
  name: string;
  buses: number[];
  seat_id: string | null;
}
interface UsbDev {
  port: string;
  name: string;
  manufacturer: string;
  hub: boolean;
  seat_id: string | null;
}
interface Topology {
  gpus: Gpu[];
  usb_controllers: Controller[];
  usb_devices: UsbDev[];
  thunderbolt: { id: string; authorized: boolean; vendor: string; name: string }[];
  iommu_enabled: boolean;
  cpu: { cores: { socket: number; core: number; threads: number[] }[]; threads: number; reserved: number[] };
}
interface Seat {
  seat_id: string;
  name: string;
  vm_id: number | null;
  vm_name: string | null;
  enabled: boolean;
  status: string;
  gpu_pci_slot: string | null;
  gpu_audio_pci_slot: string | null;
  extra_pci_slots: string[];
  usb_ports: string[];
  usb_names: Record<string, string>;
  usb_controller_pci_slots: string[];
  cpu_cores: number[];
}
interface Listen {
  session_id: string;
  status: "listening" | "detected" | "timeout" | "hub_only" | "error";
  remaining: number;
  bound: string[];
  skipped: string[];
  error?: string;
  warning?: string;
}

const EDITABLE = ["name", "vm_id", "enabled", "gpu_pci_slot", "gpu_audio_pci_slot", "extra_pci_slots", "usb_ports", "usb_names", "usb_controller_pci_slots", "cpu_cores"] as const;
const body = (s: Seat) => Object.fromEntries(EDITABLE.map((k) => [k, s[k]]));
const short = (slot: string) => slot.replace(/^0000:/, "");

function SeatCard({ seat, seats, topo, vms, onChanged, onNewVm }: { seat: Seat; seats: Seat[]; topo: Topology | null; vms: Guest[]; onChanged: () => void; onNewVm: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(seat);
  const [listen, setListen] = useState<Listen | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, error, notice, run } = useRunner(onChanged);
  const dirty = JSON.stringify(body(draft)) !== JSON.stringify(body(seat));
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    // Keep local edits; take over what the server changed (Plug to Assign, auto-balance, power state).
    setDraft((d) => (JSON.stringify(body(d)) === JSON.stringify(body(seat)) ? seat : { ...d, status: seat.status, usb_ports: seat.usb_ports, usb_names: seat.usb_names, cpu_cores: seat.cpu_cores }));
  }, [seat]);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  const set = (patch: Partial<Seat>) => setDraft((d) => ({ ...d, ...patch }));

  const others = seats.filter((s) => s.seat_id !== seat.seat_id);
  const otherOwner = (pred: (s: Seat) => boolean) => others.find(pred)?.name;
  const gpu = topo?.gpus.find((g) => g.slot === draft.gpu_pci_slot);
  const running = seat.status === "running";

  const save = () => run(() => api(`/multiseat/seats/${seat.seat_id}`, { method: "PUT", json: body(draft) }), t("seat.saved"));
  const power = (action: "start" | "stop") => run(() => api(`/multiseat/seats/${seat.seat_id}/${action}`, { method: "POST" }), action === "start" ? t("seat.starting") : t("seat.stopping"));
  const remove = () => run(() => api(`/multiseat/seats/${seat.seat_id}`, { method: "DELETE" }).then(() => setConfirmDelete(false)));
  const plug = () =>
    run(async () => {
      if (dirty) await api(`/multiseat/seats/${seat.seat_id}`, { method: "PUT", json: body(draft) });
      const s = await api<Listen>("/multiseat/usb/listen", { method: "POST", json: { seat_id: seat.seat_id } });
      setListen({ ...s, remaining: 30 });
      timer.current = setInterval(async () => {
        try {
          const r = await api<Listen>(`/multiseat/usb/listen/${s.session_id}`);
          setListen(r);
          if (r.status !== "listening") {
            if (timer.current) clearInterval(timer.current);
            onChanged();
          }
        } catch {
          if (timer.current) clearInterval(timer.current);
          setListen(null);
        }
      }, 500);
    });
  const pickGpu = (slot: string) => {
    const g = topo?.gpus.find((x) => x.slot === slot);
    set({ gpu_pci_slot: slot || null, gpu_audio_pci_slot: g?.audio_function ?? null });
  };
  const toggleCore = (threads: number[]) => {
    const mine = threads.every((x) => draft.cpu_cores.includes(x));
    set({ cpu_cores: mine ? draft.cpu_cores.filter((x) => !threads.includes(x)) : [...new Set([...draft.cpu_cores, ...threads])].sort((a, b) => a - b) });
  };
  const usedVms = new Set(others.map((s) => s.vm_id));
  const free = topo?.usb_devices.filter((u) => !u.hub && !u.seat_id && !draft.usb_ports.includes(u.port)) ?? [];

  return (
    <article className="glass-soft flex flex-col gap-4 rounded-2xl p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-400/15 text-sky-300 ring-1 ring-white/10">
          <MonitorUp size={17} />
        </span>
        <GlassInput className="min-w-0 flex-1 text-sm font-semibold" value={draft.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} aria-label={t("seat.name")} />
        <GlassBadge tone={running ? "success" : seat.status === "missing" ? "danger" : "neutral"}>
          {running ? t("seat.running") : seat.status === "missing" ? t("seat.vmMissing") : seat.status === "unassigned" ? t("seat.noVm") : t("seat.stopped")}
        </GlassBadge>
      </header>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label={t("seat.targetVm")}>
          <GlassSelect value={draft.vm_id ?? ""} onChange={(e) => set({ vm_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t("seat.pickVm")}</option>
            {vms.filter((v) => !usedVms.has(v.vmid)).map((v) => (
              <option key={v.vmid} value={v.vmid}>
                {v.vmid} · {v.name}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <GlassButton onClick={onNewVm}>
          <Plus size={13} /> {t("seat.newVm")}
        </GlassButton>
      </div>

      {/* Display & GPU output */}
      <section className="flex flex-col gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
          <MonitorUp size={13} /> {t("seat.gpuSlot")}
        </h4>
        <GlassSelect value={draft.gpu_pci_slot ?? ""} onChange={(e) => pickGpu(e.target.value)} aria-label={t("seat.gpuSlot")}>
          <option value="">{t("seat.noGpu")}</option>
          {topo?.gpus.map((g) => {
            const owner = otherOwner((s) => s.gpu_pci_slot === g.slot);
            return (
              <option key={g.slot} value={g.slot} disabled={!!owner}>
                {g.name} · {short(g.slot)}
                {g.boot_vga ? ` · ${t("seat.bootGpu")}` : ""}
                {g.external ? ` · ${t("seat.egpu")}` : ""}
                {owner ? ` · ${owner}` : ""}
              </option>
            );
          })}
        </GlassSelect>
        {gpu && (
          <div className="flex flex-wrap gap-1.5">
            {gpu.boot_vga && <GlassBadge tone="warning">{t("seat.bootGpu")}</GlassBadge>}
            {gpu.connectors.map((c) => (
              <GlassBadge key={c.name} tone={c.status === "connected" ? "success" : "neutral"}>
                {c.name}: {c.status === "connected" ? t("seat.connected") : t("seat.ready")}
              </GlassBadge>
            ))}
            {draft.gpu_audio_pci_slot && <GlassBadge tone="info">{t("seat.gpuAudio")}</GlassBadge>}
            {!gpu.passthrough_ready && <GlassBadge tone="danger">{t("seat.iommuShared")}</GlassBadge>}
          </div>
        )}
        {gpu?.boot_vga && <p className="text-[11px] text-amber-200/90">{t("seat.bootGpuNotice")}</p>}
      </section>

      {/* Physical USB ports & hubs */}
      <section className="flex flex-col gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
          <Usb size={13} /> {t("seat.usbSlot")}
        </h4>
        {draft.usb_ports.length === 0 && draft.usb_controller_pci_slots.length === 0 && <p className="text-[11px] text-slate-500">{t("seat.noUsb")}</p>}
        <ul className="flex flex-col gap-1">
          {draft.usb_ports.map((p) => (
            <li key={p} className="flex items-center gap-2 rounded-lg bg-black/20 px-2.5 py-1.5 text-xs">
              <Cable size={12} className="text-sky-300" />
              <span className="flex-1 truncate">{t("seat.portLabel", { port: p, name: draft.usb_names[p] || topo?.usb_devices.find((u) => u.port === p)?.name || t("seat.emptyPort") })}</span>
              <button className="text-slate-400 hover:text-rose-300" onClick={() => set({ usb_ports: draft.usb_ports.filter((x) => x !== p) })} aria-label={t("common.delete")}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
        {listen?.status === "listening" ? (
          <div className="rounded-xl bg-sky-400/10 p-3 text-xs text-sky-100 ring-1 ring-sky-300/30" role="status">
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <span className="h-2 w-2 animate-ping rounded-full bg-sky-300" /> {t("seat.listening", { s: listen.remaining })}
            </div>
            {t("seat.plugPrompt")}
          </div>
        ) : (
          <GlassButton variant="primary" className="shadow-[0_0_18px_rgba(56,189,248,0.45)]" disabled={busy} onClick={plug}>
            <Zap size={13} /> {t("seat.plug")}
          </GlassButton>
        )}
        {listen && listen.status !== "listening" && (
          <p className={`text-[11px] ${listen.status === "detected" ? "text-emerald-300" : "text-amber-200"}`}>
            {listen.status === "detected"
              ? t("seat.detected", { ports: listen.bound.join(", ") || "—" }) + (listen.skipped.length ? ` ${t("seat.skipped", { ports: listen.skipped.join(", ") })}` : "")
              : listen.status === "hub_only"
                ? t("seat.hubOnly")
                : listen.status === "timeout"
                  ? t("seat.timeout")
                  : listen.error}
            {listen.warning ? ` ${listen.warning}` : ""}
          </p>
        )}
        {free.length > 0 && (
          <GlassSelect value="" onChange={(e) => e.target.value && set({ usb_ports: [...draft.usb_ports, e.target.value], usb_names: { ...draft.usb_names, [e.target.value]: free.find((u) => u.port === e.target.value)?.name ?? "" } })} aria-label={t("seat.addPort")}>
            <option value="">{t("seat.addPort")}</option>
            {free.map((u) => (
              <option key={u.port} value={u.port}>
                {t("seat.portLabel", { port: u.port, name: u.name })}
              </option>
            ))}
          </GlassSelect>
        )}
        {topo && topo.usb_controllers.length > 0 && (
          <div className="flex flex-col gap-1 pt-1">
            {topo.usb_controllers.map((c) => {
              const owner = otherOwner((s) => s.usb_controller_pci_slots.includes(c.slot));
              const on = draft.usb_controller_pci_slots.includes(c.slot);
              return (
                <GlassCheckbox
                  key={c.slot}
                  checked={on}
                  onChange={(v) => !owner && set({ usb_controller_pci_slots: v ? [...draft.usb_controller_pci_slots, c.slot] : draft.usb_controller_pci_slots.filter((x) => x !== c.slot) })}
                  label={<span className="text-[11px]">{t("seat.controller", { name: c.name, slot: short(c.slot), buses: c.buses.join(", ") || "—" })}{owner ? ` · ${owner}` : ""}</span>}
                />
              );
            })}
            <p className="text-[10px] text-slate-500">{t("seat.controllerHint")}</p>
          </div>
        )}
      </section>

      {/* CPU core pinning map */}
      <section className="flex flex-col gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
          <Cpu size={13} /> {t("seat.cpuMap")} <span className="font-normal text-slate-500">{t("seat.threadsPicked", { n: draft.cpu_cores.length })}</span>
        </h4>
        <div className="flex flex-wrap gap-1">
          {topo?.cpu.cores.map((c) => {
            const reserved = c.threads.some((x) => topo.cpu.reserved.includes(x));
            const owner = otherOwner((s) => c.threads.some((x) => s.cpu_cores.includes(x)));
            const mine = c.threads.every((x) => draft.cpu_cores.includes(x));
            return (
              <button
                key={`${c.socket}-${c.core}`}
                disabled={reserved || !!owner}
                onClick={() => toggleCore(c.threads)}
                title={reserved ? t("seat.reserved") : owner ?? c.threads.join(" + ")}
                className={`flex min-w-[3.25rem] items-center justify-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] tabular-nums ring-1 ring-inset transition ${
                  reserved ? "bg-amber-400/10 text-amber-200/70 ring-amber-300/20" : owner ? "bg-white/[0.03] text-slate-600 ring-white/5" : mine ? "bg-sky-400/25 text-sky-100 ring-sky-300/40" : "bg-black/20 text-slate-400 ring-white/10 hover:bg-white/10"
                }`}
              >
                {reserved && <Lock size={9} />}
                {c.threads.join("·")}
              </button>
            );
          })}
        </div>
      </section>

      <Notice error={error} notice={notice} />
      <footer className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
        <GlassCheckbox checked={draft.enabled} onChange={(v) => set({ enabled: v })} label={<span className="text-[11px]">{t("seat.inStartAll")}</span>} />
        <span className="ml-auto flex gap-2">
          <GlassButton variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={t("seat.delete")}>
            <Trash2 size={13} />
          </GlassButton>
          {dirty && (
            <GlassButton variant="primary" disabled={busy} onClick={save}>
              {t("common.save")}
            </GlassButton>
          )}
          {running ? (
            <GlassButton disabled={busy} onClick={() => power("stop")}>
              <Power size={13} /> {t("seat.stop")}
            </GlassButton>
          ) : (
            <GlassButton variant="primary" disabled={busy || dirty || !seat.vm_id || seat.status === "missing"} onClick={() => power("start")}>
              <Play size={13} /> {t("seat.start")}
            </GlassButton>
          )}
        </span>
      </footer>
      <ConfirmModal open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} busy={busy} error={error} title={t("seat.delete")} message={t("seat.deleteMsg", { name: seat.name })} confirmLabel={t("common.delete")} />
    </article>
  );
}

/** Multi-Seat & Physical Ports studio: one card per seat (VM + GPU + USB ports + CPU threads). */
export default function MultiSeatStudio() {
  const { t } = useTranslation();
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [topo, setTopo] = useState<Topology | null>(null);
  const [vms, setVms] = useState<Guest[]>([]);
  const [wizard, setWizard] = useState(false);
  const { busy, error, notice, run } = useRunner();
  const [loadError, setLoadError] = useState("");

  const loadSeats = useCallback(() => {
    api<{ seats: Seat[] }>("/multiseat/seats").then((r) => setSeats(r.seats), (e) => setLoadError(e.message));
    api<Guest[]>("/v1/guests").then((g) => setVms(g.filter((x) => x.type === "qemu")), () => undefined);
  }, []);
  const loadTopo = useCallback(() => {
    api<Topology>("/multiseat/topology").then((r) => (setTopo(r), setLoadError("")), (e) => setLoadError(e.message));
  }, []);
  const reload = useCallback(() => (loadSeats(), loadTopo()), [loadSeats, loadTopo]);
  useEffect(() => {
    reload();
    const id = setInterval(loadSeats, 5000);
    return () => clearInterval(id);
  }, [reload, loadSeats]);

  const create = () => run(() => api("/multiseat/seats", { method: "POST", json: { name: t("seat.defaultName", { n: (seats?.length ?? 0) + 1 }) } }).then(reload));
  const balance = () =>
    run(async () => {
      const r = await api<{ errors: string[] }>("/multiseat/seats/auto-balance", { method: "POST", json: {} });
      reload();
      if (r.errors.length) throw new Error(r.errors.join("; "));
    }, t("seat.balanced"));
  const startAll = () =>
    run(async () => {
      const r = await api<{ results: { status: string; error?: string }[] }>("/multiseat/seats/start-all", { method: "POST" });
      loadSeats();
      const bad = r.results.filter((x) => x.status === "error").map((x) => x.error);
      if (bad.length) throw new Error(bad.join("; "));
    }, t("seat.startedAll"));
  const authorize = (id: string) => run(() => api("/multiseat/egpu/authorize", { method: "POST", json: { device: id } }).then(loadTopo), t("seat.egpuAuthorized"));
  const pending = useMemo(() => topo?.thunderbolt.filter((d) => !d.authorized) ?? [], [topo]);

  return (
    <div className="flex flex-col gap-4 p-1">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-100">{t("seat.title")}</h3>
          <p className="max-w-3xl text-xs text-slate-400">{t("seat.intro")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <GlassButton onClick={reload} aria-label={t("common.refresh")}>
            <RefreshCw size={13} />
          </GlassButton>
          <GlassButton disabled={busy || !seats?.length} onClick={balance}>
            <Scale size={13} /> {t("seat.autoBalance")}
          </GlassButton>
          <GlassButton variant="primary" disabled={busy || !seats?.some((s) => s.enabled && s.vm_id)} onClick={startAll}>
            <Play size={13} /> {t("seat.startAll")}
          </GlassButton>
        </div>
      </div>
      <Notice error={error || loadError} notice={notice} />
      {topo && !topo.iommu_enabled && <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-300/25">{t("seat.iommuOff")}</p>}
      {pending.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-sky-400/10 px-3 py-2 text-xs text-sky-100 ring-1 ring-sky-300/25">
          <span className="flex-1">{t("seat.egpuPending", { name: [d.vendor, d.name].filter(Boolean).join(" ") || d.id })}</span>
          <GlassButton size="xs" variant="primary" disabled={busy} onClick={() => authorize(d.id)}>
            {t("seat.egpuAuthorize")}
          </GlassButton>
        </div>
      ))}
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {seats === null && <p className="text-sm text-slate-400">{t("common.loading")}</p>}
        {seats?.map((s) => <SeatCard key={s.seat_id} seat={s} seats={seats} topo={topo} vms={vms} onChanged={reload} onNewVm={() => setWizard(true)} />)}
        {seats && (
          <button onClick={create} disabled={busy} className="flex min-h-[12rem] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 text-sm text-slate-400 transition hover:border-sky-300/40 hover:bg-white/[0.03] hover:text-sky-200">
            <Plus size={22} /> {t("seat.create")}
          </button>
        )}
      </div>
      <GuestWizard kind="qemu" open={wizard} onClose={() => setWizard(false)} onCreated={reload} />
    </div>
  );
}
