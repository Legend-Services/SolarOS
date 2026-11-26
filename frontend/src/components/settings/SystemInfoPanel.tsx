import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, CloudDownload, Cpu, HardDrive, MemoryStick, MonitorCog, Pencil, Power, RefreshCw, RotateCcw, Server, X } from "lucide-react";
import { edition } from "@edition";
import { api } from "../../lib/api";
import { bytes, percent, tempColor, uptime } from "../../lib/format";
import { useRunner } from "../../lib/hooks";
import { openLink } from "../../lib/stores";
import type { SystemInfo, SystemUpdates, UpdateStatus } from "../../lib/types";
import { useTranslation } from "../../i18n";
import { useUpdateStore } from "../../store/updateStore";
import { ConfirmModal, GlassBadge, GlassButton, GlassInput, Notice, healthTone } from "../ui/GlassKit";

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function Section({ icon, title, action, anchor, children }: { icon: ReactNode; title: string; action?: ReactNode; anchor?: string; children: ReactNode }) {
  return (
    <section className="glass-soft rounded-2xl p-4" data-anchor={anchor}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-slate-400">{icon}</span>
        <h3 className="flex-1 text-sm font-semibold text-slate-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,max-content)_1fr] gap-x-5 gap-y-1.5 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-400">{k}</dt>
          <dd className="min-w-0 truncate text-slate-100" title={typeof v === "string" ? v : undefined}>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Bar({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = Math.round(percent(used, total));
  const tone = pct > 90 ? "bg-rose-400" : pct > 75 ? "bg-amber-400" : "bg-sky-400";
  return (
    <div className="mt-2">
      <div className="mb-1 flex justify-between text-[11px] text-slate-400">
        <span>{label}</span>
        <span className="tabular-nums">{bytes(used)} / {bytes(total)} · {pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DeepLink({ module, label }: { module: "hardware-gpu" | "storage-zfs"; label: string }) {
  return (
    <GlassButton size="xs" variant="ghost" onClick={() => openLink("settings", { module })}>
      {label} <ArrowUpRight size={12} />
    </GlassButton>
  );
}

const fromStatus = (s: UpdateStatus): SystemUpdates => ({
  current_version: s.current_version ?? s.version,
  latest_version: s.latest_version ?? null,
  update_available: !!s.update_available,
  last_checked: s.last_checked ?? null,
  release_notes_summary: (s.incoming ?? []).slice(0, 3).map((r) => r.subject).join("; ") || null,
  channel: s.branch,
});

function Hostname({ info, onSaved }: { info: SystemInfo; onSaved: () => void }) {
  const { t } = useTranslation();
  const name = info.os?.hostname ?? info.node;
  const [edit, setEdit] = useState<string | null>(null);
  const { busy, error, run } = useRunner();
  const valid = edit !== null && HOSTNAME.test(edit);
  const save = () => valid && run(() => api("/system/hostname", { method: "POST", json: { hostname: edit } })).then((ok) => ok && (setEdit(null), onSaved()));
  if (edit === null)
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono">{name}</span>
        {info.os?.hostname_editable ? (
          <button onClick={() => setEdit(name)} className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-slate-200" aria-label={t("si.renameHost")} title={t("si.renameHost")}>
            <Pencil size={11} />
          </button>
        ) : (
          <span className="text-[10px] text-slate-500" title={t("si.hostnameLocked")}>{t("si.readOnly")}</span>
        )}
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <GlassInput
        autoFocus
        value={edit}
        onChange={(e) => setEdit(e.target.value.toLowerCase())}
        onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && setEdit(null))}
        className="h-7 w-44 font-mono"
        aria-label={t("set.host.hostname")}
        aria-invalid={!valid}
        spellCheck={false}
      />
      <GlassButton size="xs" variant="primary" disabled={!valid || busy} onClick={save} aria-label={t("common.save")}><Check size={12} /></GlassButton>
      <GlassButton size="xs" onClick={() => setEdit(null)} aria-label={t("common.cancel")}><X size={12} /></GlassButton>
      {!valid && <span className="text-[10px] text-amber-300">{t("si.hostnameRule")}</span>}
      {error && <span className="text-[10px] text-rose-300">{error}</span>}
    </span>
  );
}

function OsCard({ info, reload }: { info: SystemInfo; reload: () => void }) {
  const { t } = useTranslation();
  const os = info.os;
  const shareStatus = useUpdateStore((s) => s.apply);
  const [upd, setUpd] = useState<SystemUpdates | undefined>(info.updates);
  const [ask, setAsk] = useState<"reboot" | "shutdown" | null>(null);
  const power = useRunner();
  const check = useRunner();
  useEffect(() => setUpd(info.updates), [info.updates]);
  const runCheck = () => check.run(() => api<UpdateStatus>("/system/updates/status?check=true").then((s) => (shareStatus(s), setUpd(fromStatus(s)))));
  const install = () =>
    check.run(() => api("/system/updates/apply", { method: "POST", json: {} }).then(() => openLink("settings", { module: "system-services", tab: "solardeck" })));
  const send = async () => {
    if (await power.run(() => api("/system/power", { method: "POST", json: { command: ask } }), t(ask === "reboot" ? "si.rebootSent" : "si.shutdownSent", { host: info.node }))) setAsk(null);
  };
  const cluster = os?.cluster_mode && os.cluster_mode !== "standalone" ? `${os.cluster_name ?? os.cluster_mode}` : t("si.standalone");
  return (
    <Section anchor="os-overview" icon={<Server size={15} />} title={os?.product_name ?? info.platform_version} action={os && <GlassBadge tone="info">{os.hypervisor_driver}</GlassBadge>}>
      <Facts
        rows={[
          [t("set.host.hostname"), <Hostname info={info} onSaved={reload} />],
          [t("si.release"), upd?.current_version ? `v${upd.current_version}` : null],
          [t("si.os"), os?.os_pretty_name ?? info.platform_version],
          [t("si.kernel"), os?.kernel_version ?? info.kernel],
          [t("si.arch"), os?.architecture],
          [t("si.boot"), info.boot_mode?.toUpperCase()],
          [t("si.uptime"), uptime(os?.uptime_seconds ?? info.uptime)],
          [t("si.cluster"), cluster],
        ]}
      />
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-white/5 p-3" data-anchor="software-update">
        <CloudDownload size={15} className="text-slate-400" />
        <div className="min-w-0 flex-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-100">{t("si.updates")}</span>
            {upd && (upd.update_available ? <GlassBadge tone="warning">{t("si.updateAvailable", { version: upd.latest_version ?? "" })}</GlassBadge> : <GlassBadge tone="success">{t("si.upToDate")}</GlassBadge>)}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-slate-400" title={upd?.release_notes_summary ?? undefined}>
            {upd?.update_available && upd.release_notes_summary ? upd.release_notes_summary : upd?.last_checked ? t("si.lastChecked", { when: new Date(upd.last_checked).toLocaleString() }) : t("si.neverChecked")}
            {upd?.channel ? ` · ${t("si.channel", { channel: upd.channel })}` : ""}
          </p>
        </div>
        <GlassButton onClick={runCheck} disabled={check.busy}>
          <RefreshCw size={13} className={check.busy ? "animate-spin" : ""} /> {t("si.checkUpdates")}
        </GlassButton>
        {upd?.update_available && (
          <GlassButton variant="primary" onClick={install} disabled={check.busy}>
            <CloudDownload size={13} /> {t("si.installUpdate")}
          </GlassButton>
        )}
        <div className="basis-full">
          <Notice error={check.error} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2" data-anchor="power-actions">
        <GlassButton onClick={() => setAsk("reboot")} disabled={!!power.notice}>
          <RotateCcw size={13} /> {t("si.reboot")}
        </GlassButton>
        <GlassButton variant="danger" onClick={() => setAsk("shutdown")} disabled={!!power.notice}>
          <Power size={13} /> {t("si.shutdown")}
        </GlassButton>
        <p className="min-w-0 flex-1 text-[11px] text-slate-400">{t("si.powerHint")}</p>
      </div>
      <div className="mt-2">
        <Notice notice={power.notice} />
      </div>
      <ConfirmModal
        open={!!ask}
        onClose={() => setAsk(null)}
        onConfirm={send}
        busy={power.busy}
        error={power.error}
        title={t(ask === "reboot" ? "si.rebootTitle" : "si.shutdownTitle")}
        confirmLabel={t(ask === "reboot" ? "si.rebootNow" : "si.shutdownNow")}
        expect={info.node}
        message={t(ask === "shutdown" ? "si.shutdownMsg" : "si.rebootMsg")}
      />
    </Section>
  );
}

function HardwareCards({ info }: { info: SystemInfo }) {
  const { t } = useTranslation();
  const hw = info.hardware;
  if (!hw) return null;
  const { cpu, memory: mem, gpus, storage: st } = hw;
  const n = (v: number | null | undefined) => (v == null ? null : String(v));
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section icon={<Cpu size={15} />} title={t("si.cpu")} action={<DeepLink module="hardware-gpu" label={t("si.details")} />}>
        <Facts
          rows={[
            [t("si.model"), cpu.model],
            [t("si.sockets"), n(cpu.sockets)],
            [t("si.coresThreads"), cpu.physical_cores || cpu.logical_threads ? `${cpu.physical_cores ?? "—"} / ${cpu.logical_threads ?? "—"}` : null],
            [t("si.clock"), cpu.current_freq_mhz ? `${Math.round(cpu.current_freq_mhz)} MHz` : null],
            [t("si.temp"), cpu.temperature_c != null ? <span className={tempColor(cpu.temperature_c)}>{Math.round(cpu.temperature_c)} °C</span> : null],
            [t("si.load"), cpu.load_avg?.length ? cpu.load_avg.map((x) => x.toFixed(2)).join(" · ") : null],
          ]}
        />
      </Section>
      <Section icon={<MemoryStick size={15} />} title={t("si.memory")} action={mem.memory_type_speed && <GlassBadge>{mem.memory_type_speed}</GlassBadge>}>
        <Facts rows={[[t("si.total"), bytes(mem.total_bytes)], [t("si.available"), bytes(mem.available_bytes)], [t("si.arc"), mem.zfs_arc_bytes ? bytes(mem.zfs_arc_bytes) : null]]} />
        <Bar used={mem.used_bytes} total={mem.total_bytes} label={t("si.inUse")} />
        {mem.swap_total_bytes > 0 && <Bar used={mem.swap_used_bytes} total={mem.swap_total_bytes} label={t("si.swap")} />}
      </Section>
      <Section icon={<MonitorCog size={15} />} title={t("si.gpus")} action={<DeepLink module="hardware-gpu" label={t("si.openHardware")} />}>
        {gpus.length ? (
          <ul className="space-y-2">
            {gpus.map((g) => (
              <li key={g.slot} className="rounded-xl bg-white/5 p-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-100" title={g.name}>{g.name}</span>
                  <GlassBadge tone={g.gpu_type === "integrated" ? "neutral" : "info"}>{t(g.gpu_type === "integrated" ? "si.integrated" : "si.discrete")}</GlassBadge>
                  {g.passthrough_bound && <GlassBadge tone="warning">{t("si.passthrough")}</GlassBadge>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-400">
                  <span className="font-mono">{g.slot}</span>
                  {g.vram_total_mb != null && <span>{t("si.vram")}: {g.vram_used_mb != null ? `${bytes(g.vram_used_mb * 1048576)} / ` : ""}{bytes(g.vram_total_mb * 1048576)}</span>}
                  <span>{t("si.driver")}: {g.driver ?? t("si.noDriver")}</span>
                  {g.temperature_c != null && <span className={tempColor(g.temperature_c)}>{Math.round(g.temperature_c)} °C</span>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-400">{t("si.noGpu")}</p>
        )}
      </Section>
      <Section icon={<HardDrive size={15} />} title={t("si.storage")} action={<DeepLink module="storage-zfs" label={t("si.openStorage")} />}>
        <Facts
          rows={[
            [t("si.disks"), String(st.physical_disk_count)],
            [t("si.rawCapacity"), bytes(st.total_raw_bytes)],
            [t("si.smart"), st.physical_disk_count ? <span>{t("si.smartSummary", { ok: st.healthy_disks, bad: st.degraded_disks })}</span> : null],
          ]}
        />
        {st.pools_summary.length > 0 && (
          <ul className="mt-3 space-y-2">
            {st.pools_summary.map((p) => (
              <li key={p.name}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex-1 font-mono text-slate-100">{p.name}</span>
                  <GlassBadge tone={healthTone(p.health)}>{p.health}</GlassBadge>
                </div>
                <Bar used={p.used_bytes} total={p.total_bytes} label={t("si.poolUsed")} />
              </li>
            ))}
          </ul>
        )}
        {!st.pool_count && <p className="mt-2 text-[11px] text-slate-400">{t("si.noPools")}</p>}
      </Section>
    </div>
  );
}

/** Settings › System › Info: OS, release and update state, power, and a hardware overview with deep links. */
export default function SystemInfoPanel() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<SystemInfo>("/system/info").then(setInfo, (e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  if (!info) return error ? <Notice error={error} /> : <p className="text-sm text-slate-400">{t("common.loading")}</p>;
  return (
    <div className="space-y-4">
      <OsCard info={info} reload={load} />
      <HardwareCards info={info} />
      {edition.trademarkNotice && <p className="px-1 text-[11px] leading-snug text-slate-500">{edition.trademarkNotice}</p>}
    </div>
  );
}
