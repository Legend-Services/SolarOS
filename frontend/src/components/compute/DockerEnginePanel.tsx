import { useCallback, useEffect, useState } from "react";
import { Download, Play, RefreshCw, RotateCw, Square, Store, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { useWindows } from "../../lib/stores";
import { useTranslation } from "../../i18n";
import { GlassBadge, GlassButton, Notice } from "../ui/GlassKit";
import { OperationProgressCard, useJobProgress } from "../ui/OperationProgressCard";

interface DockerStatus {
  enabled: boolean;
  runtime_mode: "container" | "host_native";
  installed: boolean;
  running: boolean;
  version: string | null;
  compose_version: string | null;
}
interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  stack: string | null;
}
interface DockerStack {
  name: string;
  status: string;
  config_files: string;
}
type Action = "start" | "stop" | "restart" | "unpause" | "remove";

const STATE_TONE: Record<string, "success" | "warning" | "neutral" | "danger"> = { running: "success", paused: "warning", exited: "neutral", dead: "danger" };

/** Compute › Docker: the built-in Docker Engine's containers and Compose stacks (below its SecurityModuleHeader). */
export default function DockerEnginePanel() {
  const { t } = useTranslation();
  const openApp = useWindows((s) => s.open);
  const [st, setSt] = useState<DockerStatus | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [stacks, setStacks] = useState<DockerStack[]>([]);
  const [job, setJob] = useState<string | null>(null);
  const { busy, error, run } = useRunner();

  const load = useCallback(async () => {
    const s = await api<DockerStatus>("/docker/status");
    setSt(s);
    if (s.installed) {
      const [c, k] = await Promise.all([api<DockerContainer[]>("/docker/containers"), api<DockerStack[]>("/docker/stacks")]);
      setContainers(c);
      setStacks(k);
    }
  }, []);
  useEffect(() => void run(load), [run, load]);

  const install = () =>
    run(async () => {
      const r = await api<{ job_id: string }>("/docker/enable", { method: "POST", json: {} });
      setJob(r.job_id);
    });
  const installed = useCallback(
    (ok: boolean) => {
      if (!ok) return;
      // A new runtime container still has to move onto the module's network.
      void run(async () => {
        if (st?.runtime_mode === "container") await api("/platform/modules/docker_engine/place", { method: "POST" });
        await load();
      });
    },
    [run, load, st?.runtime_mode],
  );
  const act = (c: DockerContainer, a: Action) => {
    if (a === "remove" && !window.confirm(t("dk.confirmRemove", { name: c.name }))) return;
    void run(async () => {
      await api(`/docker/containers/${encodeURIComponent(c.id)}/${a}`, { method: "POST" });
      await load();
    });
  };

  if (!st) return <Notice error={error} />;
  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-slate-400">{t("dk.intro")}</p>
      <Notice error={error} />
      {!st.installed ? (
        <section className="glass-soft flex flex-wrap items-center gap-3 rounded-2xl p-4">
          <p className="min-w-0 flex-1 text-xs text-slate-300">{t("dk.notInstalled")}</p>
          <GlassButton variant="primary" disabled={busy || !!job} onClick={install}>
            <Download size={13} /> {t("dk.install")}
          </GlassButton>
        </section>
      ) : (
        <>
          <section className="glass-soft flex flex-wrap items-center gap-2 rounded-2xl p-3">
            <GlassBadge tone={st.running ? "success" : "warning"}>{st.running ? t("dk.running") : t("dk.stopped")}</GlassBadge>
            {st.version && <GlassBadge tone="info">{t("dk.engine", { v: st.version })}</GlassBadge>}
            {st.compose_version && <GlassBadge tone="info">{t("dk.compose", { v: st.compose_version })}</GlassBadge>}
            <GlassBadge>{st.runtime_mode === "container" ? t("sdm.container") : t("sdm.hostNative")}</GlassBadge>
            <GlassButton size="xs" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void run(load)} aria-label={t("common.refresh")}>
              <RefreshCw size={12} />
            </GlassButton>
          </section>

          <section className="glass-soft rounded-2xl p-3" aria-label={t("dk.containers")}>
            <h4 className="px-1 pb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t("dk.containers")}</h4>
            {containers.length === 0 ? (
              <p className="px-1 text-xs text-slate-400">{t("dk.noContainers")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="text-[10px] tracking-wide text-slate-500 uppercase">
                    <tr>
                      <th className="px-2 py-1">{t("dk.col.name")}</th>
                      <th className="px-2 py-1">{t("dk.col.image")}</th>
                      <th className="px-2 py-1">{t("dk.col.state")}</th>
                      <th className="px-2 py-1">{t("dk.col.ports")}</th>
                      <th className="px-2 py-1">{t("dk.col.stack")}</th>
                      <th className="px-2 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {containers.map((c) => {
                      const up = c.state === "running";
                      return (
                        <tr key={c.id} className="border-t border-white/5">
                          <td className="px-2 py-1.5 font-medium text-white">{c.name}</td>
                          <td className="px-2 py-1.5 font-mono text-[11px] text-slate-300">{c.image}</td>
                          <td className="px-2 py-1.5" title={c.status}>
                            <GlassBadge tone={STATE_TONE[c.state] ?? "neutral"}>{c.state}</GlassBadge>
                          </td>
                          <td className="max-w-[200px] truncate px-2 py-1.5 font-mono text-[11px] text-slate-400" title={c.ports}>
                            {c.ports || "—"}
                          </td>
                          <td className="px-2 py-1.5 text-slate-300">{c.stack ?? "—"}</td>
                          <td className="px-2 py-1.5">
                            <div className="flex justify-end gap-1">
                              {!up && c.state !== "paused" && (
                                <GlassButton size="xs" disabled={busy} onClick={() => act(c, "start")} aria-label={t("dk.a.start")}>
                                  <Play size={11} />
                                </GlassButton>
                              )}
                              {c.state === "paused" && (
                                <GlassButton size="xs" disabled={busy} onClick={() => act(c, "unpause")} aria-label={t("dk.a.start")}>
                                  <Play size={11} />
                                </GlassButton>
                              )}
                              {up && (
                                <>
                                  <GlassButton size="xs" disabled={busy} onClick={() => act(c, "restart")} aria-label={t("dk.a.restart")}>
                                    <RotateCw size={11} />
                                  </GlassButton>
                                  <GlassButton size="xs" disabled={busy} onClick={() => act(c, "stop")} aria-label={t("dk.a.stop")}>
                                    <Square size={11} />
                                  </GlassButton>
                                </>
                              )}
                              <GlassButton size="xs" variant="danger" disabled={busy} onClick={() => act(c, "remove")} aria-label={t("dk.a.remove")}>
                                <Trash2 size={11} />
                              </GlassButton>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="glass-soft rounded-2xl p-3" aria-label={t("dk.stacks")}>
            <h4 className="px-1 pb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t("dk.stacks")}</h4>
            {stacks.length === 0 ? (
              <p className="px-1 text-xs text-slate-400">{t("dk.noStacks")}</p>
            ) : (
              <div className="space-y-1.5">
                {stacks.map((s) => (
                  <div key={s.name} className="flex flex-wrap items-center gap-2 rounded-xl bg-white/5 px-3 py-2 ring-1 ring-white/10">
                    <span className="text-xs font-medium text-white">{s.name}</span>
                    <GlassBadge tone={s.status.startsWith("running") ? "success" : "neutral"}>{s.status}</GlassBadge>
                    <span className="ml-auto truncate font-mono text-[10px] text-slate-400" title={t("dk.col.files")}>
                      {s.config_files}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {job && <InstallProgress job={job} onDone={installed} onDismiss={() => setJob(null)} />}
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.03] p-3">
        <p className="min-w-0 flex-1 text-[11px] text-slate-400">{t("dk.portainerHint")}</p>
        <GlassButton size="xs" onClick={() => openApp("appcenter")}>
          <Store size={12} /> {t("dk.openAppCenter")}
        </GlassButton>
      </section>
    </div>
  );
}

/** Mounted only while an install runs, so nothing is polled otherwise. */
function InstallProgress({ job, onDone, onDismiss }: { job: string; onDone: (ok: boolean) => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const progress = useJobProgress(`/tasks/${job}`, true, onDone);
  return progress && <OperationProgressCard title={t("dk.installing")} progress={progress} onDismiss={onDismiss} />;
}
