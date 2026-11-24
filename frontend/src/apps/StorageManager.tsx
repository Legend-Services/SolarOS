import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  BookOpen,
  CalendarClock,
  Camera,
  Database,
  Eraser,
  FolderPlus,
  HardDrive,
  History,
  Layers,
  LayoutDashboard,
  Plus,
  RefreshCw,
  ScanSearch,
  Server,
  ShieldCheck,
  Thermometer,
  Trash2,
  Wrench,
} from "lucide-react";
import { useIntentFor, useTelemetry } from "../lib/stores";
import { useAppView } from "../store/layoutStore";
import { useWizard } from "../store/wizardStore";
import { ViewToggle } from "../components/ViewOptions";
import { GuideBanner } from "../components/wizards/GuidedWizardModal";
import { api } from "../lib/api";
import type { PveDisk, Schedule, Share, SmartReport, StorageInfo, ZfsDataset, ZfsDatasetInfo, ZfsSnapshot, ZfsVdev } from "../lib/types";
import { bytes, healthColor, pct, tempColor } from "../lib/format";
import { useRunner } from "../lib/hooks";
import { Bar } from "../components/charts";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, healthTone, Notice, Segmented } from "../components/ui/GlassKit";

type Tab = "overview" | "pools" | "datasets" | "disks" | "snapshots" | "backends";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={15} /> },
  { id: "pools", label: "ZFS Pools", icon: <Database size={15} /> },
  { id: "datasets", label: "Volumes & Datasets", icon: <Layers size={15} /> },
  { id: "disks", label: "Disks & SMART", icon: <HardDrive size={15} /> },
  { id: "snapshots", label: "Snapshots & Schedules", icon: <Camera size={15} /> },
  { id: "backends", label: "Storage backends", icon: <Server size={15} /> },
];

const TASK_NOTE = "Task started; follow it in the Task Center.";
const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "—");

/* ================================================================ Create pool wizard */

const TOPOLOGIES = [
  { id: "single", label: "Single", min: 1, parity: 0, desc: "One disk, no redundancy." },
  { id: "mirror", label: "Mirror", min: 2, parity: 0, desc: "Every disk holds a full copy. Survives all but one disk failing." },
  { id: "raid10", label: "RAID10", min: 4, parity: 0, desc: "Striped mirrors (even number of disks). Fast, survives one failure per mirror." },
  { id: "raidz", label: "RAIDZ1", min: 3, parity: 1, desc: "Single parity. Survives one disk failure." },
  { id: "raidz2", label: "RAIDZ2", min: 4, parity: 2, desc: "Double parity. Survives two disk failures." },
  { id: "raidz3", label: "RAIDZ3", min: 5, parity: 3, desc: "Triple parity. Survives three disk failures." },
] as const;
type Topology = (typeof TOPOLOGIES)[number]["id"];

function usable(t: Topology, sizes: number[]) {
  if (!sizes.length) return 0;
  const min = Math.min(...sizes);
  const n = sizes.length;
  return t === "single" ? min : t === "mirror" ? min : t === "raid10" ? (min * n) / 2 : min * Math.max(0, n - TOPOLOGIES.find((x) => x.id === t)!.parity);
}

