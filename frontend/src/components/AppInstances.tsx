import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, ExternalLink, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useIntent } from "../lib/stores";
import type { AppInstance } from "../lib/types";
import { useTranslation, type TKey } from "../i18n";
import { GlassBadge, GlassButton, GlassModal, GlassSwitch } from "./ui/GlassKit";
import { OperationProgressCard, useJobProgress } from "./ui/OperationProgressCard";
import { OsiButton } from "./osi/OsiArchitecturePanel";
import { osiValues, urlValues } from "../data/osiModelRegistry";

/** Built-in features that replaced former App Center apps: search words, the App Center hint and where it opens. */
export const NATIVE_FEATURES = {
  smb_shares: { words: /samba|smb|cifs|file ?shar/, hint: "ac.native.smb", path: ["set.cat.storage", "set.mod.shared-folders"], open: () => useIntent.getState().go("settings", "shared-folders") },
  reverse_proxy: { words: /nginx|reverse ?proxy|proxy manager|let'?s ?encrypt/, hint: "ac.native.proxy", path: ["set.cat.network", "set.mod.reverse-proxy"], open: () => useIntent.getState().go("settings", "reverse-proxy") },
  docker_engine: { words: /docker|compose/, hint: "ac.native.docker", path: [], open: () => useIntent.getState().go("compute", "docker") },
} satisfies Record<string, { words: RegExp; hint: TKey; path: TKey[]; open: () => void }>;
export type NativeFeature = keyof typeof NATIVE_FEATURES;

const CHANGED = "solardeck:apps-changed";
/** Tell every open App Center / Settings list that an app instance was installed or removed. */
export const appsChanged = () => window.dispatchEvent(new Event(CHANGED));
export const onAppsChanged = (fn: () => void) => {
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
};

/** GET /api/apps/instances, reloaded whenever appsChanged() fires. */
export function useAppInstances() {
  const [instances, setInstances] = useState<AppInstance[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api<AppInstance[]>("/apps/instances").then(
      (r) => {
        setInstances(r);
        setError("");
      },
      (e) => setError((e as Error).message),
    );
  }, []);
  useEffect(() => {
    reload();
    return onAppsChanged(reload);
  }, [reload]);
  return { instances, error, reload };
}

/** Same rule as the backend's hostname_for: "<app id>-<label slug>", at most 63 characters. */
export function hostnameFor(appId: string, label: string) {
  const seg = label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (seg ? `${appId}-${seg}` : appId).slice(0, 63).replace(/-+$/, "");
}

export const displayName = (appName: string, label: string) => (label.trim() ? `${appName} — ${label.trim()}` : appName);

const DOT: Record<string, string> = { running: "bg-emerald-400", stopped: "bg-slate-500", installing: "animate-pulse bg-sky-400" };
const STATUS = ["running", "stopped", "installing"] as const;

function useStatusText() {
  const { t } = useTranslation();
  return (s: string) => t(`inst.status.${(STATUS as readonly string[]).includes(s) ? (s as (typeof STATUS)[number]) : "unknown"}`);
}

function UninstallProgress({ jobId, title }: { jobId: string; title: string }) {
  const progress = useJobProgress(`/tasks/${jobId}`, true, appsChanged);
  return progress ? <OperationProgressCard title={title} progress={progress} /> : null;
}

