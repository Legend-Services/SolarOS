import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { edition } from "@edition";
import { useCapabilities } from "../store/capabilitiesStore";
import { ArrowUpCircle, Download, PackageCheck, Plus, Power, RefreshCw, RotateCcw, Server, SquareTerminal, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { useTelemetry, useWindows } from "../lib/stores";
import { uptime } from "../lib/format";
import { TaskLog } from "../components/TaskCenterPopover";
import type { AptUpdate, RepoInfo, UpgradeStatus } from "../lib/types";

type Tab = "repos" | "updates" | "host";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "repos", label: "Repositories", icon: <PackageCheck size={15} /> },
  { id: "updates", label: "Updates", icon: <ArrowUpCircle size={15} /> },
  { id: "host", label: "Host & Power", icon: <Server size={15} /> },
];

function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };
  return { busy, error, setError, run };
}

const Err = ({ text }: { text: string }) => (text ? <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{text}</p> : null);

function Repositories() {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const load = useCallback(() => {
    api<RepoInfo>("/system/repositories").then(setInfo, (e) => setError(e.message));
  }, []);
  const { busy, error, setError, run } = useAction(load);
  useEffect(load, [load]);

  if (!info) return error ? <Err text={error} /> : <p className="text-sm text-slate-400">Loading…</p>;
  const has = (h: string) => info.repositories.some((r) => r.handle === h && r.enabled);
  const needsFix = has("enterprise") && !has("no-subscription");

  return (
    <div className="space-y-4">
      {needsFix && edition.subscriptionWarning && (
        <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert size={15} className="shrink-0" />
          <span>{edition.subscriptionWarning}</span>
        </div>
      )}
      <Err text={error} />
      {info.errors.map((e) => (
        <Err key={e} text={e} />
      ))}
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="py-2 font-medium">Repository</th>
            <th className="px-2 font-medium">Suites</th>
            <th className="px-2 font-medium">Components</th>
            <th className="px-2 font-medium">File</th>
            <th className="px-2 text-right font-medium">Enabled</th>
          </tr>
        </thead>
        <tbody>
          {info.repositories.map((r) => (
            <tr key={`${r.path}:${r.index}`} className={`border-t border-white/5 ${r.enabled ? "" : "opacity-50"}`}>
              <td className="py-2">
                <div className="text-slate-100">{(r.handle && info.names[r.handle]) || r.uris[0]}</div>
                {r.handle && <div className="font-mono text-[10px] text-slate-500">{r.uris[0]}</div>}
              </td>
              <td className="px-2 text-slate-300">{r.suites.join(" ")}</td>
              <td className="px-2 text-slate-300">{r.components.join(" ")}</td>
              <td className="px-2 font-mono text-[10px] text-slate-500">{r.path.replace("/etc/apt/", "")}</td>
              <td className="px-2 text-right">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-sky-500"
                  checked={r.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    run(() =>
                      api("/system/repositories/toggle", { method: "POST", json: { path: r.path, index: r.index, enabled: e.target.checked, digest: info.digest } }),
                    )
                  }
                  aria-label={`Enable ${r.uris[0]}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="pt-2 text-sm font-semibold text-slate-100">{edition.addRepositoryTitle}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {info.available.map((a) => (
          <div key={a.handle} className="glass-soft flex items-start gap-3 rounded-xl p-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-slate-100">{a.name}</div>
              <p className="mt-0.5 text-[11px] text-slate-400">{a.description}</p>
            </div>
            <button
              className="btn shrink-0"
              disabled={busy}
              onClick={() => run(() => api("/system/repositories/add", { method: "POST", json: { handle: a.handle, digest: info.digest } }))}
            >
              <Plus size={12} /> Add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Updates() {
  const [list, setList] = useState<AptUpdate[] | null>(null);
  const [refreshTask, setRefreshTask] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeStatus | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const load = useCallback(() => {
    api<AptUpdate[]>("/system/updates").then(setList, () => setList([]));
  }, []);
  const { busy, error, run } = useAction(load);

  const pollUpgrade = useCallback(() => {
    api<UpgradeStatus>("/system/upgrade").then(setUpgrade, () => {});
  }, []);
  useEffect(() => {
    load();
    pollUpgrade();
  }, [load, pollUpgrade]);
  // Poll the host-side upgrade while it runs; reload the package list once it finishes.
  useEffect(() => {
    if (!upgrade?.running) return;
    const t = setInterval(pollUpgrade, 2000);
    return () => {
      clearInterval(t);
      load();
    };
  }, [upgrade?.running, pollUpgrade, load]);
  useEffect(() => {
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, [upgrade?.log.length]);

  const startUpgrade = () => {
    if (!window.confirm(`Install ${list?.length ?? 0} update(s) on ${edition.host} (apt dist-upgrade)? Running guests keep running; a kernel update needs a reboot to take effect.`)) return;
    run(() => api("/system/upgrade", { method: "POST" }).then(pollUpgrade));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" disabled={busy || !!refreshTask} onClick={() => run(() => api<{ task: string }>("/system/updates/refresh", { method: "POST" }).then((r) => setRefreshTask(r.task)))}>
          <RefreshCw size={12} className={refreshTask ? "animate-spin" : ""} /> Check for updates
        </button>
        <button className="btn border-sky-400/40 bg-sky-500/25 text-white" disabled={busy || upgrade?.running || !list?.length} onClick={startUpgrade}>
          <Download size={12} /> {upgrade?.running ? "Upgrading…" : `Upgrade all (${list?.length ?? 0})`}
        </button>
        <span className="ml-auto text-[11px] text-slate-400">{list ? (list.length ? `${list.length} update(s) available` : "System is up to date") : "Loading…"}</span>
      </div>
      <Err text={error} />
      {refreshTask && <TaskLog upid={refreshTask} className="h-32" onDone={() => (setRefreshTask(null), load())} />}
      {upgrade && upgrade.log.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-slate-400">
            Last upgrade:{" "}
            {upgrade.running ? (
              <span className="text-sky-300">running</span>
            ) : upgrade.exit_code === 0 ? (
              <span className="text-emerald-400">completed</span>
            ) : (
              <span className="text-rose-400">failed (exit {upgrade.exit_code ?? "?"})</span>
            )}
          </div>
          <pre ref={pre} className="h-48 overflow-auto rounded-lg bg-black/50 p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-300">
            {upgrade.log.join("\n")}
          </pre>
        </div>
      )}
      {list && list.length > 0 && (
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 font-medium">Package</th>
              <th className="px-2 font-medium">Current</th>
              <th className="px-2 font-medium">New</th>
              <th className="px-2 font-medium">Origin</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.Package} className="border-t border-white/5">
                <td className="py-1.5">
                  <div className="font-mono text-slate-100">{u.Package}</div>
                  {u.Title && <div className="text-[10px] text-slate-500">{u.Title}</div>}
                </td>
                <td className="px-2 font-mono text-slate-400">{u.OldVersion || "new"}</td>
                <td className="px-2 font-mono text-emerald-300">{u.Version}</td>
                <td className="px-2 text-slate-400">{u.Origin}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Host() {
  const o = useTelemetry((s) => s.overview);
  const open = useWindows((s) => s.open);
  const { busy, error, run } = useAction(() => {});
  const [sent, setSent] = useState("");
  const node = o?.node ?? "host";

  const power = (command: "reboot" | "shutdown") => {
    const verb = command === "reboot" ? "Reboot" : "Shut down";
    if (!window.confirm(`${verb} ${edition.host} "${node}"? All running VMs and containers are stopped, and SolarDeck itself goes offline${command === "shutdown" ? " until the server is powered on again" : " for a few minutes"}.`)) return;
    run(() => api("/system/power", { method: "POST", json: { command } }).then(() => setSent(`${verb} command sent.`)));
  };

  return (
    <div className="space-y-4">
      <dl className="glass-soft grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl p-4 text-xs">
        {[
          ["Node", o?.node],
          ["Platform", o?.pveversion],
          ["Kernel", o?.kernel],
          ["Uptime", o && uptime(o.uptime)],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-400">{k}</dt>
            <dd className="truncate text-slate-100">{v || "—"}</dd>
          </div>
        ))}
      </dl>

      <section className="glass-soft rounded-xl p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-100">Host shell</h3>
        <p className="mb-3 text-[11px] text-slate-400">A full terminal on {edition.host}. Log in with a host account, for example root and its password.</p>
        <button className="btn" onClick={() => open("console", { type: "node", vmid: 0, name: node, mode: "shell" })}>
          <SquareTerminal size={12} /> Open host shell
        </button>
      </section>

      <section className="glass-soft rounded-xl p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-100">Power</h3>
        <div className="flex flex-wrap gap-2">
          <button className="btn" disabled={busy || !!sent} onClick={() => power("reboot")}>
            <RotateCcw size={12} /> Reboot host
          </button>
          <button className="btn text-rose-300" disabled={busy || !!sent} onClick={() => power("shutdown")}>
            <Power size={12} /> Shut down host
          </button>
        </div>
        {sent && <p className="mt-2 text-xs text-amber-300">{sent}</p>}
      </section>
      <Err text={error} />
    </div>
  );
}

export default function SystemApp() {
  const caps = useCapabilities((s) => s.capabilities);
  const [tab, setTab] = useState<Tab>(caps.supports_apt_repos ? "repos" : "updates");
  return (
    <div className="flex h-full">
      <nav className="w-44 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        {TABS.filter((t) => t.id !== "repos" || caps.supports_apt_repos).map((t) => (
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
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-4">{tab === "repos" ? <Repositories /> : tab === "updates" ? <Updates /> : <Host />}</div>
    </div>
  );
}
