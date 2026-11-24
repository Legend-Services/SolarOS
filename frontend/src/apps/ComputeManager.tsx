import { useCallback, useEffect, useMemo, useState } from "react";
import { Container, Monitor, MonitorPlay, Play, Plus, Power, RotateCw, Search, SlidersHorizontal, Square, SquareTerminal } from "lucide-react";
import { api } from "../lib/api";
import type { Guest } from "../lib/types";
import { bytes, pct, uptime } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { GlassBadge, GlassButton, Segmented } from "../components/ui/GlassKit";
import { useCapabilities } from "../store/capabilitiesStore";
import { ViewToggle } from "../components/ViewOptions";
import { GuideBanner } from "../components/wizards/GuidedWizardModal";
import { useAppView } from "../store/layoutStore";
import { useIntent, useWindows } from "../lib/stores";
import GuestWizard, { type GuestKind } from "./GuestWizard";
import IsoLibrary from "./IsoLibrary";
import GuestDrawer from "./GuestDrawer";
import { Bar } from "../components/charts";

type Filter = "all" | "qemu" | "lxc";
type Action = "start" | "shutdown" | "stop" | "reboot";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "qemu", label: "VMs" },
  { id: "lxc", label: "Containers" },
];

export default function ComputeManager() {
  const caps = useCapabilities((s) => s.capabilities);
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Guest | null>(null);
  const [view, setView] = useState<"guests" | "iso">("guests");
  const [wizard, setWizard] = useState<GuestKind | null>(null);
  const [layout] = useAppView("compute");
  const intent = useIntent((s) => s.compute);
  const takeIntent = useIntent((s) => s.take);
  useEffect(() => {
    if (!intent) return;
    if (intent === "iso") setView("iso");
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (guests ?? []).filter(
      (g) => (filter === "all" || g.type === filter) && (!q || g.name.toLowerCase().includes(q) || String(g.vmid).includes(q)),
    );
  }, [guests, filter, query]);

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

  const actions = (g: Guest) => {
    const running = g.status === "running";
    const b = busy[`${g.type}/${g.vmid}`];
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
          ]}
        />
        <div className="ml-auto flex gap-2">
          {caps.supports_qemu && (
            <GlassButton variant="primary" onClick={() => setWizard("qemu")}>
              <Plus size={13} /> Create VM
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
      ) : (
        <>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
        <div className="flex rounded-lg bg-black/30 p-0.5" role="tablist">
          {FILTERS.filter((f) => (f.id !== "qemu" || caps.supports_qemu) && (f.id !== "lxc" || caps.supports_lxc)).map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-3 py-1 text-xs ${filter === f.id ? "bg-white/15 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto">
          <ViewToggle app="compute" />
        </span>
        <label className="relative">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <input className="input w-56 py-1.5 pl-8 text-xs" placeholder="Search name or ID" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search guests" />
        </label>
      </div>
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
                <article key={`${g.type}-${g.vmid}`} className="glass-soft flex flex-col gap-3 rounded-2xl p-4">
                  <div className="flex items-start gap-3">
                    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-white/10 ${g.type === "qemu" ? "bg-sky-400/15 text-sky-300" : "bg-violet-400/15 text-violet-300"}`}>
                      {g.type === "qemu" ? <Monitor size={18} /> : <Container size={18} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <button className="block max-w-full truncate text-sm font-semibold text-slate-100 hover:text-sky-200 hover:underline" onClick={() => setEditing(g)} title="Open guest details">
                        {g.name}
                      </button>
                      <div className="text-[11px] text-slate-500">
                        {g.vmid} · {g.type === "qemu" ? "Virtual machine" : "Container"} · {running ? `up ${uptime(g.uptime)}` : "not running"}
                      </div>
                    </div>
                    <GlassBadge tone={running ? "success" : "neutral"}>{g.status.toUpperCase()}</GlassBadge>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-400 tabular-nums">
                    <div>
                      <Bar value={cpu} />
                      <div className="mt-1">CPU {cpu.toFixed(1)}% · {g.maxcpu} vCPU</div>
                    </div>
                    <div>
                      <Bar value={pct(g.mem, g.maxmem)} className="bg-violet-400" />
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
                <tr key={`${g.type}-${g.vmid}`} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {g.type === "qemu" ? <Monitor size={15} className="text-sky-300" /> : <Container size={15} className="text-violet-300" />}
                      <div>
                        <button className="font-medium text-slate-100 hover:text-sky-200 hover:underline" onClick={() => setEditing(g)} title="Open guest details">
                          {g.name}
                        </button>
                        <div className="text-[11px] text-slate-500">
                          {g.vmid} · {g.type === "qemu" ? "VM" : "LXC"}
                        </div>
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
                    <Bar value={pct(g.mem, g.maxmem)} className="bg-violet-400" />
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
      <GuestDrawer guest={editing} onClose={() => setEditing(null)} onSaved={load} />
      <GuestWizard kind={wizard} open={!!wizard} onClose={() => setWizard(null)} onCreated={load} />
    </div>
  );
}