function CreatePoolModal({ open, onClose, disks, onDone }: { open: boolean; onClose: () => void; disks: PveDisk[]; onDone: () => void }) {
  const [name, setName] = useState("tank");
  const [raid, setRaid] = useState<Topology>("mirror");
  const [picked, setPicked] = useState<string[]>([]);
  const [compression, setCompression] = useState("lz4");
  const [ashift, setAshift] = useState(12);
  const [addStorage, setAddStorage] = useState(true);
  const { busy, error, run } = useRunner();
  const free = disks.filter((d) => !d.used);
  const topo = TOPOLOGIES.find((t) => t.id === raid)!;
  const valid = raid === "single" ? picked.length === 1 : picked.length >= topo.min && (raid !== "raid10" || picked.length % 2 === 0);
  const sizes = free.filter((d) => picked.includes(d.by_id || d.devpath)).map((d) => d.size);

  useEffect(() => setPicked([]), [open]);

  const submit = async () => {
    const ok = await run(() => api("/pve/zfs/pools", { method: "POST", json: { name, raidlevel: raid, devices: picked, ashift, compression, add_storage: addStorage } }));
    if (ok) {
      onDone();
      onClose();
    }
  };

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title="Create ZFS pool"
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto self-center text-[11px] text-slate-400">
            {picked.length} disk(s) · ≈ {bytes(usable(raid, sizes))} usable
          </span>
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton variant="primary" disabled={!valid || busy || !name} onClick={submit}>
            <Plus size={13} /> Create pool
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4">
        <GuideBanner guide="storage-raid" text="Not sure which RAID level to pick? See Single, Mirror, RAIDZ1 and RAIDZ2 explained in plain language." />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Pool name">
            <GlassInput className="w-full" value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z][A-Za-z0-9_.:\-]{0,63}" required />
          </Field>
          <Field label="Compression">
            <GlassSelect className="w-full" value={compression} onChange={(e) => setCompression(e.target.value)}>
              <option value="lz4">LZ4 (recommended)</option>
              <option value="zstd">ZSTD (smaller, more CPU)</option>
              <option value="on">On (default algorithm)</option>
              <option value="off">Off</option>
            </GlassSelect>
          </Field>
          <Field label="Sector size (ashift)">
            <GlassSelect className="w-full" value={ashift} onChange={(e) => setAshift(Number(e.target.value))}>
              <option value={12}>12 (4K sectors, recommended)</option>
              <option value={13}>13 (8K, some SSDs)</option>
              <option value={9}>9 (512-byte legacy disks)</option>
            </GlassSelect>
          </Field>
        </div>
        <div>
          <p className="mb-1.5 text-[11px] text-slate-400">RAID topology</p>
          <Segmented value={raid} onChange={setRaid} options={TOPOLOGIES.map((t) => ({ id: t.id, label: t.label }))} />
          <p className="mt-1.5 text-[11px] text-slate-500">
            {topo.desc} Needs {raid === "single" ? "exactly 1 disk" : `${topo.min}+ disks`}.
          </p>
        </div>
        <div>
          <p className="mb-1.5 text-[11px] text-slate-400">Unused disks</p>
          {free.length === 0 && <p className="text-xs text-slate-500">No unused disks. Wipe a disk in Disks & SMART to make it available.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {free.map((d) => {
              const id = d.by_id || d.devpath;
              const on = picked.includes(id);
              return (
                <button
                  key={d.devpath}
                  type="button"
                  onClick={() => setPicked(on ? picked.filter((x) => x !== id) : [...picked, id])}
                  className={`flex items-center gap-3 rounded-xl border p-2.5 text-left transition active:scale-[0.98] ${on ? "border-sky-300/50 bg-sky-500/15" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.07]"}`}
                >
                  <HardDrive size={18} className={on ? "text-sky-300" : "text-slate-400"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-slate-100">{d.model || d.devpath}</span>
                    <span className="block truncate font-mono text-[10px] text-slate-500">{d.devpath}</span>
                  </span>
                  <span className="text-right text-[11px] text-slate-300">
                    {bytes(d.size)}
                    <span className="block text-[10px] text-slate-500">{d.bus}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <GlassSwitch checked={addStorage} onChange={setAddStorage} label="Add as Proxmox storage (for VM and container disks)" />
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

/* ================================================================ Create dataset / ZVOL */

function CreateDatasetModal({ open, onClose, parents, onDone }: { open: boolean; onClose: () => void; parents: string[]; onDone: () => void }) {
  const [kind, setKind] = useState<"filesystem" | "volume">("filesystem");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [volsize, setVolsize] = useState("32G");
  const [compression, setCompression] = useState("inherit");
  const [recordsize, setRecordsize] = useState("inherit");
  const [quota, setQuota] = useState("");
  const [atime, setAtime] = useState(false);
  const [autoMount, setAutoMount] = useState(true);
  const { busy, error, run } = useRunner();
  const base = parents.includes(parent) ? parent : (parents[0] ?? "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const json = {
      name: `${base}/${name}`,
      kind,
      ...(kind === "volume" ? { volsize } : { atime: atime ? "on" : "off", auto_mount: autoMount }),
      ...(compression !== "inherit" && { compression }),
      ...(kind === "filesystem" && recordsize !== "inherit" && { recordsize }),
      ...(quota && kind === "filesystem" && { quota }),
    };
    if (await run(() => api("/pve/zfs/datasets", { method: "POST", json }))) {
      setName("");
      onDone();
      onClose();
    }
  };

  return (
    <GlassModal open={open} onClose={onClose} title="Create volume / dataset" width="max-w-xl">
      <form onSubmit={submit} className="space-y-4">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { id: "filesystem", label: "Dataset (filesystem)" },
            { id: "volume", label: "ZVOL (block volume)" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Parent">
            <GlassSelect className="w-full" value={base} onChange={(e) => setParent(e.target.value)}>
              {parents.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label="Name" hint={base && name ? `${base}/${name}` : undefined}>
            <GlassInput className="w-full" value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" required />
          </Field>
          {kind === "volume" ? (
            <Field label="Size" hint="e.g. 32G, 1T">
              <GlassInput className="w-full" value={volsize} onChange={(e) => setVolsize(e.target.value.toUpperCase())} pattern="[0-9]+[KMGTP]?" required />
            </Field>
          ) : (
            <Field label="Quota" hint="Empty = unlimited, e.g. 500G">
              <GlassInput className="w-full" value={quota} onChange={(e) => setQuota(e.target.value.toUpperCase())} pattern="[0-9]+[KMGTP]?" placeholder="none" />
            </Field>
          )}
          <Field label="Compression">
            <GlassSelect className="w-full" value={compression} onChange={(e) => setCompression(e.target.value)}>
              {["inherit", "lz4", "zstd", "gzip", "zle", "on", "off"].map((c) => (
                <option key={c} value={c}>
                  {c === "inherit" ? "Inherit from parent" : c}
                </option>
              ))}
            </GlassSelect>
          </Field>
          {kind === "filesystem" && (
            <Field label="Record size" hint="1M suits large media files; 16K–64K suit databases.">
              <GlassSelect className="w-full" value={recordsize} onChange={(e) => setRecordsize(e.target.value)}>
                {["inherit", "16K", "32K", "64K", "128K", "256K", "512K", "1M"].map((r) => (
                  <option key={r} value={r}>
                    {r === "inherit" ? "Inherit (128K default)" : r}
                  </option>
                ))}
              </GlassSelect>
            </Field>
          )}
        </div>
        {kind === "filesystem" && (
          <div className="flex flex-col gap-2">
            <GlassSwitch checked={atime} onChange={setAtime} label="Update access times (atime)" />
            <GlassSwitch checked={autoMount} onChange={setAutoMount} label="Mount in /mnt/storage (File Station & SMB shares)" />
          </div>
        )}
        <Notice error={error} />
        <div className="flex justify-end gap-2">
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton type="submit" variant="primary" disabled={busy || !base}>
            <FolderPlus size={13} /> Create
          </GlassButton>
        </div>
      </form>
    </GlassModal>
  );
}

/* ================================================================ Overview */

function Overview({ storage, onCreatePool, onCreateDataset }: { storage: StorageInfo; onCreatePool: () => void; onCreateDataset: () => void }) {
  const total = storage.pools.reduce((a, p) => a + p.size, 0);
  const used = storage.pools.reduce((a, p) => a + p.alloc, 0);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold text-slate-100">Storage overview</h3>
        <GlassButton variant="primary" onClick={onCreatePool}>
          <Plus size={13} /> Create ZFS Pool
        </GlassButton>
        <GlassButton onClick={onCreateDataset} disabled={!storage.pools.length}>
          <FolderPlus size={13} /> Create Volume / Dataset
        </GlassButton>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["ZFS pools", storage.pools.length],
          ["Healthy pools", storage.pools.filter((p) => p.health === "ONLINE").length],
          ["Physical disks", storage.disks.length],
          ["Pool capacity", total ? `${pct(used, total).toFixed(0)}%` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="glass-soft rounded-2xl p-3">
            <div className="text-2xl font-semibold text-white tabular-nums">{v}</div>
            <div className="text-[11px] text-slate-400">{k}</div>
          </div>
        ))}
      </div>
      {storage.pools.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {storage.pools.map((p) => {
            const u = pct(p.alloc, p.size);
            return (
              <div key={p.name} className="glass-soft relative overflow-hidden rounded-2xl p-4">
                <div className={`absolute -top-10 -right-10 h-28 w-28 rounded-full blur-2xl ${p.health === "ONLINE" ? "bg-emerald-400/20" : "bg-rose-500/25"}`} />
                <div className="relative mb-3 flex items-center gap-2">
                  <Database size={16} className="text-amber-300" />
                  <span className="flex-1 text-sm font-semibold text-white">{p.name}</span>
                  <GlassBadge tone={healthTone(p.health)}>{p.health}</GlassBadge>
                </div>
                <Bar value={u} className={u > 85 ? "bg-rose-400" : u > 70 ? "bg-amber-400" : "bg-emerald-400"} />
                <div className="mt-2 grid grid-cols-3 text-[11px]">
                  <span className="text-slate-400">
                    Used <span className="block text-slate-100">{bytes(p.alloc)}</span>
                  </span>
                  <span className="text-slate-400">
                    Free <span className="block text-slate-100">{bytes(p.free)}</span>
                  </span>
                  <span className="text-right text-slate-400">
                    Frag <span className="block text-slate-100">{p.frag}%</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-100">Proxmox storage targets</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {storage.targets.map((t) => (
          <div key={t.storage} className="glass-soft rounded-2xl p-3">
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
    </div>
  );
}

/* ================================================================ Pools */

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

function Pools({ storage, onCreate, onChanged }: { storage: StorageInfo; onCreate: () => void; onChanged: () => void }) {
  const [destroy, setDestroy] = useState<string | null>(null);
  const { busy, error, notice, run } = useRunner(onChanged);
  const confirmDestroy = async () => {
    if (await run(() => api(`/pve/zfs/pools/${encodeURIComponent(destroy!)}?confirm=${encodeURIComponent(destroy!)}`, { method: "DELETE" }), TASK_NOTE)) setDestroy(null);
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">ZFS pools</h3>
        <GlassButton variant="primary" onClick={onCreate}>
          <Plus size={13} /> Create Pool
        </GlassButton>
      </div>
      <Notice error={destroy ? undefined : error} notice={notice} />
      {storage.pools.length === 0 && (
        <>
          <p className="text-sm text-slate-400">No ZFS pools yet.</p>
          <GuideBanner guide="storage-pool" text="Learn how to turn empty drives into a protected pool and organize it with datasets." />
        </>
      )}
      {storage.pools.map((p) => (
        <section key={p.name} className="glass-soft rounded-2xl p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Database size={16} className="text-amber-300" />
            <h3 className="text-sm font-semibold text-white">{p.name}</h3>
            <GlassBadge tone={healthTone(p.health)}>{p.health}</GlassBadge>
            <span className="text-[11px] text-slate-400">
              Fragmentation {p.frag}% · Dedup {p.dedup}x
            </span>
            <span className="ml-auto flex gap-1.5">
              <GlassButton size="xs" disabled={busy} onClick={() => run(() => api(`/pve/zfs/pools/${encodeURIComponent(p.name)}/scrub`, { method: "POST" }), `Scrub of ${p.name} started.`)}>
                <ShieldCheck size={12} /> Scrub
              </GlassButton>
              <GlassButton size="xs" variant="danger" onClick={() => setDestroy(p.name)}>
                <Trash2 size={12} /> Destroy
              </GlassButton>
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
      <ConfirmModal
        open={!!destroy}
        onClose={() => setDestroy(null)}
        onConfirm={confirmDestroy}
        busy={busy}
        error={error}
        title={`Destroy pool ${destroy}`}
        confirmLabel="Destroy pool"
        expect={destroy ?? ""}
        message={
          <>
            <p>
              All datasets, volumes, snapshots and <b>every file</b> on <span className="font-mono">{destroy}</span> are permanently erased, the matching Proxmox storage
              entry is removed and the member disks are wiped.
            </p>
            <p className="mt-2 text-slate-400">VMs or containers with disks on this pool must be moved or removed first.</p>
          </>
        }
      />
    </div>
  );
}

/* ================================================================ Volumes & datasets */

const shareName = (ds: string) => ds.split("/").pop()!.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 32) || "share";

function QuotaCell({ d, onSave }: { d: ZfsDatasetInfo; onSave: (q: string) => void }) {
  const current = d.quota ? bytes(d.quota, 0) : "none";
  const [v, setV] = useState(current);
  useEffect(() => setV(current), [current]);
  const commit = () => {
    const q = v.trim().toUpperCase().replace(/\s|B$/g, "").replace(/I$/, "") || "none";
    if (v !== current) onSave(q === "NONE" ? "none" : q);
  };
  return (
    <GlassInput
      className="w-20 py-1 text-[11px]"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      aria-label={`Quota of ${d.name}`}
    />
  );
}

function Datasets({ version, onCreate }: { version: number; onCreate: () => void }) {
  const [items, setItems] = useState<ZfsDatasetInfo[] | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [guests, setGuests] = useState(false);
  const [destroy, setDestroy] = useState<ZfsDatasetInfo | null>(null);
  const [recursive, setRecursive] = useState(false);
  const load = useCallback(() => {
    api<ZfsDatasetInfo[]>("/pve/zfs/datasets").then(setItems, () => setItems([]));
    api<Share[]>("/shares").then(setShares, () => {});
  }, []);
  const { busy, error, notice, run } = useRunner(load);
  useEffect(load, [load, version]);

  const patch = (d: ZfsDatasetInfo, props: Record<string, string>) => run(() => api("/pve/zfs/datasets", { method: "PATCH", json: { name: d.name, ...props } }));
  const shareOf = (d: ZfsDatasetInfo) => shares.find((s) => s.path === `/${d.name}`);
  const toggleShare = (d: ZfsDatasetInfo, on: boolean) => {
    const s = shareOf(d);
    run(
      () => (on ? api("/shares", { method: "POST", json: { name: shareName(d.name), dataset: d.name } }) : api(`/shares/${encodeURIComponent(s!.name)}`, { method: "DELETE" })),
      on ? `Shared as smb://${location.hostname}/${shareName(d.name)}` : "Share removed; the data is kept.",
    );
  };
  const confirmDestroy = async () => {
    const q = new URLSearchParams({ name: destroy!.name, confirm: destroy!.name, recursive: String(recursive) });
    if (await run(() => api(`/pve/zfs/datasets?${q}`, { method: "DELETE" }), `${destroy!.name} destroyed.`)) setDestroy(null);
  };
  const shown = (items ?? []).filter((d) => guests || !d.guest_volume);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="mr-auto text-sm font-semibold text-slate-100">Volumes & datasets</h3>
        <GlassSwitch checked={guests} onChange={setGuests} label="Show guest disks" />
        <GlassButton variant="primary" onClick={onCreate}>
          <FolderPlus size={13} /> Create
        </GlassButton>
      </div>
      <Notice error={destroy ? undefined : error} notice={notice} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 font-medium">Name</th>
              <th className="px-2 text-right font-medium">Used</th>
              <th className="px-2 text-right font-medium">Available</th>
              <th className="px-2 font-medium">Compression</th>
              <th className="px-2 font-medium">Quota</th>
              <th className="px-2 font-medium">atime</th>
              <th className="px-2 font-medium">Auto-share</th>
              <th className="px-2" />
            </tr>
          </thead>
          <tbody>
            {items === null && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {items?.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-slate-400">
                  No datasets (or the host helper is unavailable).
                </td>
              </tr>
            )}
            {shown.map((d) => {
              const fs = d.type === "filesystem";
              const root = !d.name.includes("/");
              const locked = d.guest_volume || busy;
              return (
                <tr key={d.name} className="border-t border-white/5">
                  <td className="py-2">
                    <div className="flex items-center gap-2" style={{ paddingLeft: (d.name.split("/").length - 1) * 12 }}>
                      {fs ? <Layers size={13} className="text-amber-300" /> : <HardDrive size={13} className="text-violet-300" />}
                      <span className="font-mono text-slate-100">{d.name.split("/").pop()}</span>
                      {!fs && <GlassBadge tone="info">ZVOL {bytes(d.volsize, 0)}</GlassBadge>}
                      {d.guest_volume && <GlassBadge>GUEST</GlassBadge>}
                    </div>
                    {fs && <div className="font-mono text-[10px] text-slate-500" style={{ paddingLeft: (d.name.split("/").length - 1) * 12 + 21 }}>{d.mountpoint}</div>}
                  </td>
                  <td className="px-2 text-right tabular-nums text-slate-300">{bytes(d.used)}</td>
                  <td className="px-2 text-right tabular-nums text-slate-300">{bytes(d.available)}</td>
                  <td className="px-2">
                    <GlassSelect className="py-1 text-[11px]" value={d.compression} disabled={locked} onChange={(e) => patch(d, { compression: e.target.value })} aria-label={`Compression of ${d.name}`}>
                      {[...new Set([d.compression, "lz4", "zstd", "gzip", "zle", "on", "off"])].map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </GlassSelect>
                  </td>
                  <td className="px-2">{fs && !d.guest_volume ? <QuotaCell d={d} onSave={(quota) => patch(d, { quota })} /> : <span className="text-slate-500">—</span>}</td>
                  <td className="px-2">{fs ? <GlassSwitch checked={d.atime === "on"} disabled={locked} onChange={(v) => patch(d, { atime: v ? "on" : "off" })} /> : <span className="text-slate-500">—</span>}</td>
                  <td className="px-2">{fs && !d.guest_volume ? <GlassSwitch checked={!!shareOf(d)} disabled={busy} onChange={(v) => toggleShare(d, v)} /> : <span className="text-slate-500">—</span>}</td>
                  <td className="px-2 text-right">
                    {!root && !d.guest_volume && (
                      <GlassButton size="xs" variant="ghost" onClick={() => (setRecursive(false), setDestroy(d))} aria-label={`Delete ${d.name}`}>
                        <Trash2 size={12} className="text-rose-300" />
                      </GlassButton>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Auto-share mounts the dataset into /mnt/storage and publishes it as an SMB share. Pool roots are created and destroyed in ZFS Pools.
      </p>
      <ConfirmModal
        open={!!destroy}
        onClose={() => setDestroy(null)}
        onConfirm={confirmDestroy}
        busy={busy}
        error={error}
        title={`Delete ${destroy?.type === "volume" ? "volume" : "dataset"}`}
        confirmLabel="Delete permanently"
        expect={destroy?.name}
        message={
          <p>
            <span className="font-mono">{destroy?.name}</span> and all of its data ({bytes(destroy?.used ?? 0)}) are permanently erased. Shares pointing at it stop working.
          </p>
        }
      >
        <GlassSwitch checked={recursive} onChange={setRecursive} label="Also destroy its snapshots and child datasets" />
      </ConfirmModal>
    </div>
  );
}

/* ================================================================ Disks & SMART */

function SmartDrawer({ disk, onClose }: { disk: PveDisk | null; onClose: () => void }) {
  const [data, setData] = useState<SmartReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    if (disk) api<SmartReport>(`/pve/disks/${encodeURIComponent(disk.devpath)}/smart`).then(setData, (e) => setError(e.message));
  }, [disk]);
  const tiles: [string, ReactNode][] = data
    ? [
        ["Health", <span className={healthColor(data.health)}>{data.health}</span>],
        ["Temperature", <span className={tempColor(data.temperature_c)}>{data.temperature_c ?? "—"} °C</span>],
        ["Power-on hours", data.power_on_hours?.toLocaleString() ?? "—"],
        ["Life used", data.wearout_used_pct != null ? `${data.wearout_used_pct}%` : "—"],
        ["Unsafe shutdowns", data.unsafe_shutdowns ?? "—"],
        ["Media errors / realloc.", data.media_errors ?? "—"],
      ]
    : [];
  const table = !!data?.attributes.some((a) => a.id !== undefined);
  return (
    <GlassModal open={!!disk} onClose={onClose} side width="max-w-xl" title={<>SMART · <span className="font-mono">{disk?.devpath}</span></>}>
      <div className="space-y-4">
        <Notice error={error} />
        {!data && !error && <p className="text-sm text-slate-400">Reading SMART data…</p>}
        {data && (
          <>
            <p className="text-xs text-slate-400">
              {disk?.model} · {disk?.serial} · {disk && bytes(disk.size)}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {tiles.map(([k, v]) => (
                <div key={k} className="glass-soft rounded-xl p-2.5">
                  <div className="text-[10px] text-slate-400">{k}</div>
                  <div className="text-sm font-semibold text-slate-100 tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            <table className="w-full text-left text-[11px]">
              <thead className="text-slate-400">
                <tr>
                  {table && <th className="py-1.5 font-medium">ID</th>}
                  <th className="px-2 font-medium">Attribute</th>
                  {table && <th className="px-2 text-right font-medium">Value</th>}
                  {table && <th className="px-2 text-right font-medium">Worst</th>}
                  {table && <th className="px-2 text-right font-medium">Thresh</th>}
                  <th className="px-2 text-right font-medium">Raw</th>
                </tr>
              </thead>
              <tbody>
                {data.attributes.map((a, i) => (
                  <tr key={`${a.name}-${i}`} className={`border-t border-white/5 ${a.fail && a.fail !== "-" ? "text-rose-300" : "text-slate-300"}`}>
                    {table && <td className="py-1 tabular-nums">{a.id}</td>}
                    <td className="px-2 py-1">{a.name}</td>
                    {table && <td className="px-2 text-right tabular-nums">{a.value}</td>}
                    {table && <td className="px-2 text-right tabular-nums">{a.worst}</td>}
                    {table && <td className="px-2 text-right tabular-nums">{a.threshold}</td>}
                    <td className="px-2 text-right font-mono">{a.raw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </GlassModal>
  );
}

function FormatDiskModal({ disk, onClose, onDone }: { disk: PveDisk | null; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState<"directory" | "lvm" | "lvmthin">("directory");
  const [fs, setFs] = useState<"ext4" | "xfs">("ext4");
  const [name, setName] = useState("");
  const [addStorage, setAddStorage] = useState(true);
  const { busy, error, run } = useRunner();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const call =
      type === "directory"
        ? api("/pve/disks/directory", { method: "POST", json: { device: disk!.devpath, name, filesystem: fs, add_storage: addStorage } })
        : api("/pve/disks/lvm", { method: "POST", json: { device: disk!.devpath, name, thin: type === "lvmthin", add_storage: addStorage } });
    if (await run(() => call)) {
      onDone();
      onClose();
    }
  };
  return (
    <GlassModal open={!!disk} onClose={onClose} title={<>Create storage on <span className="font-mono">{disk?.devpath}</span></>}>
      <form onSubmit={submit} className="space-y-4">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { id: "directory", label: "Directory" },
            { id: "lvm", label: "LVM" },
            { id: "lvmthin", label: "LVM-Thin" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Storage name">
            <GlassInput className="w-full" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} pattern="[a-z][a-z0-9_.\-]{0,38}[a-z0-9]" required />
          </Field>
          {type === "directory" && (
            <Field label="Filesystem">
              <GlassSelect className="w-full" value={fs} onChange={(e) => setFs(e.target.value as "ext4" | "xfs")}>
                <option value="ext4">ext4</option>
                <option value="xfs">xfs</option>
              </GlassSelect>
            </Field>
          )}
        </div>
        <GlassSwitch checked={addStorage} onChange={setAddStorage} label="Add as Proxmox storage" />
        <p className="text-[11px] text-amber-300/90">The whole disk is formatted. It must be unused (no partitions in use).</p>
        <Notice error={error} />
        <div className="flex justify-end gap-2">
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton type="submit" variant="primary" disabled={busy}>
            Create storage
          </GlassButton>
        </div>
      </form>
    </GlassModal>
  );
}

function Disks({ disks, onChanged }: { disks: PveDisk[] | null; onChanged: () => void }) {
  const temps = useTelemetry((s) => s.hardware?.disks);
  const [smart, setSmart] = useState<PveDisk | null>(null);
  const [wipe, setWipe] = useState<PveDisk | null>(null);
  const [format, setFormat] = useState<PveDisk | null>(null);
  const [view] = useAppView("disks");
  const showGuide = useWizard((s) => s.show);
  const { busy, error, notice, run } = useRunner(onChanged);
  const initGpt = (d: PveDisk) => {
    if (window.confirm(`Initialize a new, empty GPT partition table on ${d.devpath}?`)) run(() => api("/pve/disks/initgpt", { method: "POST", json: { disk: d.devpath } }), TASK_NOTE);
  };
  const confirmWipe = async () => {
    if (await run(() => api("/pve/disks/wipe", { method: "POST", json: { disk: wipe!.devpath, confirm_device: wipe!.devpath } }), TASK_NOTE)) setWipe(null);
  };
  if (!disks) return <p className="text-sm text-slate-400">Loading…</p>;
  const tempOf = (d: PveDisk) => temps?.find((t) => t.devpath === d.devpath)?.temp_c ?? null;
  const actions = (d: PveDisk, compact = false) => (
    <>
      <GlassButton size="xs" onClick={() => setSmart(d)} title="Inspect SMART">
        <ScanSearch size={12} /> {compact ? "SMART" : "Inspect SMART"}
      </GlassButton>
      <GlassButton size="xs" disabled={busy || !!d.used} onClick={() => initGpt(d)} title={d.used ? "Disk is in use" : "Write an empty GPT"}>
        <Wrench size={12} /> {compact ? "GPT" : "Initialize GPT"}
      </GlassButton>
      <GlassButton size="xs" disabled={busy || !!d.used} onClick={() => setFormat(d)} title={d.used ? "Disk is in use" : "Directory / LVM storage"}>
        <Plus size={12} /> {compact ? "Storage" : "Create storage"}
      </GlassButton>
      <GlassButton size="xs" variant="danger" disabled={busy} onClick={() => setWipe(d)} title="Wipe Disk">
        <Eraser size={12} /> {compact ? "Wipe" : "Wipe Disk"}
      </GlassButton>
    </>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">Physical disks</h3>
        <GlassButton size="xs" variant="ghost" onClick={() => showGuide("storage-smart")}>
          <BookOpen size={12} /> How do I read disk health?
        </GlassButton>
        <ViewToggle app="disks" />
      </div>
      <Notice error={wipe ? undefined : error} notice={notice} />
      {view === "list" ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2 font-medium">Device</th>
                <th className="px-2 font-medium">Model</th>
                <th className="px-2 font-medium">Bus</th>
                <th className="px-2 text-right font-medium">Size</th>
                <th className="px-2 font-medium">Health</th>
                <th className="px-2 text-right font-medium">Temp</th>
                <th className="px-2 text-right font-medium">Life</th>
                <th className="px-2 font-medium">Usage</th>
                <th className="px-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {disks.map((d) => {
                const temp = tempOf(d);
                return (
                  <tr key={d.devpath} className="border-t border-white/5 hover:bg-white/[0.03]">
                    <td className="py-2 font-mono text-slate-200">{d.devpath}</td>
                    <td className="max-w-48 truncate px-2 text-slate-200" title={d.serial || undefined}>{d.model || "Unknown model"}</td>
                    <td className="px-2"><GlassBadge tone="info">{d.bus}</GlassBadge></td>
                    <td className="px-2 text-right text-slate-200 tabular-nums">{bytes(d.size)}</td>
                    <td className="px-2"><GlassBadge tone={healthTone(d.health)}>{d.health}</GlassBadge></td>
                    <td className={`px-2 text-right tabular-nums ${tempColor(temp)}`}>{temp ?? "—"} °C</td>
                    <td className="px-2 text-right text-slate-300 tabular-nums">{d.wearout != null ? `${d.wearout}%` : d.rpm ? `${d.rpm} rpm` : "N/A"}</td>
                    <td className={`max-w-40 truncate px-2 ${d.used ? "text-slate-300" : "text-emerald-300"}`}>{d.used || "Unused"}</td>
                    <td className="px-2">
                      <div className="flex justify-end gap-1">{actions(d, true)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
      <div className="grid gap-3 lg:grid-cols-2">
        {disks.map((d) => {
          const temp = tempOf(d);
          const life = d.wearout;
          return (
            <section key={d.devpath} className="glass-soft rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-slate-500/40 to-slate-800/40 ring-1 ring-white/10">
                  <HardDrive size={18} className="text-slate-200" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-slate-100">{d.model || "Unknown model"}</span>
                    <GlassBadge tone="info">{d.bus}</GlassBadge>
                    <GlassBadge tone={healthTone(d.health)}>{d.health}</GlassBadge>
                  </div>
                  <div className="truncate font-mono text-[11px] text-slate-400">
                    {d.devpath} · {d.serial || "no serial"}
                  </div>
                  {d.by_id && <div className="truncate font-mono text-[10px] text-slate-500" title={d.by_id}>{d.by_id}</div>}
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-slate-100">{bytes(d.size)}</div>
                  <div className={`flex items-center justify-end gap-0.5 text-[11px] ${tempColor(temp)}`}>
                    <Thermometer size={11} /> {temp ?? "—"} °C
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                <div>
                  <div className="mb-1 flex justify-between text-slate-400">
                    <span>Life remaining</span>
                    <span className="text-slate-200">{life != null ? `${life}%` : d.rpm ? `${d.rpm} rpm` : "N/A"}</span>
                  </div>
                  <Bar value={life ?? 0} className={life == null ? "bg-slate-600" : life < 20 ? "bg-rose-400" : life < 50 ? "bg-amber-400" : "bg-emerald-400"} />
                </div>
                <div>
                  <div className="mb-1 text-slate-400">Usage</div>
                  <span className={d.used ? "text-slate-200" : "text-emerald-300"}>{d.used || "Unused"}</span>
                  {d.gpt && <span className="text-slate-500"> · GPT</span>}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{actions(d)}</div>
            </section>
          );
        })}
      </div>
      )}
      <SmartDrawer disk={smart} onClose={() => setSmart(null)} />
      <FormatDiskModal disk={format} onClose={() => setFormat(null)} onDone={onChanged} />
      <ConfirmModal
        open={!!wipe}
        onClose={() => setWipe(null)}
        onConfirm={confirmWipe}
        busy={busy}
        error={error}
        title="Wipe disk"
        confirmLabel="Wipe disk"
        expect={wipe?.devpath}
        message={
          <>
            <p>
              Partition tables and filesystem signatures on <span className="font-mono">{wipe?.devpath}</span> ({wipe?.model}, {wipe && bytes(wipe.size)}) are erased. Data on it
              becomes unreachable.
            </p>
            {wipe?.used && <p className="mt-2 text-amber-300">This disk is currently in use: {wipe.used}. Proxmox refuses to wipe disks that are mounted or part of an active pool.</p>}
          </>
        }
      />
    </div>
  );
}

/* ================================================================ Snapshots & schedules */

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `manual-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

function Snapshots() {
  const [data, setData] = useState<{ datasets: ZfsDataset[]; snapshots: ZfsSnapshot[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState("");
  const [name, setName] = useState(stamp);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(() => {
    api<{ datasets: ZfsDataset[]; snapshots: ZfsSnapshot[] }>("/pve/zfs/snapshots")
      .then((d) => (setData(d), setLoadError("")))
      .catch((e) => setLoadError(e.message));
  }, []);
  useEffect(load, [load]);
  const { busy, error, run } = useRunner(load);

  const create = (e: FormEvent) => {
    e.preventDefault();
    const dataset = target || filter || data?.datasets[0]?.name;
    if (dataset) run(() => api("/pve/zfs/snapshots", { method: "POST", json: { dataset, name } }).then(() => setName(stamp())));
  };

  const rollback = (s: ZfsSnapshot) => {
    const newer = (data?.snapshots ?? []).filter((x) => x.dataset === s.dataset && x.creation > s.creation);
    const warning = newer.length ? `\n\nThis also DESTROYS ${newer.length} newer snapshot(s): ${newer.map((x) => x.snapshot).join(", ")}.` : "";
    if (!window.confirm(`Roll back ${s.dataset} to "${s.snapshot}"? All changes made after it are lost.${warning}`)) return;
    run(() => api("/pve/zfs/snapshots/rollback", { method: "POST", json: { snapshot: s.name, force: newer.length > 0 } }));
  };

  const remove = (s: ZfsSnapshot) => {
    if (!window.confirm(`Delete snapshot ${s.name}? This cannot be undone.`)) return;
    run(() => api(`/pve/zfs/snapshots?snapshot=${encodeURIComponent(s.name)}`, { method: "DELETE" }));
  };

  const shown = useMemo(() => (data?.snapshots ?? []).filter((s) => !filter || s.dataset === filter || s.dataset.startsWith(`${filter}/`)), [data, filter]);

  if (!data) return loadError ? <Notice error={loadError} /> : <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Pool / dataset">
          <GlassSelect value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All datasets</option>
            {data.datasets.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <form onSubmit={create} className="ml-auto flex flex-wrap items-end gap-2">
          <Field label="Snapshot of">
            <GlassSelect value={target || filter} onChange={(e) => setTarget(e.target.value)}>
              {data.datasets.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label="Name">
            <GlassInput className="w-44" value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" required />
          </Field>
          <GlassButton type="submit" variant="primary" disabled={busy || !data.datasets.length}>
            <Camera size={12} /> Take snapshot
          </GlassButton>
        </form>
      </div>
      <Notice error={error} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 font-medium">Snapshot</th>
              <th className="px-2 font-medium">Dataset</th>
              <th className="px-2 font-medium">Created</th>
              <th className="px-2 text-right font-medium">Used</th>
              <th className="px-2 text-right font-medium">Refer</th>
              <th className="px-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-400">
                  No snapshots.
                </td>
              </tr>
            )}
            {shown.map((s) => (
              <tr key={s.name} className="border-t border-white/5">
                <td className="py-2 font-mono text-slate-200">{s.snapshot}</td>
                <td className="px-2 font-mono text-slate-400">{s.dataset}</td>
                <td className="px-2 text-slate-300">{new Date(s.creation * 1000).toLocaleString()}</td>
                <td className="px-2 text-right tabular-nums text-slate-300">{bytes(s.used)}</td>
                <td className="px-2 text-right tabular-nums text-slate-300">{bytes(s.refer)}</td>
                <td className="px-2">
                  <div className="flex justify-end gap-1">
                    <GlassButton size="xs" disabled={busy} onClick={() => rollback(s)} title="Roll back dataset to this snapshot">
                      <History size={12} /> Rollback
                    </GlassButton>
                    <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>
                      <Trash2 size={12} className="text-rose-300" />
                    </GlassButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Schedules() {
  const pools = useTelemetry((s) => s.storage?.pools ?? []);
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [datasets, setDatasets] = useState<string[]>([]);
  const [kind, setKind] = useState<Schedule["kind"]>("snapshot");
  const [target, setTarget] = useState("");
  const [period, setPeriod] = useState<Schedule["interval"]>("daily");
  const [retention, setRetention] = useState(7);

  const load = useCallback(() => {
    api<Schedule[]>("/schedules").then(setItems, () => setItems([]));
  }, []);
  const { busy, error, run } = useRunner(load);
  useEffect(() => {
    load();
    api<{ datasets: ZfsDataset[] }>("/pve/zfs/snapshots").then(
      (d) => setDatasets(d.datasets.filter((x) => x.type === "filesystem").map((x) => x.name)),
      () => {},
    );
  }, [load]);

  const targets = kind === "snapshot" ? datasets : pools.map((p) => p.name);
  const chosen = targets.includes(target) ? target : (targets[0] ?? "");

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/schedules", { method: "POST", json: { kind, target: chosen, interval: kind === "scrub" ? "monthly" : period, retention } }));
  };
  const remove = (s: Schedule) => {
    if (window.confirm(`Delete the ${s.interval} ${s.kind} schedule for ${s.target}? Existing snapshots are kept.`)) run(() => api(`/schedules/${s.id}`, { method: "DELETE" }));
  };

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="glass-soft flex flex-wrap items-end gap-2 rounded-2xl p-3">
        <Field label="Task">
          <GlassSelect value={kind} onChange={(e) => setKind(e.target.value as Schedule["kind"])}>
            <option value="snapshot">Automatic snapshot</option>
            <option value="scrub">Monthly pool scrub</option>
          </GlassSelect>
        </Field>
        <Field label={kind === "snapshot" ? "Dataset" : "Pool"}>
          <GlassSelect value={chosen} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </GlassSelect>
        </Field>
        {kind === "snapshot" && (
          <>
            <Field label="Interval">
              <GlassSelect value={period} onChange={(e) => setPeriod(e.target.value as Schedule["interval"])}>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </GlassSelect>
            </Field>
            <Field label="Keep last">
              <GlassInput type="number" min={1} max={1000} className="w-20" value={retention} onChange={(e) => setRetention(Number(e.target.value))} required />
            </Field>
          </>
        )}
        <GlassButton type="submit" variant="primary" className="ml-auto" disabled={busy || !chosen}>
          <Plus size={12} /> Add schedule
        </GlassButton>
      </form>
      <p className="text-[11px] text-slate-500">
        Automatic snapshots are named <span className="font-mono">proxmoxos-auto-&lt;interval&gt;-&lt;timestamp&gt;</span>. Older ones beyond the retention limit are deleted; manual
        snapshots are never touched. The first run happens one interval after the schedule is created.
      </p>
      <Notice error={error} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 font-medium">Task</th>
              <th className="px-2 font-medium">Target</th>
              <th className="px-2 font-medium">Interval</th>
              <th className="px-2 text-right font-medium">Keep</th>
              <th className="px-2 font-medium">Next run</th>
              <th className="px-2 font-medium">Last run</th>
              <th className="px-2 text-right font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {items?.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-400">
                  No schedules yet.
                </td>
              </tr>
            )}
            {items?.map((s) => (
              <tr key={s.id} className="border-t border-white/5">
                <td className="py-2 text-slate-200">{s.kind === "snapshot" ? "Snapshot" : "Scrub"}</td>
                <td className="px-2 font-mono text-slate-300">{s.target}</td>
                <td className="px-2 text-slate-300 capitalize">{s.interval}</td>
                <td className="px-2 text-right text-slate-300 tabular-nums">{s.kind === "snapshot" ? s.retention : "—"}</td>
                <td className="px-2 text-slate-300">{s.enabled ? when(s.next_run) : "Paused"}</td>
                <td className="px-2" title={s.last_error ?? ""}>
                  <span className={s.last_status === "error" ? "text-rose-300" : "text-slate-300"}>{when(s.last_run)}</span>
                  {s.last_status && <span className={`ml-1 ${s.last_status === "ok" ? "text-emerald-400" : "text-rose-400"}`}>{s.last_status === "ok" ? "✓" : "failed"}</span>}
                </td>
                <td className="px-2">
                  <div className="flex items-center justify-end gap-2">
                    <GlassSwitch checked={s.enabled} disabled={busy} onChange={(v) => run(() => api(`/schedules/${s.id}`, { method: "PATCH", json: { enabled: v } }))} />
                    <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => remove(s)} aria-label={`Delete schedule for ${s.target}`}>
                      <Trash2 size={12} className="text-rose-300" />
                    </GlassButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ================================================================ App shell */

/* ---------------- Storage backends (Datacenter → Storage) ---------------- */

interface StorageCfg {
  storage: string;
  type: string;
  content?: string;
  path?: string;
  pool?: string;
  vgname?: string;
  thinpool?: string;
  server?: string;
  export?: string;
  share?: string;
  disable?: number;
  shared?: number;
}

const ALL_CONTENT = ["iso", "vztmpl", "backup", "images", "rootdir", "snippets", "import"];
const BACKENDS = [
  { id: "dir", label: "Directory", content: ALL_CONTENT },
  { id: "lvm", label: "LVM", content: ["images", "rootdir"] },
  { id: "lvmthin", label: "LVM-Thin", content: ["images", "rootdir"] },
  { id: "zfspool", label: "ZFS", content: ["images", "rootdir"] },
  { id: "nfs", label: "NFS", content: ALL_CONTENT },
  { id: "cifs", label: "CIFS / SMB", content: ALL_CONTENT },
] as const;
type Backend = (typeof BACKENDS)[number]["id"];
const backendLabel = (t: string) => BACKENDS.find((b) => b.id === t)?.label ?? t;
const emptyBackend = {
  storage: "", type: "dir" as Backend, content: ["iso", "backup"], path: "", vgname: "", thinpool: "", pool: "",
  server: "", export: "", share: "", username: "", password: "", domain: "", shared: false, enable: true,
};

function StorageBackends() {
  const [items, setItems] = useState<StorageCfg[] | null>(null);
  const targets = useTelemetry((s) => s.storage?.targets);
  const refreshStorage = useTelemetry((s) => s.refreshStorage);
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const { busy, error, run, setError } = useRunner();
  const load = useCallback(() => {
    api<StorageCfg[]>("/pve/storage-config").then(setItems, (e) => setError(e.message));
    refreshStorage();
  }, [setError, refreshStorage]);
  useEffect(load, [load]);
  const toggle = (s: StorageCfg) => run(() => api(`/pve/storage-config/${s.storage}`, { method: "PUT", json: { enable: !!s.disable } }).then(load));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">Storage backends</h3>
        <GlassButton variant="primary" onClick={() => setOpen(true)}>
          <Plus size={13} /> Add storage
        </GlassButton>
      </div>
      <Notice error={error} />
      <div className="glass-soft overflow-x-auto rounded-2xl">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              {["ID", "Type", "Content", "Location", "Usage", "Shared", "Enabled", ""].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items === null && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {items?.map((s) => {
              const t = targets?.find((x) => x.storage === s.storage);
              const where = s.path || s.pool || [s.vgname, s.thinpool].filter(Boolean).join("/") || (s.server ? `${s.server}:${s.export ?? `//${s.share}`}` : "—");
              return (
                <tr key={s.storage} className="border-t border-white/5">
                  <td className="px-3 py-2 font-mono text-slate-100">{s.storage}</td>
                  <td className="px-3 py-2">
                    <GlassBadge tone="info">{backendLabel(s.type)}</GlassBadge>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{(s.content ?? "").split(",").join(", ")}</td>
                  <td className="max-w-48 truncate px-3 py-2 font-mono text-slate-400" title={where}>
                    {where}
                  </td>
                  <td className="w-40 px-3 py-2">
                    {t?.total ? (
                      <>
                        <Bar value={pct(t.used, t.total)} />
                        <div className="mt-1 text-[10px] text-slate-400 tabular-nums">
                          {bytes(t.used)} / {bytes(t.total)}
                        </div>
                      </>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{s.shared || s.type === "nfs" || s.type === "cifs" ? "Yes" : "No"}</td>
                  <td className="px-3 py-2">
                    <GlassSwitch checked={!s.disable} onChange={() => toggle(s)} disabled={busy} label="" />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <GlassButton variant="ghost" size="xs" className="text-rose-300" onClick={() => setRemove(s.storage)} aria-label={`Remove ${s.storage}`}>
                      <Trash2 size={12} />
                    </GlassButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <AddStorageModal open={open} onClose={() => setOpen(false)} onDone={load} />
      <ConfirmModal
        open={!!remove}
        onClose={() => setRemove(null)}
        busy={busy}
        error={error}
        title={`Remove storage ${remove}`}
        confirmLabel="Remove"
        expect={remove ?? undefined}
        message="Removes the storage definition from Proxmox only. Data on the disk, share or pool is not deleted, but guests using it lose access to their disks."
        onConfirm={async () => {
          if (await run(() => api(`/pve/storage-config/${remove}`, { method: "DELETE" }).then(load))) setRemove(null);
        }}
      />
    </div>
  );
}

function AddStorageModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(emptyBackend);
  const [scan, setScan] = useState<string[]>([]);
  const [scan2, setScan2] = useState<string[]>([]);
  const { busy, error, run, setError } = useRunner();
  useEffect(() => {
    if (!open) return;
    setF(emptyBackend);
    setError("");
  }, [open, setError]);
  const kind = BACKENDS.find((b) => b.id === f.type)!;
  const pick = (type: Backend) => {
    setF({ ...f, type, content: type === "dir" || type === "nfs" || type === "cifs" ? ["iso", "backup"] : ["images", "rootdir"] });
    setScan([]);
    setScan2([]);
  };

  // Local backends are scanned right away; network ones once a server is entered.
  useEffect(() => {
    if (!open) return;
    const q = (k: string) => api<Record<string, string>[]>(`/pve/storage-scan/${k}`);
    if (f.type === "lvm" || f.type === "lvmthin") q("lvm").then((r) => setScan(r.map((x) => x.vg)), () => setScan([]));
    if (f.type === "zfspool") q("zfs").then((r) => setScan(r.map((x) => x.pool)), () => setScan([]));
  }, [open, f.type]);
  useEffect(() => {
    if (f.type === "lvmthin" && f.vgname)
      api<Record<string, string>[]>(`/pve/storage-scan/lvmthin?vg=${encodeURIComponent(f.vgname)}`).then((r) => setScan2(r.map((x) => x.lv)), () => setScan2([]));
  }, [f.type, f.vgname]);
  const scanServer = () => {
    const p = new URLSearchParams({ server: f.server });
    if (f.type === "cifs" && f.username) {
      p.set("username", f.username);
      p.set("password", f.password);
      if (f.domain) p.set("domain", f.domain);
    }
    run(() => api<Record<string, string>[]>(`/pve/storage-scan/${f.type}?${p}`).then((r) => setScan(r.map((x) => (f.type === "nfs" ? x.path : x.share)))));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api("/pve/storage-config", { method: "POST", json: f }))) {
      onDone();
      onClose();
    }
  };
  type TextKey = "path" | "vgname" | "thinpool" | "pool" | "server" | "export" | "share" | "username" | "password" | "domain";
  const text = (k: TextKey, label: string, opts: { hint?: string; mono?: boolean; type?: string; list?: string[] } = {}) => (
    <Field label={label} hint={opts.hint}>
      <GlassInput className={`w-full ${opts.mono ? "font-mono" : ""}`} type={opts.type} list={opts.list?.length ? `scan-${k}` : undefined} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      {!!opts.list?.length && (
        <datalist id={`scan-${k}`}>
          {opts.list.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      )}
    </Field>
  );
  return (
    <GlassModal open={open} onClose={onClose} title="Add storage" width="max-w-2xl">
      <form onSubmit={submit} className="space-y-3">
        <Segmented value={f.type} onChange={pick} options={BACKENDS.map((b) => ({ id: b.id, label: b.label }))} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ID" hint="Lowercase name, e.g. nas-backup">
            <GlassInput className="w-full font-mono" value={f.storage} pattern="[a-z][a-z0-9_.\-]*[a-z0-9]" onChange={(e) => setF({ ...f, storage: e.target.value })} required />
          </Field>
          {f.type === "dir" && text("path", "Directory", { hint: "Absolute path on the host, e.g. /mnt/data", mono: true })}
          {(f.type === "lvm" || f.type === "lvmthin") && text("vgname", "Volume group", { mono: true, list: scan })}
          {f.type === "lvmthin" && text("thinpool", "Thin pool", { mono: true, list: scan2 })}
          {f.type === "zfspool" && text("pool", "ZFS pool / dataset", { mono: true, list: scan })}
          {(f.type === "nfs" || f.type === "cifs") && (
            <Field label="Server">
              <div className="flex gap-2">
                <GlassInput className="w-full font-mono" value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} required />
                <GlassButton disabled={!f.server || busy} onClick={scanServer} title="Scan server" aria-label="Scan server">
                  <ScanSearch size={13} />
                </GlassButton>
              </div>
            </Field>
          )}
          {f.type === "cifs" && text("username", "Username")}
          {f.type === "cifs" && text("password", "Password", { type: "password" })}
          {f.type === "cifs" && text("domain", "Domain (optional)")}
          {f.type === "nfs" && text("export", "Export", { mono: true, list: scan, hint: "Scan the server to list exports" })}
          {f.type === "cifs" && text("share", "Share", { mono: true, list: scan, hint: "Scan the server to list shares" })}
        </div>
        <div>
          <p className="mb-1 text-[11px] text-slate-400">Content</p>
          <div className="flex flex-wrap gap-3">
            {kind.content.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-xs text-slate-200">
                <input type="checkbox" checked={f.content.includes(c)} onChange={() => setF({ ...f, content: f.content.includes(c) ? f.content.filter((x) => x !== c) : [...f.content, c] })} />
                {c}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <GlassSwitch checked={f.enable} onChange={(v) => setF({ ...f, enable: v })} label="Enabled" />
          {(f.type === "dir" || f.type === "lvm") && <GlassSwitch checked={f.shared} onChange={(v) => setF({ ...f, shared: v })} label="Shared (same storage on every node)" />}
        </div>
        <Notice error={error} />
        <div className="flex justify-end gap-2">
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton type="submit" variant="primary" disabled={busy || !f.content.length}>
            Add storage
          </GlassButton>
        </div>
      </form>
    </GlassModal>
  );
}

export default function StorageManager() {
  const [tab, setTab] = useState<Tab>("overview");
  const { storage, refreshStorage } = useTelemetry();
  const [disks, setDisks] = useState<PveDisk[] | null>(null);
  const [parents, setParents] = useState<string[]>([]);
  const [modal, setModal] = useState<"pool" | "dataset" | null>(null);
  const [version, setVersion] = useState(0);

  const loadDisks = useCallback(() => {
    api<PveDisk[]>("/pve/disks").then(setDisks, () => setDisks([]));
  }, []);
  const refreshAll = useCallback(() => {
    refreshStorage();
    loadDisks();
    setVersion((v) => v + 1);
  }, [refreshStorage, loadDisks]);
  // PVE disk/pool tasks finish asynchronously; refresh again once they have had time to complete.
  const afterTask = useCallback(() => {
    refreshAll();
    setTimeout(refreshAll, 5000);
  }, [refreshAll]);

  useEffect(refreshAll, [refreshAll]);
  useIntentFor("storage", (v) => {
    if (v === "pool" || v === "dataset") {
      if (v === "pool") loadDisks();
      setModal(v);
    } else setTab(v);
  });
  useEffect(() => {
    if (modal === "dataset")
      api<ZfsDatasetInfo[]>("/pve/zfs/datasets").then(
        (d) => setParents(d.filter((x) => x.type === "filesystem" && !x.guest_volume).map((x) => x.name)),
        () => setParents(storage?.pools.map((p) => p.name) ?? []),
      );
  }, [modal, storage]);

  return (
    <div className="flex h-full">
      <nav className="w-48 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
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
        <button onClick={refreshAll} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 hover:text-slate-200" title="Refresh">
          <RefreshCw size={15} /> <span className="max-sm:hidden">Refresh</span>
        </button>
      </nav>

      <div className="min-w-0 flex-1 overflow-auto p-4">
        {tab === "backends" ? (
          <StorageBackends />
        ) : tab === "snapshots" ? (
          <div className="space-y-8">
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Camera size={15} /> Snapshots
              </h3>
              <Snapshots />
            </section>
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
                <CalendarClock size={15} /> Schedules
              </h3>
              <Schedules />
            </section>
          </div>
        ) : tab === "datasets" ? (
          <Datasets version={version} onCreate={() => setModal("dataset")} />
        ) : tab === "disks" ? (
          <Disks disks={disks} onChanged={afterTask} />
        ) : !storage ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : tab === "overview" ? (
          <Overview storage={storage} onCreatePool={() => (loadDisks(), setModal("pool"))} onCreateDataset={() => setModal("dataset")} />
        ) : (
          <Pools storage={storage} onCreate={() => (loadDisks(), setModal("pool"))} onChanged={afterTask} />
        )}
      </div>
      <CreatePoolModal open={modal === "pool"} onClose={() => setModal(null)} disks={disks ?? []} onDone={afterTask} />
      <CreateDatasetModal open={modal === "dataset"} onClose={() => setModal(null)} parents={parents} onDone={refreshAll} />
    </div>
  );
}
