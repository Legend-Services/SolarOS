import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, Check, Copy, Globe, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { usePoll, useRunner } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation } from "../../i18n";
import { Field, GlassBadge, GlassButton, GlassCheckbox, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../ui/GlassKit";
import { OperationProgressCard, useJobProgress } from "../ui/OperationProgressCard";

/* Shapes of /api/cluster (backend/app/cluster.py). */
export interface ClusterHost {
  name: string;
  address: string;
  role: "coordinator" | "member" | "standalone";
  online: boolean;
  maintenance: boolean;
  local: boolean;
  has_backend: boolean;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  zfs: string | null;
  running: number;
  guests: number;
  clock_skew?: number | null;
}
export interface SyncState {
  at: number;
  ok: boolean;
  error?: string | null;
}
export interface HaPolicy {
  key: string;
  guest_type: "qemu" | "lxc";
  guest_id: number;
  name: string;
  enabled: boolean;
  preferred_active_host: string;
  passive_standby_hosts: string[];
  replication_interval_minutes: 1 | 5 | 15 | 60;
  failover_timeout_seconds: number;
  auto_failback: boolean;
  host?: string;
  status: string;
  last_sync: number | null;
  sync_ok: boolean;
  sync: Record<string, SyncState>;
  last_failover?: { at: number; from: string; to: string };
}
export interface Vip {
  id: string;
  vrid: number;
  address: string;
  bridge: string;
  vlan: number | null;
  preferred_host: string;
  label: string;
}
export interface ReadyCheck {
  id: "network" | "ntp" | "zfs" | "ssh";
  ok: boolean;
  required: boolean;
  detail: string;
}
export interface ClusterStatus {
  mode: "standalone" | "cluster";
  driver: string;
  supported: boolean;
  self: string;
  native_ha: boolean;
  ready_to_cluster?: { ready: boolean; checks: ReadyCheck[] };
  interfaces: { name: string; address: string; dhcp: boolean }[];
  hosts: ClusterHost[];
  workloads: number;
  ha_policies: HaPolicy[];
  vips: Vip[];
  clustered_switches: string[];
  quorum: null | { quorate: boolean; votes: number; expected: number; online: number; total: number; witness: null | { type: string; url?: string; address?: string } };
  cluster?: { name: string; id: string; coordinator: string; fingerprint: string | null; created: number };
}
export interface Workload extends Guest {
  host: string;
  ha?: boolean;
}
export interface JoinToken {
  join_token: string;
  expires: number;
  cluster_ip: string;
  fingerprint: string | null;
  qr_svg: string;
}

export function useClusterStatus(ms = 5000, active = true) {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    if (active) api<ClusterStatus>("/cluster/status").then((r) => (setStatus(r), setError("")), (e) => setError(e.message));
  }, [active]);
  usePoll(reload, ms);
  return { status, error, reload };
}

/** "42s ago" / "5m ago" / "3h ago" for a unix time. */
export function useAgo() {
  const { t } = useTranslation();
  return (at: number | null | undefined) => {
    if (!at) return t("cl.never");
    const s = Math.max(0, Math.round(Date.now() / 1000 - at));
    return s < 60 ? t("cl.agoS", { n: s }) : s < 3600 ? t("cl.agoM", { n: Math.round(s / 60) }) : t("cl.agoH", { n: Math.round(s / 3600) });
  };
}

/** Live progress of a cluster job (migration, drain, failover, join) via the unified task progress API. */
export function JobCard({ jobId, title, onDone }: { jobId: string; title: string; onDone?: (ok: boolean) => void }) {
  const p = useJobProgress(`/tasks/${jobId}`, true, onDone);
  return p ? <OperationProgressCard title={title} progress={p} /> : null;
}

const usable = (h: ClusterHost) => h.online && !h.maintenance;

