import { useCallback, useMemo, useState } from "react";
import { Container, Monitor, MonitorPlay, Play, Power, RotateCw, Search, Square, SquareTerminal } from "lucide-react";
import { api } from "../lib/api";
import type { Guest } from "../lib/types";
import { bytes, pct, uptime } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { useWindows } from "../lib/stores";
import { Bar } from "../components/charts";

type Filter = "all" | "qemu" | "lxc";
type Action = "start" | "shutdown" | "stop" | "reboot";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "qemu", label: "VMs" },
  { id: "lxc", label: "Containers" },
];

export default function ComputeManager() {
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const openWindow = useWindows((s) => s.open);
  const openConsole = (g: Guest, mode: "vnc" | "shell") => openWindow("console", { type: g.type, vmid: g.vmid, name: g.name, mode });

  const load = useCallback(() => {
    api<Guest[]>("/pve/guests")
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
      await api(`/pve/guests/${g.type}/${g.vmid}/action`, { method: "POST", json: { action } });
      setTimeout(load, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
        <div className="flex rounded-lg bg-black/30 p-0.5" role="tablist">
          {FILTERS.map((f) => (
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
        <label className="relative ml-auto">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <input className="input w-56 py-1.5 pl-8 text-xs" placeholder="Search name or ID" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search guests" />
        </label>
      </div>
      {error && <div className="bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>}

      <div className="min-h-0 flex-1 overflow-auto">
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
              const b = busy[`${g.type}/${g.vmid}`];
              const cpu = g.cpu * 100;
              return (
                <tr key={`${g.type}-${g.vmid}`} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {g.type === "qemu" ? <Monitor size={15} className="text-sky-300" /> : <Container size={15} className="text-violet-300" />}
                      <div>
                        <div className="font-medium text-slate-100">{g.name}</div>
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
                    <div className="flex justify-end gap-1">
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
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
