import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { edition } from "@edition";
import { Archive, CalendarClock, Container, Monitor, Plus, RefreshCw, RotateCcw, Trash2, UploadCloud } from "lucide-react";
import { api } from "../lib/api";
import type { BackupArchive, BackupsInfo, Guest, TaskState } from "../lib/types";
import { bytes } from "../lib/format";
import { useRunner } from "../lib/hooks";
import { useIntentFor, useTelemetry } from "../lib/stores";
import { GuideBanner } from "../components/wizards/GuidedWizardModal";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";
import { TaskLog } from "../components/TaskCenter";

type Tab = "backups" | "schedules";
type Mode = "snapshot" | "suspend" | "stop";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "backups", label: "Backups", icon: <Archive size={15} /> },
  { id: "schedules", label: "Schedules", icon: <CalendarClock size={15} /> },
];

const MODES: { id: Mode; label: string }[] = [
  { id: "snapshot", label: "Snapshot" },
  { id: "suspend", label: "Suspend" },
  { id: "stop", label: "Stop" },
];

const PRESETS = [
  { id: "daily 02:00", label: "Every day at 02:00" },
  { id: "sun 01:00", label: "Every Sunday at 01:00" },
  { id: "mon..fri 23:00", label: "Weekdays at 23:00" },
  { id: "*-*-01 03:00", label: "Monthly on the 1st at 03:00" },
];

const fmtDate = (t: number) => (t ? new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const GuestIcon = ({ type }: { type: string | null }) => (type === "qemu" ? <Monitor size={14} className="text-sky-300" /> : <Container size={14} className="text-violet-300" />);

/** Shows a task log once a job started; children are the form before that. */
function TaskModal({ open, onClose, title, upid, onDone, footer, children }: { open: boolean; onClose: () => void; title: string; upid: string | null; onDone: () => void; footer: ReactNode; children: ReactNode }) {
  const [state, setState] = useState<TaskState | null>(null);
  useEffect(() => setState(null), [upid]);
  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        upid ? (
          <GlassButton variant="primary" onClick={onClose}>
            {state === "running" || !state ? "Run in background" : "Close"}
          </GlassButton>
        ) : (
          footer
        )
      }
    >
      {upid ? (
        <div className="space-y-2">
          <TaskLog upid={upid} className="h-56" onDone={(s) => (setState(s), s !== "running" && onDone())} />
          {state === "ok" && <Notice notice="Task finished successfully." />}
          {state === "error" && <Notice error="The task failed; see the log above." />}
        </div>
      ) : (
        children
      )}
    </GlassModal>
  );
}

