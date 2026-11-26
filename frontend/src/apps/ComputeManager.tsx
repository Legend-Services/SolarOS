import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Container, FlaskConical, Monitor, MonitorPlay, Play, Plus, Power, RotateCw, Search, Server, ShieldCheck, SlidersHorizontal, Square, SquareTerminal, Wand2 } from "lucide-react";
import { api } from "../lib/api";
import type { Guest } from "../lib/types";
import { bytes, percent, uptime } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { GlassBadge, GlassButton, GlassModal, Segmented } from "../components/ui/GlassKit";
import LabSandboxPanel from "../components/compute/LabSandbox";
import MultiSeatStudio from "../components/compute/MultiSeatStudio";
import ImageHubPanel from "../components/compute/ImageHubPanel";
import DockerEnginePanel from "../components/compute/DockerEnginePanel";
import { useFeatureEnabled } from "../store/featureStore";
import ZeroTouchWizard from "../components/compute/ZeroTouchWizard";
import { SecurityModuleHeader } from "../components/ui/SecurityModuleHeader";
import { HaModal, MigrateModal, type Workload } from "../components/cluster/ClusterDialogs";
import { useTranslation } from "../i18n";
import { useCapabilities } from "../store/capabilitiesStore";
import { ViewToggle } from "../components/ViewOptions";
import { GuideBanner } from "../components/wizards/GuidedWizardModal";
import { useAppView } from "../store/layoutStore";
import { useIntent, useWindows } from "../lib/stores";
import GuestWizard, { type GuestKind } from "./GuestWizard";
import IsoLibrary from "./IsoLibrary";
import GuestDrawer from "./GuestDrawer";
import { Bar } from "../components/charts";

type Filter = "all" | "qemu" | "lxc" | "seats";
type Action = "start" | "shutdown" | "stop" | "reboot";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "qemu", label: "VMs" },
  { id: "lxc", label: "Containers" },
  { id: "seats", label: "" }, // label: t("seat.tab")
];