export function MigrateModal({ guest, onClose }: { guest: Workload | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { status } = useClusterStatus(5000, !!guest);
  const [target, setTarget] = useState("");
  const [live, setLive] = useState(true);
  const [job, setJob] = useState<string | null>(null);
  const { busy, error, run } = useRunner();
  const others = (status?.hosts ?? []).filter((h) => h.name !== guest?.host);
  useEffect(() => {
    setJob(null);
    setLive(true);
  }, [guest]);
  useEffect(() => {
    if (!target || !others.some((h) => h.name === target && usable(h))) setTarget(others.find(usable)?.name ?? "");
  }, [others, target]);
  if (!guest) return null;
  const go = () =>
    run(async () => {
      const r = await api<{ job_id: string }>(`/cluster/workloads/${guest.type}/${guest.vmid}/migrate`, {
        method: "POST",
        json: { target_host: target, online: live, with_local_disks: true },
      });
      setJob(r.job_id);
    });
  return (
    <GlassModal
      open
      onClose={onClose}
      title={t("cl.migrateTitle", { name: guest.name })}
      footer={
        job ? (
          <GlassButton onClick={onClose}>{t("common.close")}</GlassButton>
        ) : (
          <>
            <GlassButton variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </GlassButton>
            <GlassButton variant="primary" disabled={!target || busy} onClick={go}>
              <ArrowRightLeft size={13} /> {t("cl.migrateStart")}
            </GlassButton>
          </>
        )
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-300">{t("cl.migrateFrom", { name: guest.name, host: guest.host })}</p>
        <Field label={t("cl.targetHost")}>
          <GlassSelect value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!job}>
            {others.length === 0 && <option value="">{t("cl.noOtherHosts")}</option>}
            {others.map((h) => (
              <option key={h.name} value={h.name} disabled={!usable(h)}>
                {h.name} · {h.address}
                {!h.online ? ` · ${t("cl.offline")}` : h.maintenance ? ` · ${t("cl.maintenance")}` : ""}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <GlassSwitch checked={live} onChange={setLive} disabled={!!job} label={t("cl.liveMigration")} />
        <p className="text-[11px] text-slate-500">{guest.type === "lxc" ? t("cl.liveHintCt") : t("cl.liveHintVm")}</p>
        <Notice error={error} />
        {job && <JobCard jobId={job} title={t("cl.migrateTitle", { name: guest.name })} />}
      </div>
    </GlassModal>
  );
}

const INTERVALS = [1, 5, 15, 60] as const;

export function HaPolicyForm({ guestType, guestId, onSaved }: { guestType: "qemu" | "lxc"; guestId: number; onSaved?: () => void }) {
  const { t } = useTranslation();
  const ago = useAgo();
  const { status } = useClusterStatus(10000);
  const [pol, setPol] = useState<Partial<HaPolicy> | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Partial<HaPolicy>>(`/cluster/ha/${guestType}/${guestId}`).then(setPol, () => setPol({ enabled: false }));
  }, [guestType, guestId]);
  useEffect(load, [load]);
  const { busy, error, notice, run } = useRunner(() => (load(), onSaved?.()));
  const hosts = status?.hosts ?? [];
  if (!pol || !status) return <p className="text-sm text-slate-400">{t("common.loading")}</p>;
  if (status.mode !== "cluster") return <Notice notice={t("cl.haNeedsCluster")} />;
  const exists = pol.preferred_active_host !== undefined;
  const preferred = pol.preferred_active_host ?? pol.host ?? status.self;
  const standbys = pol.passive_standby_hosts ?? [];
  const set = (p: Partial<HaPolicy>) => setPol((x) => ({ ...x, ...p }));
  const save = () =>
    run(
      () =>
        api(`/cluster/ha/${guestType}/${guestId}`, {
          method: "PUT",
          json: {
            enabled: true,
            preferred_active_host: preferred,
            passive_standby_hosts: standbys,
            replication_interval_minutes: pol.replication_interval_minutes ?? 5,
            failover_timeout_seconds: pol.failover_timeout_seconds ?? 15,
            auto_failback: pol.auto_failback ?? false,
          },
        }),
      t("cl.haSaved"),
    );
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-400">{t("cl.haIntro")}</p>
      <Field label={t("cl.preferredHost")} hint={t("cl.preferredHint")}>
        <GlassSelect value={preferred} onChange={(e) => set({ preferred_active_host: e.target.value, passive_standby_hosts: standbys.filter((h) => h !== e.target.value) })}>
          {hosts.map((h) => (
            <option key={h.name} value={h.name}>
              {h.name}
            </option>
          ))}
        </GlassSelect>
      </Field>
      <Field label={t("cl.standbyHosts")} hint={t("cl.standbyHint")}>
        <div className="flex flex-wrap gap-3">
          {hosts
            .filter((h) => h.name !== preferred)
            .map((h) => (
              <GlassCheckbox
                key={h.name}
                checked={standbys.includes(h.name)}
                onChange={(on) => set({ passive_standby_hosts: on ? [...standbys, h.name] : standbys.filter((x) => x !== h.name) })}
                label={h.name}
              />
            ))}
          {hosts.length < 2 && <span className="text-[11px] text-amber-300">{t("cl.needTwoHosts")}</span>}
        </div>
      </Field>
      <Field label={t("cl.syncInterval")} hint={status.native_ha ? t("cl.syncHintNative") : t("cl.syncHintPlatform")}>
        <Segmented
          value={String(pol.replication_interval_minutes ?? 5)}
          onChange={(v) => set({ replication_interval_minutes: Number(v) as HaPolicy["replication_interval_minutes"] })}
          options={INTERVALS.map((m) => ({ id: String(m), label: m === 60 ? t("cl.everyHour") : t("cl.everyMin", { n: m }) }))}
        />
      </Field>
      <Field label={t("cl.failoverTimeout", { n: pol.failover_timeout_seconds ?? 15 })} hint={status.native_ha ? t("cl.timeoutHint") : t("cl.timeoutHintPlatform")}>
        <GlassInput type="range" min={10} max={120} step={5} value={pol.failover_timeout_seconds ?? 15} onChange={(e) => set({ failover_timeout_seconds: Number(e.target.value) })} className="w-full" />
      </Field>
      <GlassSwitch checked={pol.auto_failback ?? false} onChange={(v) => set({ auto_failback: v })} label={t("cl.autoFailback")} />
      <p className="text-[11px] text-slate-500">{t("cl.autoFailbackHint")}</p>
      {exists && pol.last_sync !== undefined && (
        <p className="text-[11px] text-slate-400">
          {t("cl.lastSync")}: {ago(pol.last_sync)} {pol.sync_ok === false && pol.last_sync !== null && <GlassBadge tone="warning">{t("cl.syncIssue")}</GlassBadge>}
        </p>
      )}
      <Notice error={error} notice={notice} />
      {job && <JobCard jobId={job} title={t("cl.switchover")} onDone={load} />}
      <div className="flex flex-wrap justify-end gap-2">
        {exists && (
          <>
            <GlassButton
              variant="ghost"
              disabled={busy}
              onClick={() => run(() => api(`/cluster/ha/${guestType}/${guestId}`, { method: "DELETE" }), t("cl.haRemoved"))}
            >
              {t("cl.haDisable")}
            </GlassButton>
            <GlassButton
              disabled={busy || !!job}
              onClick={() =>
                run(async () => {
                  const r = await api<{ job_id: string }>(`/cluster/ha/${guestType}/${guestId}/switchover`, { method: "POST", json: {} });
                  setJob(r.job_id);
                })
              }
            >
              <ArrowRightLeft size={13} /> {t("cl.switchoverNow")}
            </GlassButton>
          </>
        )}
        <GlassButton variant="primary" disabled={busy || standbys.length === 0} onClick={save}>
          <ShieldCheck size={13} /> {exists ? t("common.save") : t("cl.haEnable")}
        </GlassButton>
      </div>
    </div>
  );
}

export function HaModal({ guest, onClose }: { guest: { type: "qemu" | "lxc"; vmid: number; name: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <GlassModal open={!!guest} onClose={onClose} title={guest ? t("cl.haTitle", { name: guest.name }) : ""}>
      {guest && <HaPolicyForm guestType={guest.type} guestId={guest.vmid} />}
    </GlassModal>
  );
}

export function VipsCard({ status, onChanged }: { status: ClusterStatus; onChanged: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({ address: "", bridge: status.clustered_switches[0] ?? "", vlan: "", preferred_host: status.self, label: "" });
  const { busy, error, notice, run } = useRunner(onChanged);
  const result = (r: { ok: boolean; errors: Record<string, string> }) => {
    if (!r.ok) throw new Error(Object.entries(r.errors).map(([h, e]) => `${h}: ${e}`).join(" · "));
  };
  return (
    <section className="glass-soft space-y-3 rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <Globe size={16} className="text-sky-300" />
        <h3 className="flex-1 text-sm font-semibold text-white">{t("cl.vips")}</h3>
      </div>
      <p className="text-[11px] text-slate-400">{t("cl.vipsIntro")}</p>
      {status.vips.length > 0 && (
        <table className="w-full text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-1 font-medium">{t("cl.vipAddress")}</th>
              <th className="py-1 font-medium">{t("cl.vipSwitch")}</th>
              <th className="py-1 font-medium">{t("cl.preferredHost")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.vips.map((v) => (
              <tr key={v.id} className="border-t border-white/5">
                <td className="py-1.5 font-mono text-slate-100">
                  {v.address} {v.label && <span className="ml-1 font-sans text-slate-500">{v.label}</span>}
                </td>
                <td className="text-slate-300">
                  {v.bridge}
                  {v.vlan ? ` · VLAN ${v.vlan}` : ""}
                </td>
                <td className="text-slate-300">{v.preferred_host}</td>
                <td className="text-right">
                  <GlassButton
                    size="xs"
                    variant="ghost"
                    aria-label={t("common.delete")}
                    disabled={busy}
                    onClick={() => run(async () => result(await api(`/cluster/vips/${v.id}`, { method: "DELETE" })))}
                  >
                    <Trash2 size={12} />
                  </GlassButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="grid gap-2 sm:grid-cols-5">
        <GlassInput placeholder="192.168.1.50/24" aria-label={t("cl.vipAddress")} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} className="sm:col-span-2" />
        <GlassInput list="cl-switches" placeholder={t("cl.vipSwitch")} aria-label={t("cl.vipSwitch")} value={draft.bridge} onChange={(e) => setDraft({ ...draft, bridge: e.target.value })} />
        <datalist id="cl-switches">
          {status.clustered_switches.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <GlassInput placeholder={t("cl.vipVlan")} aria-label={t("cl.vipVlan")} inputMode="numeric" value={draft.vlan} onChange={(e) => setDraft({ ...draft, vlan: e.target.value.replace(/\D/g, "") })} />
        <GlassSelect aria-label={t("cl.preferredHost")} value={draft.preferred_host} onChange={(e) => setDraft({ ...draft, preferred_host: e.target.value })}>
          {status.hosts.map((h) => (
            <option key={h.name} value={h.name}>
              {h.name}
            </option>
          ))}
        </GlassSelect>
      </div>
      <div className="flex items-center gap-2">
        <GlassInput placeholder={t("cl.vipLabel")} aria-label={t("cl.vipLabel")} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} className="flex-1" />
        <GlassButton
          variant="primary"
          disabled={busy || !draft.address || !draft.bridge}
          onClick={() =>
            run(async () => {
              result(await api("/cluster/vips", { method: "POST", json: { ...draft, vlan: draft.vlan ? Number(draft.vlan) : null } }));
              setDraft({ ...draft, address: "", label: "" });
            }, t("cl.vipAdded"))
          }
        >
          <Plus size={13} /> {t("cl.vipAdd")}
        </GlassButton>
      </div>
      {status.clustered_switches.length === 0 && <p className="text-[11px] text-amber-300/90">{t("cl.vipNoSwitch")}</p>}
      <Notice error={error} notice={notice} />
    </section>
  );
}

/** Self-loading VIP card for places outside the Cluster panel (Visual Switch). */
export function VipsPanel() {
  const { t } = useTranslation();
  const { status, error, reload } = useClusterStatus(10000);
  if (error) return <Notice error={error} />;
  if (!status) return <p className="text-sm text-slate-400">{t("common.loading")}</p>;
  return status.mode === "cluster" ? <VipsCard status={status} onChanged={reload} /> : <Notice notice={t("cl.vipNeedsCluster")} />;
}

export function TokenView({ token }: { token: JoinToken }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(token.join_token).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)));
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-300">{t("cl.tokenIntro")}</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="mx-auto w-40 shrink-0 rounded-xl bg-white p-2" aria-label={t("cl.tokenQr")} role="img" dangerouslySetInnerHTML={{ __html: token.qr_svg }} />
        <div className="min-w-0 flex-1 space-y-2">
          <textarea readOnly value={token.join_token} aria-label={t("cl.joinToken")} className="input h-24 w-full resize-none font-mono text-[10px] break-all" onFocus={(e) => e.target.select()} />
          <GlassButton variant="primary" onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t("cl.copied") : t("cl.copyToken")}
          </GlassButton>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-slate-500">{t("cl.clusterIp")}</dt>
        <dd className="font-mono text-slate-200">{token.cluster_ip}</dd>
        {token.fingerprint && (
          <>
            <dt className="text-slate-500">{t("cl.fingerprint")}</dt>
            <dd className="font-mono break-all text-slate-200">{token.fingerprint}</dd>
          </>
        )}
        <dt className="text-slate-500">{t("cl.expires")}</dt>
        <dd className="text-slate-200">{new Date(token.expires * 1000).toLocaleString()}</dd>
      </dl>
    </div>
  );
}