/** Confirmation with the "also delete data" switch (off by default), then the live uninstall progress. */
export function UninstallInstanceModal({ instance, onClose }: { instance: AppInstance | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => {
    setDeleteData(false);
    setError("");
    setJobId(null);
  }, [instance?.instance_id]);
  if (!instance) return null;

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ job_id: string }>(`/apps/instances/${encodeURIComponent(instance.instance_id)}?delete_data=${deleteData}`, { method: "DELETE" });
      setJobId(r.job_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassModal
      open
      onClose={onClose}
      title={t("inst.uninstallTitle", { name: instance.display_name })}
      footer={
        jobId ? (
          <GlassButton onClick={onClose}>{t("common.close")}</GlassButton>
        ) : (
          <>
            <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
            <GlassButton variant="danger" disabled={busy} onClick={start}>
              <Trash2 size={12} /> {busy ? t("inst.uninstalling") : t("inst.uninstall")}
            </GlassButton>
          </>
        )
      }
    >
      <div className="space-y-3 text-xs text-slate-300">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
          <dt className="text-slate-400">{t("inst.name")}</dt>
          <dd className="break-words text-white">{instance.display_name}</dd>
          <dt className="text-slate-400">{t("inst.containerId")}</dt>
          <dd className="font-mono text-white">{instance.guest_id}</dd>
          <dt className="text-slate-400">{t("inst.ip")}</dt>
          <dd className="font-mono text-white">{instance.ip_address ?? t("inst.noIp")}</dd>
        </dl>
        {jobId ? (
          <UninstallProgress jobId={jobId} title={t("progress.title.appUninstall", { name: instance.display_name })} />
        ) : (
          <>
            <p>{t("inst.uninstallMsg")}</p>
            <GlassSwitch checked={deleteData} onChange={setDeleteData} label={t("inst.deleteData")} />
            <p className="text-[11px] text-slate-400">
              {deleteData ? t("inst.deleteDataOn", { path: `/mnt/storage/apps/${instance.instance_id}` }) : t("inst.deleteDataOff", { path: `/mnt/storage/apps/${instance.instance_id}` })}
            </p>
            {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-rose-300">{error}</p>}
          </>
        )}
      </div>
    </GlassModal>
  );
}

/** One instance: status dot, label, container id, IP, Open and Uninstall. */
/** OSI target of a running instance: veth (L2), container IP (L3), web port (L4), TLS (L6), endpoint (L7). */
const instanceOsi = (inst: AppInstance) => ({
  kind: "app_instance" as const,
  name: inst.display_name,
  values: osiValues({ model: "veth", ip: inst.ip_address, ...urlValues(inst.web_url) }),
});

export function InstanceRow({ inst, onUninstall, openLabel }: { inst: AppInstance; onUninstall: (i: AppInstance) => void; openLabel?: string }) {
  const { t } = useTranslation();
  const status = useStatusText();
  const native = inst.native_feature ? NATIVE_FEATURES[inst.native_feature] : undefined;
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2 ring-1 ring-white/10">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[inst.status] ?? "bg-amber-400"}`} title={status(inst.status)} aria-label={status(inst.status)} role="img" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-white" title={inst.display_name}>
          {inst.instance_label || t("inst.defaultInstance")}
        </p>
        <p className="truncate text-[10px] text-slate-400">
          {t("inst.container", { id: inst.guest_id })} · <span className="font-mono">{inst.ip_address ?? t("inst.noIp")}</span> · {status(inst.status)}
          {inst.cores > 0 && ` · ${inst.cores} vCPU · ${(inst.memory_mb / 1024).toFixed(1).replace(/\.0$/, "")} GB`}
        </p>
        {native && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5" title={t("inst.nativeHint")}>
            <GlassBadge tone="info">{t("inst.nativeBadge")}</GlassBadge>
            <button type="button" className="inline-flex items-center gap-0.5 text-[10px] text-sky-300 hover:text-sky-200" onClick={native.open}>
              {t("inst.nativeOpen")} <ArrowUpRight size={10} />
            </button>
          </p>
        )}
      </div>
      {inst.web_url && (
        <a className="btn shrink-0 border-sky-400/30 bg-sky-500/20 py-1 text-[11px] text-white" href={inst.web_url} target="_blank" rel="noreferrer">
          <ExternalLink size={11} /> {openLabel ?? t("common.open")}
        </a>
      )}
      <OsiButton {...instanceOsi(inst)} />
      <GlassButton size="xs" variant="danger" onClick={() => onUninstall(inst)} disabled={inst.status === "installing"}>
        <Trash2 size={11} /> {t("inst.uninstall")}
      </GlassButton>
    </div>
  );
}

/** Every instance of one app, each with its own Open / Uninstall. */
export function ManageInstancesModal({ appName, instances, onClose }: { appName: string; instances: AppInstance[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState<AppInstance | null>(null);
  return (
    <>
      <GlassModal open onClose={onClose} title={t("inst.manageTitle", { name: appName })} footer={<GlassButton onClick={onClose}>{t("common.close")}</GlassButton>}>
        <div className="space-y-2">
          {instances.map((i) => (
            <InstanceRow key={i.instance_id} inst={i} onUninstall={setRemoving} />
          ))}
          {instances.length === 0 && <p className="text-xs text-slate-400">{t("inst.empty")}</p>}
        </div>
      </GlassModal>
      <UninstallInstanceModal instance={removing} onClose={() => setRemoving(null)} />
    </>
  );
}
