import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Box, Network, Server, ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { useTranslation, type TKey } from "../../i18n";
import { GlassBadge, GlassButton, GlassSelect, GlassSwitch, Notice, Segmented } from "./GlassKit";
import { OperationProgressCard, useJobProgress } from "./OperationProgressCard";

export type ModuleKey = "reverse_proxy" | "offsite_backup" | "image_hub" | "ups_power" | "oob_bmc" | "vlan_firewall" | "storage_protocols" | "rbac_users" | "docker_engine";
type Runtime = "container" | "host_native";
type Isolation = "management" | "vlan" | "dmz" | "isolated_lab";
const HARDENING = ["read_only_rootfs", "drop_capabilities", "non_root_user", "auto_firewall_rules", "audit_logging"] as const;

export interface ModuleProfile {
  module_id: ModuleKey;
  enabled: boolean;
  runtime_mode: Runtime;
  recommended_runtime_mode: Runtime;
  supported_runtime_modes: Runtime[];
  network_isolation_mode: Isolation;
  bound_bridge: string;
  bound_vlan_id: number | null;
  service_ip: string | null;
  security_hardening: Record<(typeof HARDENING)[number], boolean>;
}

interface SwitchInfo {
  bridges: { name: string }[];
  vlans: { vlan_id: number; name: string; bridge: string; lab?: string }[];
}

const posture = (p: ModuleProfile): [TKey, "success" | "info" | "warning" | "neutral"] =>
  p.runtime_mode === "container" && p.network_isolation_mode !== "management"
    ? ["sdm.posture.isolated", "success"]
    : p.runtime_mode === "container"
      ? ["sdm.posture.contained", "info"]
      : p.network_isolation_mode !== "management"
        ? ["sdm.posture.host", "info"]
        : ["sdm.posture.exposed", "neutral"];

/**
 * Security-by-Design banner at the top of every optional module: on/off switch, Isolated Container vs Host Native
 * (only the modes the module supports), and the network it is pinned to (management, a VLAN, the DMZ or an isolated
 * lab). `children` renders below it once the module is on, and receives the live profile.
 */
