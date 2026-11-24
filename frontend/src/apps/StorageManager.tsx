import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CalendarClock, Camera, Database, HardDrive, History, LayoutDashboard, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useTelemetry } from "../lib/stores";
import { api } from "../lib/api";
import type { Schedule, ZfsDataset, ZfsSnapshot, ZfsVdev } from "../lib/types";
import { bytes, healthColor, pct } from "../lib/format";
import { Bar } from "../components/charts";

type Tab = "overview" | "pools" | "snapshots" | "schedules" | "disks";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={15} /> },
  { id: "pools", label: "ZFS Pools", icon: <Database size={15} /> },
  { id: "snapshots", label: "Snapshots", icon: <Camera size={15} /> },
  { id: "schedules", label: "Schedules", icon: <CalendarClock size={15} /> },
  { id: "disks", label: "Disks & SMART", icon: <HardDrive size={15} /> },
];

const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "—");

function Schedules() {
  const pools = useTelemetry((s) => s.storage?.pools ?? []);
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [datasets, setDatasets] = useState<string[]>([]);
  const [kind, setKind] = useState<Schedule["kind"]>("snapshot");
  const [target, setTarget] = useState("");
  const [period, setPeriod] = useState<Schedule["interval"]>("daily");
  const [retention, setRetention] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Schedule[]>("/schedules").then(setItems, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    api<{ datasets: ZfsDataset[] }>("/pve/zfs/snapshots").then(
      (d) => setDatasets(d.datasets.filter((x) => x.type === "filesystem").map((x) => x.name)),
      () => {},
    );
  }, [load]);

  const targets = kind === "snapshot" ? datasets : pools.map((p) => p.name);
  const chosen = targets.includes(target) ? target : targets[0] ?? "";

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/schedules", { method: "POST", json: { kind, target: chosen, interval: kind === "scrub" ? "monthly" : period, retention } }));
  };

  const remove = (s: Schedule) => {
    if (window.confirm(`Delete the ${s.interval} ${s.kind} schedule for ${s.target}? Existing snapshots are kept.`))
      run(() => api(`/schedules/${s.id}`, { method: "DELETE" }));
  };

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="glass-soft flex flex-wrap items-end gap-2 rounded-xl p-3">
        <label className="text-[11px] text-slate-400">
          Task
          <select className="input mt-1 block py-1.5 text-xs" value={kind} onChange={(e) => setKind(e.target.value as Schedule["kind"])}>
            <option value="snapshot">Automatic snapshot</option>
            <option value="scrub">Monthly pool scrub</option>
          </select>
        </label>
        <label className="text-[11px] text-slate-400">
          {kind === "snapshot" ? "Dataset" : "Pool"}
          <select className="input mt-1 block py-1.5 text-xs" value={chosen} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {kind === "snapshot" && (
          <>
            <label className="text-[11px] text-slate-400">
              Interval
              <select className="input mt-1 block py-1.5 text-xs" value={period} onChange={(e) => setPeriod(e.target.value as Schedule["interval"])}>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="text-[11px] text-slate-400">
              Keep last
              <input
                type="number"
                min={1}
                max={1000}
                className="input mt-1 block w-20 py-1.5 text-xs"
                value={retention}
                onChange={(e) => setRetention(Number(e.target.value))}
                required
              />
            </label>
          </>
        )}
        <button className="btn ml-auto border-sky-400/40 bg-sky-500/25 text-white" disabled={busy || !chosen}>
          <Plus size={12} /> Add schedule
        </button>
      </form>
      <p className="text-[11px] text-slate-500">
        Automatic snapshots are named <span className="font-mono">proxmoxos-auto-&lt;interval&gt;-&lt;timestamp&gt;</span>. Older ones beyond the retention limit are
        deleted; manual snapshots are never touched. The first run happens one interval after the schedule is created.
      </p>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="py-2 font-medium">Task</th>
            <th className="px-2 font-medium">Target</th>
            <th className="px-2 font-medium">Interval</th>
            <th className="px-2 text-right font-medium">Keep</th>
            <th className="px-2 font-medium">Next run</th>
            <th className="px-2 font-medium">Last run</th>
            <th className="px-2 text-right font-medium">Enabled</th>
          </tr>
        </thead>
        <tbody>
          {items?.length === 0 && (
            <tr>
              <td colSpan={7} className="py-6 text-center text-slate-400">
                No schedules yet.
              </td>
            </tr>
          )}
          {items?.map((s) => (
            <tr key={s.id} className="border-t border-white/5">
              <td className="py-2 text-slate-200">{s.kind === "snapshot" ? "Snapshot" : "Scrub"}</td>
              <td className="px-2 font-mono text-slate-300">{s.target}</td>
              <td className="px-2 capitalize text-slate-300">{s.interval}</td>
              <td className="px-2 text-right tabular-nums text-slate-300">{s.kind === "snapshot" ? s.retention : "—"}</td>
              <td className="px-2 text-slate-300">{s.enabled ? when(s.next_run) : "Paused"}</td>
              <td className="px-2" title={s.last_error ?? ""}>
                <span className={s.last_status === "error" ? "text-rose-300" : "text-slate-300"}>{when(s.last_run)}</span>
                {s.last_status && <span className={`ml-1 ${s.last_status === "ok" ? "text-emerald-400" : "text-rose-400"}`}>{s.last_status === "ok" ? "✓" : "failed"}</span>}
              </td>
              <td className="px-2">
                <div className="flex items-center justify-end gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-sky-500"
                    checked={s.enabled}
                    disabled={busy}
                    onChange={(e) => run(() => api(`/schedules/${s.id}`, { method: "PATCH", json: { enabled: e.target.checked } }))}
                    aria-label={`Enable ${s.kind} schedule for ${s.target}`}
                  />
                  <button className="btn text-rose-300" disabled={busy} onClick={() => remove(s)} aria-label={`Delete schedule for ${s.target}`}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ text }: { text?: string }) {
  return <span className={`rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium ${healthColor(text)}`}>{text || "UNKNOWN"}</span>;
}

function Vdev({ v, depth }: { v: ZfsVdev; depth: number }) {
  return (
    <>
      <tr className="border-t border-white/5">
        <td className="py-1.5 pr-2 font-mono text-slate-200" style={{ paddingLeft: depth * 16 + 8 }}>
          {v.name}
        </td>
        <td className={`px-2 ${healthColor(v.state)}`}>{v.state ?? ""}</td>
        <td className="px-2 text-right tabular-nums text-slate-400">{v.read ?? ""}</td>
        <td className="px-2 text-right tabular-nums text-slate-400">{v.write ?? ""}</td>
        <td className="px-2 text-right tabular-nums text-slate-400">{v.cksum ?? ""}</td>
      </tr>
      {v.children?.map((c) => <Vdev key={`${v.name}/${c.name}`} v={c} depth={depth + 1} />)}
    </>
  );
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `manual-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

function Snapshots() {
  const [data, setData] = useState<{ datasets: ZfsDataset[]; snapshots: ZfsSnapshot[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState("");
  const [name, setName] = useState(stamp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ datasets: ZfsDataset[]; snapshots: ZfsSnapshot[] }>("/pve/zfs/snapshots")
      .then((d) => (setData(d), setError("")))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    const dataset = target || filter || data?.datasets[0]?.name;
    if (dataset) run(() => api("/pve/zfs/snapshots", { method: "POST", json: { dataset, name } }).then(() => setName(stamp())));
  };

  const rollback = (s: ZfsSnapshot) => {
    const newer = (data?.snapshots ?? []).filter((x) => x.dataset === s.dataset && x.creation > s.creation);
    const warning = newer.length
      ? `\n\nThis also DESTROYS ${newer.length} newer snapshot(s): ${newer.map((x) => x.snapshot).join(", ")}.`
      : "";
    if (!window.confirm(`Roll back ${s.dataset} to "${s.snapshot}"? All changes made after it are lost.${warning}`)) return;
    run(() => api("/pve/zfs/snapshots/rollback", { method: "POST", json: { snapshot: s.name, force: newer.length > 0 } }));
  };

  const remove = (s: ZfsSnapshot) => {
    if (!window.confirm(`Delete snapshot ${s.name}? This cannot be undone.`)) return;
    run(() => api(`/pve/zfs/snapshots?snapshot=${encodeURIComponent(s.name)}`, { method: "DELETE" }));
  };

  const shown = useMemo(
    () => (data?.snapshots ?? []).filter((s) => !filter || s.dataset === filter || s.dataset.startsWith(`${filter}/`)),
    [data, filter],
  );

  if (!data) return error ? <p className="text-sm text-rose-300">{error}</p> : <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-slate-400">
          Pool / dataset
          <select className="input mt-1 block py-1.5 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All datasets</option>
            {data.datasets.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <form onSubmit={create} className="ml-auto flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-slate-400">
            Snapshot of
            <select className="input mt-1 block py-1.5 text-xs" value={target || filter} onChange={(e) => setTarget(e.target.value)}>
              {data.datasets.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-slate-400">
            Name
            <input className="input mt-1 block w-44 py-1.5 text-xs" value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" required />
          </label>
          <button className="btn border-sky-400/40 bg-sky-500/25 text-white" disabled={busy || !data.datasets.length}>
            <Camera size={12} /> Take snapshot
          </button>
        </form>
      </div>
      {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="py-2 font-medium">Snapshot</th>
            <th className="px-2 font-medium">Dataset</th>
            <th className="px-2 font-medium">Created</th>
            <th className="px-2 text-right font-medium">Used</th>
            <th className="px-2 text-right font-medium">Refer</th>
            <th className="px-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-slate-400">
                No snapshots.
              </td>
            </tr>
          )}
          {shown.map((s) => (
            <tr key={s.name} className="border-t border-white/5">
              <td className="py-2 font-mono text-slate-200">{s.snapshot}</td>
              <td className="px-2 font-mono text-slate-400">{s.dataset}</td>
              <td className="px-2 text-slate-300">{new Date(s.creation * 1000).toLocaleString()}</td>
              <td className="px-2 text-right tabular-nums text-slate-300">{bytes(s.used)}</td>
              <td className="px-2 text-right tabular-nums text-slate-300">{bytes(s.refer)}</td>
              <td className="px-2">
                <div className="flex justify-end gap-1">
                  <button className="btn" disabled={busy} onClick={() => rollback(s)} title="Roll back dataset to this snapshot">
                    <History size={12} /> Rollback
                  </button>
                  <button className="btn text-rose-300" disabled={busy} onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StorageManager() {
  const [tab, setTab] = useState<Tab>("overview");
  const { storage, refreshStorage } = useTelemetry();

  useEffect(() => {
    refreshStorage();
  }, [refreshStorage]);

  return (
    <div className="flex h-full">
      <nav className="w-44 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${
              tab === t.id ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
            title={t.label}
          >
            {t.icon}
            <span className="max-sm:hidden">{t.label}</span>
          </button>
        ))}
        <button onClick={refreshStorage} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 hover:text-slate-200" title="Refresh">
          <RefreshCw size={15} /> <span className="max-sm:hidden">Refresh</span>
        </button>
      </nav>

      <div className="min-w-0 flex-1 overflow-auto p-4">
        {tab === "snapshots" ? (
          <Snapshots />
        ) : tab === "schedules" ? (
          <Schedules />
        ) : !storage ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : tab === "overview" ? (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-100">Storage targets</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {storage.targets.map((t) => (
                <div key={t.storage} className="glass-soft rounded-xl p-3">
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-100">{t.storage}</span>
                    <span className="text-slate-400">
                      {t.type} · {t.active ? "active" : "inactive"}
                    </span>
                  </div>
                  <Bar value={pct(t.used, t.total)} />
                  <div className="mt-1.5 flex justify-between text-[11px] text-slate-400">
                    <span>
                      {bytes(t.used)} / {bytes(t.total)}
                    </span>
                    <span className="truncate pl-2">{t.content}</span>
                  </div>
                </div>
              ))}
            </div>
            <h3 className="text-sm font-semibold text-slate-100">Summary</h3>
            <div className="grid grid-cols-3 gap-3 text-center">
              {[
                ["ZFS pools", storage.pools.length],
                ["Physical disks", storage.disks.length],
                ["Healthy pools", storage.pools.filter((p) => p.health === "ONLINE").length],
              ].map(([k, v]) => (
                <div key={k} className="glass-soft rounded-xl p-3">
                  <div className="text-2xl font-semibold text-white">{v}</div>
                  <div className="text-[11px] text-slate-400">{k}</div>
                </div>
              ))}
            </div>
          </div>
        ) : tab === "pools" ? (
          <div className="space-y-4">
            {storage.pools.length === 0 && <p className="text-sm text-slate-400">No ZFS pools found.</p>}
            {storage.pools.map((p) => (
              <section key={p.name} className="glass-soft rounded-xl p-4">
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <Database size={16} className="text-amber-300" />
                  <h3 className="text-sm font-semibold text-white">{p.name}</h3>
                  <Badge text={p.health} />
                  <span className="ml-auto text-xs text-slate-400">
                    Fragmentation {p.frag}% · Dedup {p.dedup}x
                  </span>
                </div>
                <Bar value={pct(p.alloc, p.size)} className="bg-amber-400" />
                <div className="mt-1.5 text-[11px] text-slate-400">
                  {bytes(p.alloc)} used · {bytes(p.free)} free · {bytes(p.size)} total
                </div>
                {p.detail.scan && <p className="mt-2 text-[11px] text-slate-400">Scan: {p.detail.scan}</p>}
                {p.detail.errors && <p className="text-[11px] text-slate-400">Errors: {p.detail.errors}</p>}
                {p.detail.children && (
                  <table className="mt-3 w-full text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="py-1 pl-2 text-left font-medium">Topology</th>
                        <th className="px-2 text-left font-medium">State</th>
                        <th className="px-2 text-right font-medium">Read</th>
                        <th className="px-2 text-right font-medium">Write</th>
                        <th className="px-2 text-right font-medium">Cksum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.detail.children.map((c) => (
                        <Vdev key={c.name} v={c} depth={0} />
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            ))}
          </div>
        ) : (
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2 font-medium">Device</th>
                <th className="px-2 font-medium">Model</th>
                <th className="px-2 font-medium">Serial</th>
                <th className="px-2 font-medium">Type</th>
                <th className="px-2 text-right font-medium">Size</th>
                <th className="px-2 text-right font-medium">Wearout</th>
                <th className="px-2 font-medium">SMART</th>
              </tr>
            </thead>
            <tbody>
              {storage.disks.map((d) => (
                <tr key={d.devpath} className="border-t border-white/5">
                  <td className="py-2 font-mono text-slate-200">{d.devpath}</td>
                  <td className="px-2 text-slate-200">{d.model || "—"}</td>
                  <td className="px-2 font-mono text-slate-400">{d.serial || "—"}</td>
                  <td className="px-2 uppercase text-slate-300">{d.type || "—"}</td>
                  <td className="px-2 text-right tabular-nums text-slate-300">{bytes(d.size)}</td>
                  <td className="px-2 text-right tabular-nums text-slate-300">
                    {/* PVE reports wearout as % of rated life remaining (100 - NVMe percentage_used), or "N/A" for HDDs. */}
                    {typeof d.wearout === "number" ? `${d.wearout}% left` : d.wearout || "N/A"}
                  </td>
                  <td className="px-2">
                    <Badge text={d.health} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
