import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, CheckCircle2, CircleAlert, Crown, HardDrive, LogIn, LogOut, Network, Plus, Server, ShieldCheck, Vote, Wrench, XCircle } from "lucide-react";
import { api } from "../../lib/api";
import { bytes, percent } from "../../lib/format";
import { useRunner } from "../../lib/hooks";
import { useTranslation } from "../../i18n";
import { Bar } from "../charts";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, Notice, healthTone } from "../ui/GlassKit";
import { HaModal, JobCard, TokenView, VipsCard, useAgo, useClusterStatus, type ClusterHost, type ClusterStatus, type HaPolicy, type JoinToken, type Workload } from "./ClusterDialogs";

interface Job {
  id: string;
  title: string;
}

function Readiness({ status }: { status: ClusterStatus }) {
  const { t } = useTranslation();
  const checks = status.ready_to_cluster?.checks ?? [];
  return (
    <ul className="space-y-1.5">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 text-xs">
          {c.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-300" /> : c.required ? <XCircle size={14} className="mt-0.5 shrink-0 text-rose-300" /> : <CircleAlert size={14} className="mt-0.5 shrink-0 text-amber-300" />}
          <span>
            <span className="font-medium text-slate-100">{t(`cl.check.${c.id}`)}</span>
            <span className="block text-[11px] text-slate-400">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function StandaloneView({ status, reload }: { status: ClusterStatus; reload: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"create" | "join" | null>(null);
  const [name, setName] = useState("");
  const [iface, setIface] = useState(status.interfaces[0]?.name ?? "");
  const [token, setToken] = useState<JoinToken | null>(null);
  const [joinToken, setJoinToken] = useState("");
  const [job, setJob] = useState<string | null>(null);
  const { busy, error, run } = useRunner();
  const ready = status.ready_to_cluster?.ready ?? false;
  const host = status.hosts[0];
  const close = () => {
    setMode(null);
    setToken(null);
    setJob(null);
    reload();
  };
  return (
    <div className="space-y-4">
      <section className="glass-soft rounded-2xl p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-lg">
            <Server size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-white">{t("cl.standaloneTitle")}</h2>
            <p className="text-xs text-slate-400">{t("cl.standaloneIntro", { host: status.self, n: status.workloads })}</p>
            {host && (
              <p className="mt-1 text-[11px] text-slate-500">
                {host.address} · {t("cl.runningN", { n: host.running })}
              </p>
            )}
          </div>
          <GlassBadge tone={ready ? "success" : "warning"}>{ready ? t("cl.readyYes") : t("cl.readyNo")}</GlassBadge>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto]">
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-300 uppercase">{t("cl.readiness")}</h3>
            <Readiness status={status} />
          </div>
          <div className="flex flex-col justify-end gap-2">
            <GlassButton variant="primary" size="md" disabled={!ready} onClick={() => setMode("create")}>
              <Plus size={14} /> {t("cl.create")}
            </GlassButton>
            <GlassButton size="md" disabled={!ready} onClick={() => setMode("join")}>
              <LogIn size={14} /> {t("cl.join")}
            </GlassButton>
          </div>
        </div>
      </section>
      <p className="text-[11px] text-slate-500">{t("cl.standaloneHint")}</p>

      <GlassModal
        open={mode === "create"}
        onClose={close}
        title={t("cl.createTitle")}
        footer={
          token ? (
            <GlassButton variant="primary" onClick={close}>
              {t("common.done")}
            </GlassButton>
          ) : (
            <GlassButton
              variant="primary"
              disabled={busy || !/^[A-Za-z][A-Za-z0-9-]{0,14}$/.test(name) || !iface}
              onClick={() => run(async () => setToken(await api<JoinToken>("/cluster/create", { method: "POST", json: { name, interface: iface, api_url: window.location.origin } })))}
            >
              {t("cl.createConfirm")}
            </GlassButton>
          )
        }
      >
        {token ? (
          <TokenView token={token} />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-300">{t("cl.createIntro")}</p>
            <Field label={t("cl.clusterName")} hint={t("cl.clusterNameHint")}>
              <GlassInput value={name} onChange={(e) => setName(e.target.value)} placeholder="home-lab" maxLength={15} autoFocus />
            </Field>
            <Field label={t("cl.clusterNetwork")} hint={t("cl.clusterNetworkHint")}>
              <GlassSelect value={iface} onChange={(e) => setIface(e.target.value)}>
                {status.interfaces.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name} · {i.address}
                    {i.dhcp ? " (DHCP)" : ""}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            <Notice error={error} />
          </div>
        )}
      </GlassModal>

      <GlassModal
        open={mode === "join"}
        onClose={close}
        title={t("cl.joinTitle")}
        footer={
          job ? (
            <GlassButton onClick={close}>{t("common.close")}</GlassButton>
          ) : (
            <GlassButton
              variant="primary"
              disabled={busy || joinToken.trim().length < 20}
              onClick={() => run(async () => setJob((await api<{ job_id: string }>("/cluster/join", { method: "POST", json: { token: joinToken.trim() } })).job_id))}
            >
              <LogIn size={13} /> {t("cl.joinConfirm")}
            </GlassButton>
          )
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-300">{t("cl.joinIntro")}</p>
          <Field label={t("cl.joinToken")}>
            <textarea className="input h-28 w-full resize-none font-mono text-[10px]" value={joinToken} onChange={(e) => setJoinToken(e.target.value)} placeholder="SDJ1.…" disabled={!!job} />
          </Field>
          <p className="text-[11px] text-slate-500">{t("cl.joinHint")}</p>
          <Notice error={error} />
          {job && <JobCard jobId={job} title={t("cl.joinTitle")} onDone={(ok) => ok && reload()} />}
        </div>
      </GlassModal>
    </div>
  );
}

function HostCard({ h, onMaintenance, busy }: { h: ClusterHost; onMaintenance: (on: boolean) => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <article className={`glass-soft flex flex-col gap-3 rounded-2xl p-4 ${h.online ? "" : "opacity-70"}`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-white/10 ${h.online ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300"}`}>
          {h.role === "coordinator" ? <Crown size={18} /> : <Server size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-100">{h.name}</span>
            {h.local && <GlassBadge tone="info">{t("cl.thisHost")}</GlassBadge>}
          </div>
          <div className="text-[11px] text-slate-500">
            {h.address} · {h.role === "coordinator" ? t("cl.roleCoordinator") : t("cl.roleMember")}
          </div>
        </div>
        <GlassBadge tone={!h.online ? "danger" : h.maintenance ? "warning" : "success"}>{!h.online ? t("cl.offline") : h.maintenance ? t("cl.maintenance") : t("cl.online")}</GlassBadge>
      </div>
      <div className="grid grid-cols-2 gap-3 text-[11px] text-slate-400 tabular-nums">
        <div>
          <Bar value={h.cpu * 100} />
          <div className="mt-1">
            CPU {(h.cpu * 100).toFixed(0)}%{h.maxcpu ? ` · ${h.maxcpu}` : ""}
          </div>
        </div>
        <div>
          <Bar value={percent(h.mem, h.maxmem)} className="bg-violet-400" />
          <div className="mt-1">
            {bytes(h.mem)} / {bytes(h.maxmem)}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1">
          <HardDrive size={12} /> ZFS {h.zfs ? <GlassBadge tone={healthTone(h.zfs)}>{h.zfs}</GlassBadge> : "—"}
        </span>
        <span>· {t("cl.runningN", { n: h.running })}</span>
        {!h.has_backend && <span className="text-amber-300/90">· {t("cl.noBackend")}</span>}
        {h.clock_skew != null && Math.abs(h.clock_skew) > 2 && <span className="text-amber-300">· {t("cl.clockSkew", { n: h.clock_skew })}</span>}
      </div>
      <GlassButton size="xs" disabled={busy || !h.online} onClick={() => onMaintenance(!h.maintenance)} className="self-start">
        <Wrench size={12} /> {h.maintenance ? t("cl.exitMaintenance") : t("cl.enterMaintenance")}
      </GlassButton>
    </article>
  );
}

function HaMatrix({ status, onConfigure, onSwitchover }: { status: ClusterStatus; onConfigure: (p: { type: "qemu" | "lxc"; vmid: number; name: string }) => void; onSwitchover: (p: HaPolicy) => void }) {
  const { t } = useTranslation();
  const ago = useAgo();
  const [workloads, setWorkloads] = useState<Workload[]>([]);
  const [pick, setPick] = useState("");
  useEffect(() => {
    api<{ workloads: Workload[] }>("/cluster/workloads").then((r) => setWorkloads(r.workloads), () => {});
  }, [status.ha_policies.length]);
  const unprotected = workloads.filter((w) => !status.ha_policies.some((p) => p.key === `${w.type}:${w.vmid}`));
  return (
    <section className="glass-soft space-y-3 rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck size={16} className="text-emerald-300" />
        <h3 className="flex-1 text-sm font-semibold text-white">{t("cl.haMatrix")}</h3>
        <GlassSelect value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("cl.protectPick")} className="w-56">
          <option value="">{t("cl.protectPick")}</option>
          {unprotected.map((w) => (
            <option key={`${w.type}:${w.vmid}`} value={`${w.type}:${w.vmid}`}>
              {w.name} ({w.vmid}) · {w.host}
            </option>
          ))}
        </GlassSelect>
        <GlassButton
          size="sm"
          disabled={!pick}
          onClick={() => {
            const w = unprotected.find((x) => `${x.type}:${x.vmid}` === pick);
            if (w) onConfigure({ type: w.type, vmid: w.vmid, name: w.name });
            setPick("");
          }}
        >
          <Plus size={13} /> {t("cl.configureHa")}
        </GlassButton>
      </div>
      {status.ha_policies.length === 0 ? (
        <p className="text-xs text-slate-400">{t("cl.haEmpty")}</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="py-1.5 font-medium">{t("cl.workload")}</th>
                <th className="font-medium">{t("cl.activeOn")}</th>
                <th className="font-medium">{t("cl.preferredHost")}</th>
                <th className="font-medium">{t("cl.standbyHosts")}</th>
                <th className="font-medium">{t("cl.replication")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.ha_policies.map((p) => (
                <tr key={p.key} className="border-t border-white/5">
                  <td className="py-2">
                    <div className="font-medium text-slate-100">{p.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {p.guest_id} · {p.guest_type === "qemu" ? "VM" : t("cl.container")} · {p.status}
                    </div>
                  </td>
                  <td className="text-slate-200">{p.host ?? "—"}</td>
                  <td className="text-slate-200">
                    {p.preferred_active_host} {p.auto_failback && <GlassBadge tone="info">{t("cl.autoFailbackBadge")}</GlassBadge>}
                  </td>
                  <td className="text-slate-300">{p.passive_standby_hosts.join(", ")}</td>
                  <td>
                    {!p.enabled ? (
                      <GlassBadge>{t("cl.haOff")}</GlassBadge>
                    ) : p.last_sync ? (
                      <GlassBadge tone={p.sync_ok ? "success" : "warning"}>{t("cl.syncedAgo", { ago: ago(p.last_sync) })}</GlassBadge>
                    ) : (
                      <GlassBadge tone="warning">{t("cl.syncPending")}</GlassBadge>
                    )}
                    <div className="mt-0.5 text-[10px] text-slate-500">{p.replication_interval_minutes === 60 ? t("cl.everyHour") : t("cl.everyMin", { n: p.replication_interval_minutes })}</div>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <GlassButton size="xs" variant="ghost" onClick={() => onConfigure({ type: p.guest_type, vmid: p.guest_id, name: p.name })}>
                      {t("cl.configureHa")}
                    </GlassButton>
                    <GlassButton size="xs" disabled={!p.enabled} onClick={() => onSwitchover(p)}>
                      <ArrowRightLeft size={12} /> {t("cl.switchoverNow")}
                    </GlassButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ClusterView({ status, reload }: { status: ClusterStatus; reload: () => void }) {
  const { t } = useTranslation();
  const [token, setToken] = useState<JoinToken | null>(null);
  const [ha, setHa] = useState<{ type: "qemu" | "lxc"; vmid: number; name: string } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [witness, setWitness] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const { busy, error, notice, run } = useRunner(reload);
  const q = status.quorum!;
  const cl = status.cluster!;
  const online = status.hosts.filter((h) => h.online).length;
  const synced = status.ha_policies.filter((p) => p.enabled && p.sync_ok).length;
  const addJob = useCallback((id: string, title: string) => setJobs((j) => [{ id, title }, ...j].slice(0, 6)), []);
  const quorumText = !q.quorate ? t("cl.quorumLost") : q.witness && q.total === 2 ? t("cl.quorumWitness") : t("cl.quorumHealthy", { votes: q.votes, expected: q.expected });
  return (
    <div className="space-y-4">
      <section className="glass-soft rounded-2xl p-5">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-600 text-white shadow-lg">
            <Network size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-white">{cl.name}</h2>
            <p className="text-[11px] text-slate-500">
              {t("cl.coordinator")}: {cl.coordinator}
              {cl.fingerprint && <span className="ml-2 font-mono">{cl.fingerprint.slice(0, 23)}…</span>}
            </p>
          </div>
          <GlassBadge tone={q.quorate ? "success" : "danger"}>
            <Vote size={11} /> {quorumText}
          </GlassBadge>
          <div className="flex gap-4 text-center text-xs">
            <div>
              <div className="text-lg font-bold text-white tabular-nums">
                {online}/{status.hosts.length}
              </div>
              <div className="text-[10px] text-slate-400">{t("cl.activeHosts")}</div>
            </div>
            <div>
              <div className="text-lg font-bold text-white tabular-nums">
                {synced}/{status.ha_policies.length}
              </div>
              <div className="text-[10px] text-slate-400">{t("cl.syncedWorkloads")}</div>
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <GlassButton variant="primary" disabled={busy} onClick={() => run(async () => setToken(await api<JoinToken>("/cluster/token", { method: "POST", json: { ttl_minutes: 60 } })))}>
            {t("cl.addHost")}
          </GlassButton>
          <GlassButton onClick={() => setWitness(q.witness?.url ?? q.witness?.address ?? "")}>
            <Vote size={13} /> {q.witness ? t("cl.witnessEdit") : t("cl.witnessAdd")}
          </GlassButton>
          <GlassButton variant="ghost" className="ml-auto text-rose-300" onClick={() => setLeaving(true)}>
            <LogOut size={13} /> {t("cl.leave")}
          </GlassButton>
        </div>
        {q.total === 2 && !q.witness && <p className="mt-2 text-[11px] text-amber-300/90">{t("cl.twoNodeWarning")}</p>}
        <div className="mt-2">
          <Notice error={error} notice={notice} />
        </div>
      </section>

      {jobs.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2">
          {jobs.map((j) => (
            <JobCard key={j.id} jobId={j.id} title={j.title} onDone={reload} />
          ))}
        </div>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-300 uppercase">{t("cl.hosts")}</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {status.hosts.map((h) => (
            <HostCard
              key={h.name}
              h={h}
              busy={busy}
              onMaintenance={(on) =>
                run(async () => {
                  const r = await api<{ job_id?: string }>(`/cluster/hosts/${h.name}/maintenance`, { method: "POST", json: { enabled: on } });
                  if (r.job_id) addJob(r.job_id, t("cl.drainTitle", { host: h.name }));
                })
              }
            />
          ))}
        </div>
      </section>

      <HaMatrix
        status={status}
        onConfigure={setHa}
        onSwitchover={(p) =>
          run(async () => {
            const r = await api<{ job_id: string; target_host: string }>(`/cluster/ha/${p.guest_type}/${p.guest_id}/switchover`, { method: "POST", json: {} });
            addJob(r.job_id, t("cl.switchoverTitle", { name: p.name, host: r.target_host }));
          })
        }
      />

      <VipsCard status={status} onChanged={reload} />

      <HaModal guest={ha} onClose={() => (setHa(null), reload())} />
      <GlassModal open={!!token} onClose={() => setToken(null)} title={t("cl.addHostTitle")}>
        {token && <TokenView token={token} />}
      </GlassModal>
      <GlassModal
        open={witness !== null}
        onClose={() => setWitness(null)}
        title={t("cl.witnessTitle")}
        footer={
          <>
            {q.witness && (
              <GlassButton variant="ghost" disabled={busy} onClick={() => run(() => api("/cluster/witness", { method: "DELETE" }).then(() => setWitness(null)))}>
                {t("common.delete")}
              </GlassButton>
            )}
            <GlassButton
              variant="primary"
              disabled={busy || !witness}
              onClick={() =>
                run(async () => {
                  const r = await api<{ job_id?: string }>("/cluster/witness", { method: "POST", json: { address: witness } });
                  if (r.job_id) addJob(r.job_id, t("cl.witnessTitle"));
                  setWitness(null);
                })
              }
            >
              {t("common.save")}
            </GlassButton>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-300">{status.native_ha ? t("cl.witnessIntroNative") : t("cl.witnessIntroPlatform")}</p>
          <Field label={t("cl.witnessAddress")}>
            <GlassInput value={witness ?? ""} onChange={(e) => setWitness(e.target.value)} placeholder={status.native_ha ? "http://192.168.1.9" : "192.168.1.9"} />
          </Field>
          <Notice error={error} />
        </div>
      </GlassModal>
      <ConfirmModal
        open={leaving}
        onClose={() => setLeaving(false)}
        title={t("cl.leaveTitle")}
        message={t("cl.leaveMsg", { name: cl.name })}
        expect={cl.name}
        confirmLabel={t("cl.leave")}
        busy={busy}
        error={error}
        onConfirm={() =>
          run(async () => {
            const r = await api<{ job_id: string }>("/cluster/leave", { method: "POST" });
            addJob(r.job_id, t("cl.leaveTitle"));
            setLeaving(false);
          })
        }
      />
    </div>
  );
}

/** Settings → Hypervisor & Runtime → Cluster & High Availability. */
export default function ClusterManagerPanel() {
  const { t } = useTranslation();
  const { status, error, reload } = useClusterStatus(4000);
  if (error && !status) return <Notice error={error} />;
  if (!status) return <p className="text-sm text-slate-400">{t("common.loading")}</p>;
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-white">{t("cl.title")}</h2>
        <p className="text-xs text-slate-400">{t("cl.intro")}</p>
      </header>
      {!status.supported ? <Notice error={t("cl.unsupported")} /> : status.mode === "cluster" ? <ClusterView status={status} reload={reload} /> : <StandaloneView status={status} reload={reload} />}
    </div>
  );
}