function BackupNowModal({ open, onClose, storages, guests, onDone }: { open: boolean; onClose: () => void; storages: string[]; guests: Guest[]; onDone: () => void }) {
  const [vmid, setVmid] = useState("all");
  const [storage, setStorage] = useState("");
  const [mode, setMode] = useState<Mode>("snapshot");
  const [upid, setUpid] = useState<string | null>(null);
  const { busy, error, run } = useRunner();
  useEffect(() => {
    if (open) (setUpid(null), setStorage(storages[0] ?? ""));
  }, [open, storages]);
  const start = () =>
    run(async () => {
      const r = await api<{ upid: string }>("/v1/backups/run", { method: "POST", json: { vmid: vmid === "all" ? "all" : Number(vmid), storage, mode, compress: "zstd" } });
      setUpid(r.upid);
    });
  return (
    <TaskModal
      open={open}
      onClose={onClose}
      title="Back up now"
      upid={upid}
      onDone={onDone}
      footer={
        <>
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton variant="primary" disabled={busy || !storage} onClick={start}>
            <UploadCloud size={13} /> Start backup
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Guest">
          <GlassSelect className="w-full" value={vmid} onChange={(e) => setVmid(e.target.value)}>
            <option value="all">All VMs and containers</option>
            {guests.map((g) => (
              <option key={g.vmid} value={g.vmid}>
                {g.vmid} · {g.name} ({g.type === "qemu" ? "VM" : "LXC"})
              </option>
            ))}
          </GlassSelect>
        </Field>
        <Field label="Target storage">
          <GlassSelect className="w-full" value={storage} onChange={(e) => setStorage(e.target.value)}>
            {!storages.length && <option value="">No backup storage configured</option>}
            {storages.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </GlassSelect>
        </Field>
        <Field label="Mode" hint="Snapshot keeps guests running; Stop gives the most consistent backup">
          <Segmented value={mode} onChange={setMode} options={MODES} />
        </Field>
        <p className="text-[11px] text-slate-500">Compression: Zstandard (zstd)</p>
        <Notice error={error} />
      </div>
    </TaskModal>
  );
}

function RestoreModal({ archive, onClose, guests, onDone }: { archive: BackupArchive | null; onClose: () => void; guests: Guest[]; onDone: () => void }) {
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const [vmid, setVmid] = useState(0);
  const [storage, setStorage] = useState("");
  const [force, setForce] = useState(false);
  const [upid, setUpid] = useState<string | null>(null);
  const { busy, error, run } = useRunner();
  const kind = archive?.type ?? "qemu";
  const stores = targets.filter((t) => t.active && t.content.includes(kind === "qemu" ? "images" : "rootdir")).map((t) => t.storage);
  const exists = guests.find((g) => g.vmid === vmid);

  useEffect(() => {
    if (!archive) return;
    setUpid(null);
    setForce(false);
    setVmid(archive.vmid ?? 0);
    setStorage(stores.find((s) => s !== "local") ?? stores[0] ?? "");
  }, [archive]); // eslint-disable-line react-hooks/exhaustive-deps

  const nextFree = () => api<{ vmid: number }>("/v1/nextid").then((r) => setVmid(r.vmid));
  const start = () =>
    archive &&
    run(async () => {
      const r = await api<{ upid: string }>("/v1/backups/restore", { method: "POST", json: { volid: archive.volid, type: kind, vmid, storage, force } });
      setUpid(r.upid);
    });

  return (
    <TaskModal
      open={!!archive}
      onClose={onClose}
      title="Restore backup"
      upid={upid}
      onDone={onDone}
      footer={
        <>
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton variant={exists ? "danger" : "primary"} disabled={busy || !storage || vmid < 100 || (!!exists && !force) || !archive?.type} onClick={start}>
            <RotateCcw size={13} /> {exists ? "Overwrite & restore" : "Restore"}
          </GlassButton>
        </>
      }
    >
      {archive && (
        <div className="space-y-3 text-xs">
          <GuideBanner guide="backup" text="Restoring replaces or recreates a machine from this backup. See how restores work before you start." />
          <div className="glass-soft flex items-center gap-3 rounded-xl p-3">
            <GuestIcon type={archive.type} />
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-100">{archive.name || `Guest ${archive.vmid ?? "?"}`}</div>
              <div className="truncate text-[11px] text-slate-400">
                {fmtDate(archive.ctime)} · {bytes(archive.size)} · {archive.storage}
              </div>
            </div>
          </div>
          {!archive.type && <Notice error="Cannot tell whether this archive is a VM or a container." />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Restore to VM ID">
              <div className="flex gap-2">
                <GlassInput type="number" min={100} className="w-full" value={vmid || ""} onChange={(e) => (setVmid(Number(e.target.value)), setForce(false))} />
                <GlassButton size="xs" onClick={nextFree}>
                  Next free
                </GlassButton>
              </div>
            </Field>
            <Field label="Target storage">
              <GlassSelect className="w-full" value={storage} onChange={(e) => setStorage(e.target.value)}>
                {stores.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </GlassSelect>
            </Field>
          </div>
          {exists && (
            <div className="rounded-xl bg-rose-500/10 p-3 ring-1 ring-rose-400/20 ring-inset">
              <p className="mb-2 text-rose-200">
                {exists.name} ({exists.vmid}) already exists. Restoring over it permanently replaces its disks and configuration
                {exists.status === "running" && " — stop it first"}.
              </p>
              <GlassSwitch checked={force} onChange={setForce} label="I understand, overwrite the existing guest" />
            </div>
          )}
          <Notice error={error} />
        </div>
      )}
    </TaskModal>
  );
}

function Backups({ data, guests, reload, backupNow, setBackupNow }: { data: BackupsInfo; guests: Guest[]; reload: () => void; backupNow: boolean; setBackupNow: (v: boolean) => void }) {
  const [restore, setRestore] = useState<BackupArchive | null>(null);
  const [del, setDel] = useState<BackupArchive | null>(null);
  const [filter, setFilter] = useState("");
  const { busy, error, run } = useRunner();
  const shown = data.archives.filter((a) => !filter || `${a.name} ${a.vmid}`.toLowerCase().includes(filter.toLowerCase()));
  const total = data.archives.reduce((n, a) => n + a.size, 0);
  const remove = () =>
    del && run(() => api(`/v1/storage/${del.storage}/content?volume=${encodeURIComponent(del.volid)}`, { method: "DELETE" }).then(() => (setDel(null), setTimeout(reload, 1500))));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Backup archives</h3>
          <p className="text-[11px] text-slate-400">
            {data.archives.length} archive(s) · {bytes(total)} on {data.storages.join(", ") || "no backup storage"}
          </p>
        </div>
        <GlassInput className="ml-auto w-48" placeholder="Filter by guest" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <GlassButton variant="primary" onClick={() => setBackupNow(true)}>
          <UploadCloud size={13} /> Backup Now
        </GlassButton>
      </div>
      {data.archives.length === 0 && <GuideBanner guide="backup" text="No backups yet. Learn how backups protect your machines and how to schedule them automatically." />}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-1.5 font-medium">Guest</th>
              <th className="px-2 font-medium">Date</th>
              <th className="px-2 font-medium">Size</th>
              <th className="px-2 font-medium">Storage</th>
              <th className="px-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-400">
                  No backups yet. Use Backup Now or add a schedule.
                </td>
              </tr>
            )}
            {shown.map((a) => (
              <tr key={a.volid} className="border-t border-white/5 hover:bg-white/5">
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <GuestIcon type={a.type} />
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-100">{a.name || (a.vmid ? `Guest ${a.vmid}` : a.volid.split("/").pop())}</div>
                      <div className="text-[11px] text-slate-500">
                        {a.vmid ?? "—"} · {a.type === "qemu" ? "VM" : a.type === "lxc" ? "LXC" : "Unknown"}
                        {a.notes && ` · ${a.notes}`}
                      </div>
                    </div>
                    {a.protected && <GlassBadge>PROTECTED</GlassBadge>}
                  </div>
                </td>
                <td className="px-2 text-slate-300">{fmtDate(a.ctime)}</td>
                <td className="px-2 text-slate-300 tabular-nums">{bytes(a.size)}</td>
                <td className="px-2 text-slate-400">{a.storage}</td>
                <td className="px-2">
                  <div className="flex justify-end gap-1">
                    <GlassButton size="xs" onClick={() => setRestore(a)}>
                      <RotateCcw size={12} /> Restore
                    </GlassButton>
                    <GlassButton variant="ghost" size="xs" onClick={() => setDel(a)} disabled={a.protected} aria-label="Delete backup">
                      <Trash2 size={12} className="text-rose-300" />
                    </GlassButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <BackupNowModal open={backupNow} onClose={() => setBackupNow(false)} storages={data.storages} guests={guests} onDone={reload} />
      <RestoreModal archive={restore} onClose={() => setRestore(null)} guests={guests} onDone={reload} />
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={remove}
        busy={busy}
        error={error}
        title="Delete backup"
        confirmLabel="Delete backup"
        message={<>Permanently delete the backup of {del?.name || del?.vmid} from {fmtDate(del?.ctime ?? 0)}?</>}
      />
    </div>
  );
}

function Schedules({ data, guests, reload }: { data: BackupsInfo; guests: Guest[]; reload: () => void }) {
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [custom, setCustom] = useState("");
  const [storage, setStorage] = useState("");
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<number[]>([]);
  const [mode, setMode] = useState<Mode>("snapshot");
  const [keep, setKeep] = useState(7);
  const [del, setDel] = useState<string | null>(null);
  const { busy, error, notice, run } = useRunner(reload);
  const names = useMemo(() => new Map(guests.map((g) => [String(g.vmid), g.name])), [guests]);
  useEffect(() => {
    if (!storage && data.storages.length) setStorage(data.storages[0]);
  }, [data.storages, storage]);

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(
      () =>
        api("/v1/backups/schedules", {
          method: "POST",
          json: { schedule: preset === "custom" ? custom : preset, storage, vmids: all ? "all" : picked, mode, compress: "zstd", keep_last: keep },
        }),
      "Backup job created.",
    );
  };
  const toggle = (id: string, enabled: boolean) => run(() => api(`/v1/backups/schedules/${id}`, { method: "PUT", json: { enabled } }));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {data.schedules.length === 0 && <p className="text-xs text-slate-400">No backup jobs yet.</p>}
        {data.schedules.map((j) => (
          <div key={j.id} className="glass-soft flex flex-wrap items-center gap-3 rounded-xl p-3 text-xs">
            <GlassSwitch checked={j.enabled} onChange={(v) => toggle(j.id, v)} disabled={busy} label={<span className="sr-only">Enabled</span>} />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-100">
                {PRESETS.find((p) => p.id === j.schedule)?.label ?? j.schedule}
                {j.comment && <span className="ml-2 text-slate-400">· {j.comment}</span>}
              </div>
              <div className="truncate text-[11px] text-slate-400">
                {j.all ? "All guests" : j.vmid.split(",").map((v) => names.get(v) ?? v).join(", ")} → {j.storage} · {j.mode}
                {j.keep_last != null && ` · keep last ${j.keep_last}`}
                {j.next_run ? ` · next ${fmtDate(j.next_run)}` : ""}
              </div>
            </div>
            <GlassBadge tone={j.enabled ? "success" : "neutral"}>{j.enabled ? "ACTIVE" : "PAUSED"}</GlassBadge>
            <GlassButton variant="ghost" size="xs" onClick={() => setDel(j.id)} aria-label="Delete job">
              <Trash2 size={13} className="text-rose-300" />
            </GlassButton>
          </div>
        ))}
      </div>

      <form onSubmit={create} className="glass-soft space-y-3 rounded-2xl p-4">
        <h3 className="text-sm font-semibold text-slate-100">New backup job</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="When">
            <GlassSelect className="w-full" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom calendar event…</option>
            </GlassSelect>
          </Field>
          {preset === "custom" && (
            <Field label="Calendar event" hint={edition.calendarHint}>
              <GlassInput className="w-full font-mono" value={custom} onChange={(e) => setCustom(e.target.value)} required />
            </Field>
          )}
          <Field label="Storage">
            <GlassSelect className="w-full" value={storage} onChange={(e) => setStorage(e.target.value)}>
              {data.storages.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </GlassSelect>
          </Field>
          <Field label="Retention (keep last)">
            <GlassInput type="number" min={1} max={1000} className="w-full" value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Mode">
          <Segmented value={mode} onChange={setMode} options={MODES} />
        </Field>
        <GlassSwitch checked={all} onChange={setAll} label="Back up all guests" />
        {!all && (
          <div className="flex flex-wrap gap-1.5">
            {guests.map((g) => {
              const on = picked.includes(g.vmid);
              return (
                <button
                  type="button"
                  key={g.vmid}
                  onClick={() => setPicked(on ? picked.filter((v) => v !== g.vmid) : [...picked, g.vmid])}
                  className={`rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset transition ${on ? "bg-sky-400/20 text-sky-100 ring-sky-300/30" : "text-slate-400 ring-white/10 hover:text-slate-200"}`}
                >
                  {g.vmid} · {g.name}
                </button>
              );
            })}
          </div>
        )}
        <Notice error={error} notice={notice} />
        <GlassButton type="submit" variant="primary" disabled={busy || !storage || (!all && !picked.length)}>
          <Plus size={13} /> Create job
        </GlassButton>
      </form>
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={() => del && run(() => api(`/v1/backups/schedules/${del}`, { method: "DELETE" }).then(() => setDel(null)))}
        busy={busy}
        title="Delete backup job"
        confirmLabel="Delete job"
        message="Existing backup archives are kept; only the schedule is removed."
      />
    </div>
  );
}

export default function BackupCenterApp({ initialTab }: { initialTab?: Tab } = {}) {
  const [tab, setTab] = useState<Tab>(initialTab === "schedules" ? "schedules" : "backups");
  const [backupNow, setBackupNow] = useState(false);
  useIntentFor("backup", (v) => (v === "now" ? (setTab("backups"), setBackupNow(true)) : setTab(v)));
  const [data, setData] = useState<BackupsInfo | null>(null);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<BackupsInfo>("/v1/backups").then((d) => (setData(d), setError("")), (e) => setError(e.message));
    api<Guest[]>("/v1/guests").then(setGuests, () => {});
  }, []);
  useEffect(load, [load]);

  return (
    <div className="flex h-full">
      <nav className="w-44 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${
              tab === t.id ? "bg-white/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
            title={t.label}
          >
            {t.icon}
            <span className="max-sm:hidden">{t.label}</span>
          </button>
        ))}
        <button onClick={load} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 hover:text-slate-200" title="Refresh">
          <RefreshCw size={15} /> <span className="max-sm:hidden">Refresh</span>
        </button>
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        <Notice error={error} />
        {!data ? (
          !error && <p className="text-sm text-slate-400">Loading…</p>
        ) : tab === "backups" ? (
          <Backups data={data} guests={guests} reload={load} backupNow={backupNow} setBackupNow={setBackupNow} />
        ) : (
          <Schedules data={data} guests={guests} reload={load} />
        )}
      </div>
    </div>
  );
}