export function SecurityModuleHeader({ module, children, compact = false }: { module: ModuleKey; children?: (p: ModuleProfile) => ReactNode; compact?: boolean }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<ModuleProfile | null>(null);
  const [draft, setDraft] = useState<ModuleProfile | null>(null);
  const [sw, setSw] = useState<SwitchInfo | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(
    () =>
      api<ModuleProfile>(`/platform/modules/${module}`).then((p) => {
        setSaved(p);
        setDraft(p);
      }),
    [module],
  );
  useEffect(() => void run(load), [run, load]);
  useEffect(() => {
    api<SwitchInfo>("/network/switch/state").then(setSw, () => setSw(null));
  }, []);
  const placed = useCallback(
    (ok: boolean) => {
      if (ok) void run(() => api(`/platform/modules/${module}/place`, { method: "POST" }).then(load), t("sdm.saved"));
    },
    [run, module, load, t],
  );

  if (!draft || !saved) return <Notice error={error} />;
  const set = (patch: Partial<ModuleProfile>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = (next = draft) =>
    run(async () => {
      const r = await api<ModuleProfile & { job_id: string | null }>(`/platform/modules/${module}`, { method: "PUT", json: next });
      setJob(r.job_id);
      await load();
    }, t("sdm.saved"));
  const [label, tone] = posture(saved);
  const vlans = (sw?.vlans ?? []).filter((v) => !draft.bound_bridge || v.bridge === draft.bound_bridge);
  const labs = (sw?.vlans ?? []).filter((v) => v.lab);
  const nets: { id: Isolation; label: string }[] = [
    { id: "management", label: t("sdm.management") },
    { id: "vlan", label: t("sdm.vlan") },
    { id: "dmz", label: t("sdm.dmz") },
    { id: "isolated_lab", label: t("sdm.lab") },
  ];

  return (
    <div className="space-y-4">
      <section className="glass-soft rounded-2xl p-4" aria-label={t(`sdm.m.${module}`)}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-400 to-violet-600 text-white shadow-lg shadow-black/30">
            <ShieldCheck size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-white">{t(`sdm.m.${module}`)}</h3>
            <GlassBadge tone={saved.enabled ? tone : "neutral"}>{saved.enabled ? t(label) : t("sdm.disabled")}</GlassBadge>
          </div>
          <GlassSwitch checked={draft.enabled} label={t("sdm.enabled")} disabled={busy} onChange={(enabled) => (dirty ? set({ enabled }) : void save({ ...draft, enabled }))} />
        </div>
        {!compact && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                <Box size={12} /> {t("sdm.runtime")}
              </p>
              <div className="flex flex-wrap gap-2">
                {(["container", "host_native"] as Runtime[]).map((m) => {
                  const ok = draft.supported_runtime_modes.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={!ok}
                      title={ok ? undefined : t("sdm.unsupported")}
                      aria-pressed={draft.runtime_mode === m}
                      onClick={() => set({ runtime_mode: m })}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs ring-1 transition disabled:cursor-not-allowed disabled:opacity-35 ${draft.runtime_mode === m ? "bg-white/15 text-white ring-white/25" : "text-slate-300 ring-white/10 hover:bg-white/5"}`}
                    >
                      {m === "container" ? <Box size={12} /> : <Server size={12} />}
                      {m === "container" ? t("sdm.container") : t("sdm.hostNative")}
                      {m === draft.recommended_runtime_mode && <span className="text-emerald-300">{t("sdm.recommended")}</span>}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 mb-1.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t("sdm.hardening")}</p>
              <div className="flex flex-wrap gap-1.5">
                {HARDENING.map((h) => (
                  <button
                    key={h}
                    type="button"
                    aria-pressed={draft.security_hardening[h]}
                    onClick={() => set({ security_hardening: { ...draft.security_hardening, [h]: !draft.security_hardening[h] } })}
                    className={`rounded-full px-2 py-0.5 text-[10px] ring-1 ${draft.security_hardening[h] ? "bg-emerald-400/15 text-emerald-200 ring-emerald-300/25" : "text-slate-500 ring-white/10"}`}
                  >
                    {t(`sdm.h.${h}`)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                <Network size={12} /> {t("sdm.network")}
              </p>
              <Segmented value={draft.network_isolation_mode} onChange={(v) => set({ network_isolation_mode: v, bound_vlan_id: v === "management" ? null : draft.bound_vlan_id })} options={nets} />
              {draft.network_isolation_mode !== "management" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <GlassSelect aria-label={t("sdm.switch")} value={draft.bound_bridge} onChange={(e) => set({ bound_bridge: e.target.value, bound_vlan_id: null })}>
                    {(sw?.bridges ?? [{ name: draft.bound_bridge }]).map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </GlassSelect>
                  <GlassSelect
                    aria-label={t("sdm.vlanId")}
                    value={draft.bound_vlan_id ?? ""}
                    onChange={(e) => {
                      const vid = e.target.value ? Number(e.target.value) : null;
                      const v = (sw?.vlans ?? []).find((x) => x.vlan_id === vid);
                      set({ bound_vlan_id: vid, bound_bridge: v?.bridge ?? draft.bound_bridge });
                    }}
                  >
                    <option value="">{t("sdm.noVlan")}</option>
                    {draft.bound_vlan_id && !(sw?.vlans ?? []).some((v) => v.vlan_id === draft.bound_vlan_id) && (
                      <option value={draft.bound_vlan_id}>{`VLAN ${draft.bound_vlan_id}`}</option>
                    )}
                    {(draft.network_isolation_mode === "isolated_lab" ? labs : vlans).map((v) => (
                      <option key={v.vlan_id} value={v.vlan_id}>
                        {`VLAN ${v.vlan_id} · ${v.name}`}
                      </option>
                    ))}
                  </GlassSelect>
                </div>
              )}
              {saved.service_ip && (
                <p className="mt-2 text-[11px] text-slate-400">
                  {t("sdm.serviceIp")}: <span className="font-mono text-slate-200">{saved.service_ip}</span>
                </p>
              )}
              {draft.network_isolation_mode !== "management" && <p className="mt-2 text-[10px] leading-snug text-slate-500">{t("sdm.pinHint")}</p>}
            </div>
          </div>
        )}
        {(dirty || error || notice) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {dirty && (
              <GlassButton variant="primary" disabled={busy} onClick={() => void save()}>
                {t("sdm.save")}
              </GlassButton>
            )}
            <Notice error={error} notice={notice} />
          </div>
        )}
        {job && <DeployProgress job={job} onDone={placed} onDismiss={() => setJob(null)} />}
      </section>
      {saved.enabled ? children?.(saved) : !compact && <p className="px-1 text-xs text-slate-400">{t("sdm.off")}</p>}
    </div>
  );
}

/** The worker container's deployment; mounted only while there is a job, so nothing is polled otherwise. */
function DeployProgress({ job, onDone, onDismiss }: { job: string; onDone: (ok: boolean) => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const progress = useJobProgress(`/tasks/${job}`, true, onDone);
  return progress && <OperationProgressCard className="mt-3" title={t("sdm.deploying")} progress={progress} onDismiss={onDismiss} />;
}

/** Settings > Privilege & Security > Security-by-Design Modules: every module's header in one list. */
export function PlatformModulesOverview() {
  const { t } = useTranslation();
  const all: ModuleKey[] = ["reverse_proxy", "offsite_backup", "image_hub", "ups_power", "oob_bmc", "vlan_firewall", "storage_protocols", "rbac_users", "docker_engine"];
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">{t("sdm.overviewIntro")}</p>
      {all.map((m) => (
        <SecurityModuleHeader key={m} module={m} />
      ))}
    </div>
  );
}
