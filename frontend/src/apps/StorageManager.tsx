import { useEffect, useState, type ReactNode } from "react";
import { Database, HardDrive, LayoutDashboard, RefreshCw } from "lucide-react";
import { useTelemetry } from "../lib/stores";
import type { ZfsVdev } from "../lib/types";
import { bytes, healthColor, pct } from "../lib/format";
import { Bar } from "../components/charts";

type Tab = "overview" | "pools" | "disks";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={15} /> },
  { id: "pools", label: "ZFS Pools", icon: <Database size={15} /> },
  { id: "disks", label: "Disks & SMART", icon: <HardDrive size={15} /> },
];

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
        {!storage ? (
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
                    {/* PVE reports wearout as % of rated life used (NVMe percentage_used), or "N/A" for HDDs. */}
                    {typeof d.wearout === "number" ? `${d.wearout}% used` : d.wearout || "N/A"}
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
