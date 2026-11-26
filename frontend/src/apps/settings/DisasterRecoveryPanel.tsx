import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CloudUpload, Download, Pencil, Plus, RefreshCw, RotateCcw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { api } from "../../lib/api";
import type { BackupsInfo } from "../../lib/types";
import { bytes } from "../../lib/format";
import { useRunner } from "../../lib/hooks";
import { useTelemetry } from "../../lib/stores";
import { useTranslation } from "../../i18n";
import { Card } from "../ControlPanelApp";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../../components/ui/GlassKit";
import { JobCard } from "../../components/cluster/ClusterDialogs";

interface Snap {
  name: string;
  size: number;
  created: number;
}
interface Verification {
  backup: string;
  vmid: number;
  started: number;
  booted: boolean;
  heartbeat: boolean;
  ok: boolean;
  seconds_to_heartbeat: number | null;
}
interface Status {
  local_snapshots: number;
  latest_snapshot: Snap | null;
  offsite_targets: number;
  offsite_ok: number;
  verifications: Verification[];
}
type Kind = "s3" | "sftp" | "webdav";
interface Target {
  id: string;
  name: string;
  type: Kind;
  endpoint: string;
  bucket: string;
  region: string;
  access_key_id: string;
  username: string;
  port: number;
  include_hypervisor_backups: boolean;
  retention_days: number;
  secret_access_key_set: boolean;
  password_set: boolean;
  last_run: { at: number; ok: boolean } | null;
}
type Draft = Omit<Target, "id" | "secret_access_key_set" | "password_set" | "last_run"> & { secret_access_key: string; password: string };

const when = (s: number) => new Date(s * 1000).toLocaleString();

/** Settings > Backups & Disaster Recovery: encrypted host snapshots, 3-2-1 offsite copies and sandbox restore checks. */
export default function DisasterRecoveryPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const loadStatus = useCallback(() => void api<Status>("/dr/status").then(setStatus, () => {}), []);
  useEffect(loadStatus, [loadStatus]);
  return (
    <div className="space-y-4">
      <StatusCard s={status} />
      <Snapshots onChange={loadStatus} />
      <Offsite onChange={loadStatus} />
      <Sandbox onChange={loadStatus} />
    </div>
  );
}