export default function ComputeManager() {
  const caps = useCapabilities((s) => s.capabilities);
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Guest | null>(null);
  const [view, setView] = useState<"guests" | "iso" | "images" | "docker">("guests");
  const docker = useFeatureEnabled("docker_engine");
  const [wizard, setWizard] = useState<GuestKind | null>(null);
  const [labs, setLabs] = useState(false);
  const [zeroTouch, setZeroTouch] = useState(false);
  const [cluster, setCluster] = useState<{ mode: string; self: string; workloads: Workload[] } | null>(null);
  const [hostFilter, setHostFilter] = useState("all");
  const [migrating, setMigrating] = useState<Workload | null>(null);
  const [haFor, setHaFor] = useState<Workload | null>(null);
  const { t } = useTranslation();
  const [layout] = useAppView("compute");
  const intent = useIntent((s) => s.compute);
  const takeIntent = useIntent((s) => s.take);
  useEffect(() => {
    if (!intent) return;
    if (intent === "iso" || intent === "docker") setView(intent);
    else setWizard(intent === "vm" ? "qemu" : "lxc");
    takeIntent("compute");
  }, [intent, takeIntent]);
  const openWindow = useWindows((s) => s.open);
  const openConsole = (g: Guest, mode: "vnc" | "shell") => openWindow("console", { type: g.type, vmid: g.vmid, name: g.name, mode });

  const load = useCallback(() => {
    api<Guest[]>("/v1/guests")
      .then((g) => {
        setGuests(g);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, []);
  usePoll(load, 3000);
  const loadCluster = useCallback(() => {
    api<{ mode: string; self: string; workloads: Workload[] }>("/cluster/workloads").then(setCluster, () => setCluster(null));
  }, []);
  usePoll(loadCluster, 5000);
  const clustered = cluster?.mode === "cluster";
  // In a cluster, guests of the other hosts join the list (managed through migration and HA from here).
  const all = useMemo<Workload[]>(() => {
    const local = (guests ?? []).map((g) => ({ ...g, host: cluster?.self ?? "" }));
    if (!clustered || !cluster) return local;
    const ha = new Set(cluster.workloads.filter((w) => w.ha).map((w) => `${w.type}:${w.vmid}`));
    return [...local, ...cluster.workloads.filter((w) => w.host !== cluster.self)].map((g) => ({ ...g, ha: ha.has(`${g.type}:${g.vmid}`) }));
  }, [guests, cluster, clustered]);
  const hostNames = useMemo(() => [...new Set(all.map((g) => g.host))].sort(), [all]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (g) =>
        (filter === "all" || g.type === filter) &&
        (hostFilter === "all" || g.host === hostFilter) &&
        (!q || g.name.toLowerCase().includes(q) || String(g.vmid).includes(q)),
    );
  }, [all, filter, query, hostFilter]);

  const run = async (g: Guest, action: Action) => {
    if (action === "stop" && !window.confirm(`Force stop ${g.name} (${g.vmid})? Unsaved data in the guest may be lost.`)) return;
    const key = `${g.type}/${g.vmid}`;
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      await api(`/v1/guests/${g.type}/${g.vmid}/action`, { method: "POST", json: { action } });
      setTimeout(load, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  const clusterActions = (g: Workload) =>
    clustered && (
      <>
        <button className="btn" onClick={() => setMigrating(g)} title={t("cl.migrateTo")}>
          <ArrowRightLeft size={12} /> {t("cl.migrateTo")}
        </button>
        <button className={`btn ${g.ha ? "text-emerald-300" : ""}`} onClick={() => setHaFor(g)} title={t("cl.haTab")}>
          <ShieldCheck size={12} /> {t("cl.haShort")}
        </button>
      </>
    );

  const actions = (g: Workload) => {
    const running = g.status === "running";
    const b = busy[`${g.type}/${g.vmid}`];
    if (clustered && g.host !== cluster?.self) return clusterActions(g);
    return (
      <>
        <button className="btn" disabled={!running} onClick={() => openConsole(g, "vnc")} title="Graphical console (noVNC)">
          <MonitorPlay size={12} /> Console
        </button>
        <button
          className="btn"
          disabled={!running}
          onClick={() => openConsole(g, "shell")}
          title={g.type === "lxc" ? "Container shell" : "Serial terminal (needs serial0 on the VM)"}
        >
          <SquareTerminal size={12} /> Shell
        </button>
        <button className="btn" onClick={() => setEditing(g)} title="Hardware, network, cloud-init, snapshots and options">
          <SlidersHorizontal size={12} /> Edit
        </button>
        <button className="btn" disabled={b || running} onClick={() => run(g, "start")} title="Start">
          <Play size={12} /> Start
        </button>
        <button className="btn" disabled={b || !running} onClick={() => run(g, "shutdown")} title="Graceful shutdown">
          <Power size={12} /> Shutdown
        </button>
        <button className="btn" disabled={b || !running} onClick={() => run(g, "reboot")} title="Reboot">
          <RotateCw size={12} />
        </button>
        <button className="btn text-rose-300" disabled={b || !running} onClick={() => run(g, "stop")} title="Force stop">
          <Square size={12} /> Force Stop
        </button>
        {clusterActions(g)}
      </>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { id: "guests", label: "Guests" },
            { id: "iso", label: "ISO & Templates" },
            { id: "images", label: t("ih.tab") },
            ...(docker ? [{ id: "docker" as const, label: t("dk.tab") }] : []),
          ]}
        />
        <div className="ml-auto flex gap-2">
          <GlassButton onClick={() => setLabs(true)}>
            <FlaskConical size={13} /> {t("lab.title")}
          </GlassButton>
          {caps.supports_qemu && (
            <GlassButton variant="primary" onClick={() => setWizard("qemu")}>
              <Plus size={13} /> Create VM
            </GlassButton>
          )}
          {caps.supports_qemu && (
            <GlassButton onClick={() => setZeroTouch(true)}>
              <Wand2 size={13} /> {t("zt.create")}
            </GlassButton>
          )}
          {caps.supports_lxc && (
            <GlassButton onClick={() => setWizard("lxc")}>
              <Plus size={13} /> Create Container
            </GlassButton>
          )}
        </div>
      </div>
      {view === "iso" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <IsoLibrary />
        </div>
      ) : view === "docker" && docker ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <SecurityModuleHeader module="docker_engine">{() => <DockerEnginePanel />}</SecurityModuleHeader>
        </div>
      ) : view === "images" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <SecurityModuleHeader module="image_hub" compact>
            {() => <ImageHubPanel />}
          </SecurityModuleHeader>
        </div>
      ) : (
        <>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
        <div className="flex rounded-lg bg-black/30 p-0.5" role="tablist">
          {FILTERS.filter((f) => (f.id === "lxc" ? caps.supports_lxc : f.id === "all" || caps.supports_qemu)).map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-3 py-1 text-xs ${filter === f.id ? "bg-white/15 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              {f.id === "seats" ? t("seat.tab") : f.label}
            </button>
          ))}
        </div>
        {filter !== "seats" && (
          <>
        <span className="ml-auto">
          <ViewToggle app="compute" />
        </span>
        <label className="relative">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <input className="input w-56 py-1.5 pl-8 text-xs" placeholder="Search name or ID" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search guests" />
        </label>
          </>
        )}
      </div>
      {clustered && filter !== "seats" && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-2" role="tablist" aria-label={t("cl.hostFilter")}>
          <Server size={13} className="text-slate-400" />
          {["all", ...hostNames].map((h) => (
            <button
              key={h}
              role="tab"
              aria-selected={hostFilter === h}
              onClick={() => setHostFilter(h)}
              className={`rounded-full px-3 py-0.5 text-[11px] ring-1 ring-inset ${hostFilter === h ? "bg-sky-400/20 text-white ring-sky-300/40" : "text-slate-400 ring-white/10 hover:text-slate-200"}`}
            >
              {h === "all" ? t("cl.allHosts") : h}
            </button>
          ))}
        </div>
      )}
      {filter === "seats" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <MultiSeatStudio />
        </div>
      ) : (
        <>
      {error && <div className="bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>}

      {guests?.length === 0 && (
        <div className="px-3 pt-3">
          <GuideBanner guide="compute-vm-vs-ct" text="No machines yet. Not sure whether you need a VM or a container? We'll explain and walk you through creating one." />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {layout === "grid" ? (
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {guests === null && <p className="text-sm text-slate-400">Loading…</p>}
            {guests && shown.length === 0 && <p className="text-sm text-slate-400">No guests match.</p>}
            {shown.map((g) => {
              const running = g.status === "running";
              const cpu = g.cpu * 100;
              return (
                <article key={`${g.host}-${g.type}-${g.vmid}`} className="glass-soft flex flex-col gap-3 rounded-2xl p-4">
                  <div className="flex items-start gap-3">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-white/10 ${g.type === "qemu" ? "bg-sky-400/15 text-sky-300" : "bg-violet-400/15 text-violet-300"}`}>
                      {g.type === "qemu" ? <Monitor size={18} /> : <Container size={18} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <button className="block max-w-full truncate text-sm font-semibold text-slate-100 hover:text-sky-200 hover:underline" onClick={() => (clustered && g.host !== cluster?.self ? setHaFor(g) : setEditing(g))} title="Open guest details">
                        {g.name}
                      </button>
                      <div className="text-[11px] text-slate-500">
                        {g.vmid} · {g.type === "qemu" ? "Virtual machine" : "Container"} · {running ? `up ${uptime(g.uptime)}` : "not running"}
                      </div>
                      {clustered && <HostBadge host={g.host} ha={g.ha} />}
                    </div>
                    <GlassBadge tone={running ? "success" : "neutral"}>{g.status.toUpperCase()}</GlassBadge>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-400 tabular-nums">
                    <div>
                      <Bar value={cpu} />
                      <div className="mt-1">CPU {cpu.toFixed(1)}% · {g.maxcpu} vCPU</div>
                    </div>
                    <div>
                      <Bar value={percent(g.mem, g.maxmem)} className="bg-violet-400" />
                      <div className="mt-1">
                        {bytes(g.mem)} / {bytes(g.maxmem)}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">{actions(g)}</div>
                </article>
              );
            })}
          </div>
        ) : (
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="sticky top-0 bg-slate-900/90 text-slate-400 backdrop-blur">
            <tr>
              <th className="px-4 py-2 font-medium">Guest</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="w-36 px-2 py-2 font-medium">CPU</th>
              <th className="w-40 px-2 py-2 font-medium">Memory</th>
              <th className="px-2 py-2 font-medium">Uptime</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {guests === null && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {guests && shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  No guests match.
                </td>
              </tr>
            )}
            {shown.map((g) => {
              const running = g.status === "running";
              const cpu = g.cpu * 100;
              return (
                <tr key={`${g.host}-${g.type}-${g.vmid}`} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {g.type === "qemu" ? <Monitor size={15} className="text-sky-300" /> : <Container size={15} className="text-violet-300" />}
                      <div>
                        <button className="font-medium text-slate-100 hover:text-sky-200 hover:underline" onClick={() => (clustered && g.host !== cluster?.self ? setHaFor(g) : setEditing(g))} title="Open guest details">
                          {g.name}
                        </button>
                        <div className="text-[11px] text-slate-500">
                          {g.vmid} · {g.type === "qemu" ? "VM" : "LXC"}
                        </div>
                        {clustered && <HostBadge host={g.host} ha={g.ha} />}
                      </div>
                    </div>
                  </td>
                  <td className="px-2">
                    <span className={`inline-flex items-center gap-1.5 ${running ? "text-emerald-300" : "text-slate-400"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-400" : "bg-slate-500"}`} />
                      {g.status}
                    </span>
                  </td>
                  <td className="px-2">
                    <Bar value={cpu} />
                    <div className="mt-1 text-[11px] text-slate-400 tabular-nums">
                      {cpu.toFixed(1)}% of {g.maxcpu} vCPU
                    </div>
                  </td>
                  <td className="px-2">
                    <Bar value={percent(g.mem, g.maxmem)} className="bg-violet-400" />
                    <div className="mt-1 text-[11px] text-slate-400 tabular-nums">
                      {bytes(g.mem)} / {bytes(g.maxmem)}
                    </div>
                  </td>
                  <td className="px-2 text-slate-300 tabular-nums">{running ? uptime(g.uptime) : "—"}</td>
                  <td className="px-4">
                    <div className="flex justify-end gap-1">{actions(g)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </div>
        </>
      )}
        </>
      )}
      <GuestDrawer guest={editing} onClose={() => setEditing(null)} onSaved={load} clustered={clustered} />
      <MigrateModal guest={migrating} onClose={() => (setMigrating(null), load(), loadCluster())} />
      <HaModal guest={haFor} onClose={() => (setHaFor(null), loadCluster())} />
      <GuestWizard kind={wizard} open={!!wizard} onClose={() => setWizard(null)} onCreated={load} />
      <ZeroTouchWizard open={zeroTouch} onClose={() => setZeroTouch(false)} onCreated={load} />
      <GlassModal open={labs} onClose={() => (setLabs(false), load())} width="max-w-3xl" title={t("lab.title")}>
        <LabSandboxPanel />
      </GlassModal>
    </div>
  );
}

/** Active host of a workload in cluster mode, with its HA state. */
function HostBadge({ host, ha }: { host: string; ha?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mt-0.5 flex items-center gap-1">
      <GlassBadge tone="info">
        <Server size={9} /> {host}
      </GlassBadge>
      {ha && <GlassBadge tone="success">{t("cl.haShort")}</GlassBadge>}
    </div>
  );
}