function StatusCard({ s }: { s: Status | null }) {
  const { t } = useTranslation();
  const last = s?.verifications[0];
  const tile = (label: string, value: string, sub: string, ok: boolean) => (
    <div className="glass-field rounded-xl p-3">
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        {label}
        <GlassBadge tone={ok ? "success" : "warning"} className="ml-auto">
          {ok ? t("dr.ok") : t("dr.missing")}
        </GlassBadge>
      </div>
      <div className="mt-1 text-lg font-semibold text-white tabular-nums">{value}</div>
      <div className="truncate text-[11px] text-slate-500">{sub}</div>
    </div>
  );
  return (
    <Card title={t("dr.status.title")}>
      <p className="mb-3 text-[11px] text-slate-400">{t("dr.status.rule")}</p>
      {!s ? (
        <p className="text-xs text-slate-400">{t("common.loading")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          {tile(t("dr.status.local"), String(s.local_snapshots), s.latest_snapshot ? t("dr.status.latest", { when: when(s.latest_snapshot.created) }) : t("dr.snap.none"), s.local_snapshots > 0)}
          {tile(t("dr.status.offsite"), `${s.offsite_ok} / ${s.offsite_targets}`, t("dr.status.offsiteSub"), s.offsite_ok > 0)}
          {tile(t("dr.status.sandbox"), String(s.verifications.filter((v) => v.ok).length), last ? t("dr.status.lastCheck", { when: when(last.started) }) : t("dr.sb.none"), !!last?.ok)}
        </div>
      )}
    </Card>
  );
}

function Snapshots({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation();
  const [snaps, setSnaps] = useState<Snap[] | null>(null);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [label, setLabel] = useState("");
  const [del, setDel] = useState<Snap | null>(null);
  const [restore, setRestore] = useState<Snap | null>(null);
  const load = useCallback(() => api<{ snapshots: Snap[] }>("/dr/host-snapshots").then((r) => setSnaps(r.snapshots)), []);
  const { busy, error, notice, run } = useRunner(onChange);
  useEffect(() => void run(load), [run, load]);

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api("/dr/host-snapshot", { method: "POST", json: { passphrase: pass, label } });
      setPass("");
      setPass2("");
      setLabel("");
      await load();
    }, t("dr.snap.created"));
  };
  const upload = (file?: File) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    run(() => api("/dr/host-snapshots/upload", { method: "POST", body: form }).then(load), t("dr.snap.uploaded"));
  };
  const passOk = pass.length >= 12 && pass === pass2;

  return (
    <Card
      title={t("dr.snap.title")}
      action={
        <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10 ${busy ? "pointer-events-none opacity-50" : ""}`}>
          <Upload size={12} /> {t("dr.snap.upload")}
          <input type="file" accept=".sddr" className="sr-only" disabled={busy} onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ""))} />
        </label>
      }
    >
      <div data-anchor="dr-snapshots" className="space-y-3">
        <p className="text-[11px] text-slate-400">{t("dr.snap.hint")}</p>
        <form onSubmit={create} className="grid gap-2 sm:grid-cols-[1fr_1fr_160px_auto] sm:items-end">
          <Field label={t("dr.passphrase")} hint={pass && pass.length < 12 ? t("dr.passShort") : undefined}>
            <GlassInput className="w-full" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
          <Field label={t("dr.passConfirm")} hint={pass2 && pass !== pass2 ? t("dr.passMismatch") : undefined}>
            <GlassInput className="w-full" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </Field>
          <Field label={t("dr.snap.label")}>
            <GlassInput className="w-full" placeholder="before-upgrade" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
          </Field>
          <GlassButton type="submit" variant="primary" disabled={busy || !passOk}>
            <Plus size={13} /> {t("dr.snap.create")}
          </GlassButton>
        </form>
        <Notice error={error} notice={notice} />
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1.5 font-medium">{t("dr.name")}</th>
              <th className="px-2 font-medium">{t("dr.size")}</th>
              <th className="px-2 font-medium">{t("dr.date")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {snaps?.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-slate-400">
                  {t("dr.snap.none")}
                </td>
              </tr>
            )}
            {snaps?.map((s) => (
              <tr key={s.name} className="border-t border-white/5">
                <td className="py-1.5 font-mono text-slate-100">{s.name}</td>
                <td className="px-2 text-slate-300 tabular-nums">{bytes(s.size)}</td>
                <td className="px-2 text-slate-300">{when(s.created)}</td>
                <td className="text-right whitespace-nowrap">
                  <a className="inline-flex rounded-lg px-2 py-1 text-slate-200 hover:bg-white/10" href={`/api/dr/host-snapshots/${encodeURIComponent(s.name)}`} download title={t("dr.download")} aria-label={t("dr.download")}>
                    <Download size={12} />
                  </a>
                  <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => setRestore(s)} title={t("dr.restore")} aria-label={t("dr.restore")}>
                    <RotateCcw size={12} />
                  </GlassButton>
                  <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => setDel(s)} title={t("common.delete")} aria-label={t("common.delete")}>
                    <Trash2 size={12} />
                  </GlassButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        title={t("dr.snap.deleteTitle")}
        message={t("dr.snap.deleteMsg", { name: del?.name ?? "" })}
        confirmLabel={t("common.delete")}
        busy={busy}
        onConfirm={() => del && run(() => api(`/dr/host-snapshots/${encodeURIComponent(del.name)}`, { method: "DELETE" }).then(() => (setDel(null), load())))}
      />
      <RestoreModal snap={restore} onClose={() => setRestore(null)} />
    </Card>
  );
}

function RestoreModal({ snap, onClose }: { snap: Snap | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [pass, setPass] = useState("");
  const [net, setNet] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const { busy, error, run } = useRunner();
  useEffect(() => setPass(""), [snap]);
  const go = () =>
    snap &&
    run(async () => {
      await api("/dr/host-restore", { method: "POST", json: { name: snap.name, passphrase: pass, restore_host_network: net } });
      setRestarting(true);
      setTimeout(() => location.reload(), 8000);
    });
  return (
    <GlassModal
      open={!!snap}
      onClose={onClose}
      title={t("dr.restoreTitle", { name: snap?.name ?? "" })}
      footer={
        !restarting && (
          <>
            <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
            <GlassButton variant="danger" disabled={busy || pass.length < 12} onClick={go}>
              <RotateCcw size={13} /> {t("dr.restore")}
            </GlassButton>
          </>
        )
      }
    >
      {restarting ? (
        <Notice notice={t("dr.restarting")} />
      ) : (
        <div className="space-y-3 text-xs text-slate-300">
          <p>{t("dr.restoreWarn")}</p>
          <Field label={t("dr.passphrase")}>
            <GlassInput className="w-full" type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
          <GlassSwitch checked={net} onChange={setNet} label={t("dr.restoreNet")} />
          <Notice error={error} />
        </div>
      )}
    </GlassModal>
  );
}

function Offsite({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [edit, setEdit] = useState<Target | "new" | null>(null);
  const [del, setDel] = useState<Target | null>(null);
  const [job, setJob] = useState<{ id: string; name: string } | null>(null);
  const load = useCallback(() => api<{ targets: Target[] }>("/dr/offsite-targets").then((r) => setTargets(r.targets)), []);
  const { busy, error, run } = useRunner(onChange);
  useEffect(() => void run(load), [run, load]);
  const sync = (x: Target) => run(async () => setJob({ id: (await api<{ job_id: string }>(`/dr/offsite-targets/${x.id}/sync`, { method: "POST" })).job_id, name: x.name }));
  const synced = useCallback(() => (load(), onChange()), [load, onChange]);

  return (
    <Card
      title={t("dr.off.title")}
      action={
        <GlassButton size="xs" onClick={() => setEdit("new")}>
          <Plus size={12} /> {t("dr.off.add")}
        </GlassButton>
      }
    >
      <div data-anchor="dr-offsite" className="space-y-3">
        <p className="text-[11px] text-slate-400">{t("dr.off.hint")}</p>
        <Notice error={error} />
        {job && <JobCard key={job.id} jobId={job.id} title={t("dr.off.syncing", { name: job.name })} onDone={synced} />}
        {targets?.length === 0 && <p className="text-xs text-slate-400">{t("dr.off.none")}</p>}
        {targets?.map((x) => (
          <div key={x.id} className="glass-field flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs">
            <GlassBadge tone="info">{t(`dr.type.${x.type}`)}</GlassBadge>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-slate-100">{x.name}</div>
              <div className="truncate text-[11px] text-slate-500">
                {x.endpoint}
                {x.bucket && ` · ${x.bucket}`}
              </div>
            </div>
            <span className="text-[11px] text-slate-400">
              {t("dr.off.lastRun")}: {x.last_run ? when(x.last_run.at) : t("common.never")}
            </span>
            {x.last_run && <GlassBadge tone={x.last_run.ok ? "success" : "danger"}>{x.last_run.ok ? t("dr.ok") : t("dr.failed")}</GlassBadge>}
            <GlassButton size="xs" disabled={busy} onClick={() => sync(x)}>
              <CloudUpload size={12} /> {t("dr.off.sync")}
            </GlassButton>
            <GlassButton size="xs" variant="ghost" onClick={() => setEdit(x)} title={t("common.edit")} aria-label={t("common.edit")}>
              <Pencil size={12} />
            </GlassButton>
            <GlassButton size="xs" variant="ghost" onClick={() => setDel(x)} title={t("common.delete")} aria-label={t("common.delete")}>
              <Trash2 size={12} />
            </GlassButton>
          </div>
        ))}
      </div>
      <TargetModal target={edit} onClose={() => setEdit(null)} onSaved={synced} />
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        title={t("dr.off.deleteTitle")}
        message={t("dr.off.deleteMsg", { name: del?.name ?? "" })}
        confirmLabel={t("common.delete")}
        busy={busy}
        onConfirm={() => del && run(() => api(`/dr/offsite-targets/${del.id}`, { method: "DELETE" }).then(() => (setDel(null), load())))}
      />
    </Card>
  );
}

const BLANK: Draft = {
  name: "", type: "s3", endpoint: "", bucket: "", region: "", access_key_id: "", secret_access_key: "", username: "", password: "",
  port: 22, include_hypervisor_backups: true, retention_days: 30,
};

function TargetModal({ target, onClose, onSaved }: { target: Target | "new" | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState<Draft>(BLANK);
  const { busy, error, run } = useRunner(onSaved);
  const existing = target && target !== "new" ? target : null;
  useEffect(() => setD(existing ? { ...existing, secret_access_key: "", password: "" } : BLANK), [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const text = (k: keyof Draft, label: string, placeholder = "") => (
    <Field label={label}>
      <GlassInput className="w-full" placeholder={placeholder} value={String(d[k])} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const secret = (k: "secret_access_key" | "password", label: string, isSet?: boolean) => (
    <Field label={label} hint={isSet ? t("dr.secretSet") : undefined}>
      <GlassInput className="w-full" type="password" autoComplete="new-password" placeholder={isSet ? "••••••••" : ""} value={d[k]} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const save = () =>
    run(async () => {
      // Empty secrets go as null: the backend keeps the stored one.
      const body = { ...d, secret_access_key: d.secret_access_key || null, password: d.password || null };
      await api(existing ? `/dr/offsite-targets/${existing.id}` : "/dr/offsite-targets", { method: existing ? "PUT" : "POST", json: body });
      onClose();
    });

  return (
    <GlassModal
      open={!!target}
      onClose={onClose}
      title={existing ? t("dr.off.edit") : t("dr.off.add")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !d.name || !d.endpoint} onClick={save}>
            {t("common.save")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <Segmented
          value={d.type}
          onChange={(v) => set("type", v)}
          options={(["s3", "sftp", "webdav"] as const).map((id) => ({ id, label: t(`dr.type.${id}`) }))}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {text("name", t("dr.name"), "offsite-1")}
          {d.type === "s3" && (
            <>
              {text("endpoint", t("dr.off.endpoint"), "https://s3.example.com")}
              {text("bucket", t("dr.off.bucket"), "backups/solardeck")}
              {text("region", t("dr.off.region"), "us-east-1")}
              {text("access_key_id", t("dr.off.accessKey"))}
              {secret("secret_access_key", t("dr.off.secretKey"), existing?.secret_access_key_set)}
            </>
          )}
          {d.type === "sftp" && (
            <>
              {text("endpoint", t("dr.off.host"), "backup.example.com")}
              <Field label={t("dr.off.port")}>
                <GlassInput className="w-full" type="number" min={1} max={65535} value={d.port} onChange={(e) => set("port", Number(e.target.value))} />
              </Field>
              {text("username", t("dr.off.user"))}
              {secret("password", t("dr.off.password"), existing?.password_set)}
              {text("bucket", t("dr.off.folder"), "solardeck")}
            </>
          )}
          {d.type === "webdav" && (
            <>
              {text("endpoint", t("dr.off.url"), "https://dav.example.com/remote.php/dav/files/me")}
              {text("username", t("dr.off.user"))}
              {secret("password", t("dr.off.password"), existing?.password_set)}
              {text("bucket", t("dr.off.folder"), "solardeck")}
            </>
          )}
          <Field label={t("dr.off.retention")} hint={t("dr.off.retentionHint")}>
            <GlassInput className="w-full" type="number" min={0} max={3650} value={d.retention_days} onChange={(e) => set("retention_days", Number(e.target.value))} />
          </Field>
        </div>
        <GlassSwitch checked={d.include_hypervisor_backups} onChange={(v) => set("include_hypervisor_backups", v)} label={t("dr.off.includeBackups")} />
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

/** A volid ("store:backup/file") in the path: encode each segment, keep "/" and ":". */
const volidPath = (v: string) => v.split("/").map((s) => encodeURIComponent(s).replace(/%3A/gi, ":")).join("/");

function Sandbox({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation();
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const stores = targets.filter((x) => x.active && /images|rootdir/.test(x.content)).map((x) => x.storage);
  const [backups, setBackups] = useState<BackupsInfo["archives"] | null>(null);
  const [results, setResults] = useState<Verification[]>([]);
  const [volid, setVolid] = useState("");
  const [storage, setStorage] = useState("");
  const [job, setJob] = useState<string | null>(null);
  const load = useCallback(
    () =>
      Promise.all([
        api<BackupsInfo>("/v1/backups").then((r) => setBackups(r.archives)),
        api<Verification[]>("/dr/verifications").then(setResults),
      ]),
    [],
  );
  const { busy, error, run } = useRunner();
  useEffect(() => void run(load), [run, load]);
  useEffect(() => {
    if (!stores.includes(storage)) setStorage(stores.find((s) => s !== "local") ?? stores[0] ?? "");
  }, [stores.join(","), storage]); // eslint-disable-line react-hooks/exhaustive-deps
  const verify = () => run(async () => setJob((await api<{ job_id: string }>(`/dr/verify-sandbox/${volidPath(volid)}`, { method: "POST", json: { storage } })).job_id));
  const done = useCallback(() => (load(), onChange()), [load, onChange]);

  return (
    <Card
      title={t("dr.sb.title")}
      action={
        <GlassButton size="xs" variant="ghost" onClick={() => run(load)} disabled={busy} aria-label={t("common.refresh")}>
          <RefreshCw size={12} />
        </GlassButton>
      }
    >
      <div data-anchor="dr-sandbox" className="space-y-3">
        <p className="text-[11px] text-slate-400">{t("dr.sb.hint")}</p>
        <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto] sm:items-end">
          <Field label={t("dr.sb.backup")}>
            <GlassSelect className="w-full" value={volid} onChange={(e) => setVolid(e.target.value)}>
              <option value="">{backups?.length === 0 ? t("dr.sb.noBackups") : t("dr.sb.pick")}</option>
              {backups?.map((b) => (
                <option key={b.volid} value={b.volid}>
                  {b.name || b.volid} · {new Date(b.ctime * 1000).toLocaleString()}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label={t("dr.sb.storage")}>
            <GlassSelect className="w-full" value={storage} onChange={(e) => setStorage(e.target.value)}>
              {stores.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </GlassSelect>
          </Field>
          <GlassButton variant="primary" disabled={busy || !volid || !storage} onClick={verify}>
            <ShieldCheck size={13} /> {t("dr.sb.verify")}
          </GlassButton>
        </div>
        <Notice error={error} />
        {job && <JobCard key={job} jobId={job} title={t("dr.sb.running")} onDone={done} />}
        {results.length > 0 && (
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1.5 font-medium">{t("dr.sb.backup")}</th>
                <th className="px-2 font-medium">{t("dr.date")}</th>
                <th className="px-2 font-medium">{t("dr.sb.booted")}</th>
                <th className="px-2 font-medium">{t("dr.sb.heartbeat")}</th>
                <th className="px-2 text-right font-medium">{t("dr.sb.result")}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={`${r.backup}-${r.started}`} className="border-t border-white/5">
                  <td className="max-w-0 truncate py-1.5 font-mono text-slate-100" title={r.backup}>
                    {r.backup.split("/").pop()}
                  </td>
                  <td className="px-2 text-slate-300">{when(r.started)}</td>
                  <td className="px-2 text-slate-300">{r.booted ? t("dr.yes") : t("dr.no")}</td>
                  <td className="px-2 text-slate-300">{r.heartbeat ? t("dr.sb.after", { n: r.seconds_to_heartbeat ?? 0 }) : t("dr.no")}</td>
                  <td className="px-2 text-right">
                    <GlassBadge tone={r.ok ? "success" : "danger"}>{r.ok ? t("dr.ok") : t("dr.failed")}</GlassBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
