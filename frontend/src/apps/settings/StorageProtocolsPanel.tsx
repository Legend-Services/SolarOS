import { useCallback, useEffect, useState } from "react";
import { ChevronRight, File, Folder, HardDrive, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { bytes } from "../../lib/format";
import type { Guest } from "../../lib/types";
import { useTranslation } from "../../i18n";
import { Card } from "../ControlPanelApp";
import { ConfirmModal, Field, GlassButton, GlassCheckbox, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice } from "../../components/ui/GlassKit";
import { when, withItem } from "./netstore/lists";

interface NfsClient {
  network: string;
  read_only: boolean;
  root_squash: boolean;
}
interface NfsShare {
  name: string;
  path: string;
  clients: NfsClient[];
}
interface DavUser {
  username: string;
  password: string;
  stored: boolean;
}
interface DavShare {
  name: string;
  path: string;
  read_only: boolean;
  users: DavUser[];
}
interface Snapshot {
  name: string;
  created: number;
  used: number;
}
interface Entry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
}
interface Drive {
  device: string;
  name: string;
  size: string | null;
  fstype: string | null;
  label: string | null;
  model: string;
  mountpoint: string | null;
  type: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const NEW_CLIENT: NfsClient = { network: "", read_only: false, root_squash: true };

/** Settings > Storage & Data > Shared Folders: NFS & WebDAV, snapshot file restore and USB drives. */
export default function StorageProtocolsPanel({ view }: { view: "protocols" | "snapshots" | "usb" }) {
  if (view === "snapshots") return <SnapshotBrowser />;
  if (view === "usb") return <UsbDrives />;
  return (
    <div className="space-y-4">
      <NfsCard />
      <DavCard />
    </div>
  );
}

function RemoveButton({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <GlassButton size="xs" variant="ghost" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <Trash2 size={12} />
    </GlassButton>
  );
}

function NfsCard() {
  const { t } = useTranslation();
  const [shares, setShares] = useState<NfsShare[] | null>(null);
  const [active, setActive] = useState("");
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(
    () =>
      api<{ shares: NfsShare[]; active: string }>("/storage/nfs").then((r) => {
        setShares(r.shares);
        setActive(r.active);
      }),
    [],
  );
  useEffect(() => void run(load), [run, load]);
  if (!shares) return <Notice error={error} />;
  const set = (i: number, patch: Partial<NfsShare>) => setShares(withItem(shares, i, { ...shares[i], ...patch }));

  return (
    <div data-anchor="nfs-shares">
      <Card
        title={t("nfs.title")}
        action={
          <GlassButton size="xs" onClick={() => setShares([...shares, { name: "", path: "/mnt/", clients: [NEW_CLIENT] }])}>
            <Plus size={12} /> {t("nfs.add")}
          </GlassButton>
        }
      >
        <p className="mb-3 text-[11px] text-slate-400">{t("nfs.hint")}</p>
        {shares.length === 0 && <p className="mb-3 text-xs text-slate-500">{t("nfs.empty")}</p>}
        <div className="space-y-3">
          {shares.map((s, i) => (
            <div key={i} className="rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10">
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t("nfs.name")}>
                  <GlassInput className="w-36" value={s.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="media" spellCheck={false} />
                </Field>
                <Field label={t("nfs.path")} className="min-w-48 flex-1">
                  <GlassInput className="w-full font-mono" value={s.path} onChange={(e) => set(i, { path: e.target.value })} placeholder="/mnt/tank/media" spellCheck={false} />
                </Field>
                <RemoveButton label={t("nfs.remove")} onClick={() => setShares(withItem(shares, i, null))} />
              </div>
              <div className="mt-2 space-y-1.5">
                {s.clients.map((c, n) => (
                  <div key={n} className="flex flex-wrap items-center gap-3">
                    <GlassInput
                      className="w-48 font-mono"
                      aria-label={t("nfs.client")}
                      value={c.network}
                      onChange={(e) => set(i, { clients: withItem(s.clients, n, { ...c, network: e.target.value.trim() }) })}
                      placeholder="192.168.1.0/24"
                      spellCheck={false}
                    />
                    <GlassCheckbox checked={c.read_only} onChange={(read_only) => set(i, { clients: withItem(s.clients, n, { ...c, read_only }) })} label={t("nfs.readOnly")} />
                    <GlassCheckbox checked={c.root_squash} onChange={(root_squash) => set(i, { clients: withItem(s.clients, n, { ...c, root_squash }) })} label={t("nfs.rootSquash")} />
                    <RemoveButton label={t("nfs.removeClient")} disabled={s.clients.length === 1} onClick={() => set(i, { clients: withItem(s.clients, n, null) })} />
                  </div>
                ))}
                <GlassButton size="xs" variant="ghost" onClick={() => set(i, { clients: [...s.clients, NEW_CLIENT] })}>
                  <Plus size={12} /> {t("nfs.addClient")}
                </GlassButton>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <GlassButton variant="primary" disabled={busy || shares.some((s) => !NAME_RE.test(s.name) || s.clients.some((c) => !c.network))} onClick={() => run(() => api("/storage/nfs", { method: "PUT", json: shares }).then(load), t("nfs.saved"))}>
            {busy ? t("fw.working") : t("fw.save")}
          </GlassButton>
          <Notice error={error} notice={notice} />
        </div>
        <h4 className="mt-4 mb-1.5 text-xs font-semibold text-slate-200">{t("nfs.active")}</h4>
        <pre className="max-h-48 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[10px] text-slate-300">{active.trim() || t("nfs.activeNone")}</pre>
      </Card>
    </div>
  );
}

function DavCard() {
  const { t } = useTranslation();
  const [port, setPort] = useState(8090);
  const [shares, setShares] = useState<DavShare[] | null>(null);
  const [host, setHost] = useState(location.hostname);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(
    () =>
      api<{ port: number; shares: (Omit<DavShare, "users"> & { users: string[] })[] }>("/storage/webdav").then((r) => {
        setPort(r.port);
        setShares(r.shares.map((s) => ({ ...s, users: s.users.map((username) => ({ username, password: "", stored: true })) })));
      }),
    [],
  );
  useEffect(() => void run(load), [run, load]);
  useEffect(() => {
    api<{ host_ip?: string }>("/net/status").then((s) => s.host_ip && setHost(s.host_ip), () => undefined);
  }, []);
  if (!shares) return <Notice error={error} />;
  const set = (i: number, patch: Partial<DavShare>) => setShares(withItem(shares, i, { ...shares[i], ...patch }));
  const newUser: DavUser = { username: "", password: "", stored: false };
  const save = () =>
    run(
      () =>
        api("/storage/webdav", {
          method: "PUT",
          json: { port, shares: shares.map((s) => ({ ...s, users: s.users.map((u) => ({ username: u.username, password: u.password || null })) })) },
        }).then(load),
      t("dav.saved"),
    );

  return (
    <div data-anchor="dav-shares">
      <Card
        title={t("dav.title")}
        action={
          <GlassButton size="xs" onClick={() => setShares([...shares, { name: "", path: "/mnt/", read_only: true, users: [newUser] }])}>
            <Plus size={12} /> {t("dav.add")}
          </GlassButton>
        }
      >
        <p className="mb-3 text-[11px] text-slate-400">{t("dav.hint")}</p>
        <Field label={t("dav.port")} className="mb-3 w-32">
          <GlassInput type="number" min={1024} max={65535} className="w-full" value={port} onChange={(e) => setPort(Number(e.target.value))} />
        </Field>
        {shares.length === 0 && <p className="mb-3 text-xs text-slate-500">{t("dav.empty")}</p>}
        <div className="space-y-3">
          {shares.map((s, i) => (
            <div key={i} className="rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10">
              <div className="flex flex-wrap items-end gap-2">
                <Field label={t("nfs.name")}>
                  <GlassInput className="w-36" value={s.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="documents" spellCheck={false} />
                </Field>
                <Field label={t("nfs.path")} className="min-w-48 flex-1">
                  <GlassInput className="w-full font-mono" value={s.path} onChange={(e) => set(i, { path: e.target.value })} placeholder="/mnt/tank/documents" spellCheck={false} />
                </Field>
                <GlassSwitch checked={s.read_only} onChange={(read_only) => set(i, { read_only })} label={t("nfs.readOnly")} className="mb-1.5" />
                <RemoveButton label={t("nfs.remove")} onClick={() => setShares(withItem(shares, i, null))} />
              </div>
              {NAME_RE.test(s.name) && (
                <p className="mt-1.5 font-mono text-[11px] text-sky-200 select-all">{`https://${host}:${port}/${s.name}/`}</p>
              )}
              <div className="mt-2 space-y-1.5">
                {s.users.map((u, n) => (
                  <div key={n} className="flex flex-wrap items-center gap-2">
                    <GlassInput
                      className="w-40"
                      aria-label={t("dav.username")}
                      placeholder={t("dav.username")}
                      value={u.username}
                      onChange={(e) => set(i, { users: withItem(s.users, n, { ...u, username: e.target.value.trim(), stored: false }) })}
                      autoComplete="off"
                    />
                    <GlassInput
                      type="password"
                      className="w-48"
                      aria-label={t("dav.password")}
                      placeholder={u.stored ? t("dav.passwordKeep") : t("dav.password")}
                      value={u.password}
                      onChange={(e) => set(i, { users: withItem(s.users, n, { ...u, password: e.target.value }) })}
                      autoComplete="new-password"
                    />
                    <RemoveButton label={t("dav.removeUser")} disabled={s.users.length === 1} onClick={() => set(i, { users: withItem(s.users, n, null) })} />
                  </div>
                ))}
                <GlassButton size="xs" variant="ghost" onClick={() => set(i, { users: [...s.users, newUser] })}>
                  <Plus size={12} /> {t("dav.addUser")}
                </GlassButton>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <GlassButton
            variant="primary"
            disabled={busy || shares.some((s) => !NAME_RE.test(s.name) || s.users.some((u) => !u.username || (!u.stored && u.password.length < 8)))}
            onClick={save}
          >
            {busy ? t("fw.working") : t("fw.save")}
          </GlassButton>
          <Notice error={error} notice={notice} />
        </div>
        <p className="mt-3 text-[11px] text-slate-500">{t("dav.cert")}</p>
      </Card>
    </div>
  );
}

function SnapshotBrowser() {
  const { t } = useTranslation();
  const [sets, setSets] = useState<{ dataset: string; snapshots: Snapshot[] }[] | null>(null);
  const [sel, setSel] = useState({ dataset: "", snapshot: "", path: "" });
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [restore, setRestore] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [restoredTo, setRestoredTo] = useState("");
  const { busy, error, run } = useRunner();
  const loadSets = useCallback(
    () =>
      api<{ dataset: string; snapshots: Snapshot[] }[]>("/storage/snapshots/datasets").then((r) => {
        setSets(r);
        setSel((s) => (s.dataset || !r[0] ? s : { dataset: r[0].dataset, snapshot: r[0].snapshots[0]?.name ?? "", path: "" }));
      }),
    [],
  );
  useEffect(() => void run(loadSets), [run, loadSets]);
  useEffect(() => {
    if (!sel.dataset || !sel.snapshot) return;
    setEntries(null);
    void run(() => api<{ entries: Entry[] }>(`/storage/snapshots/browse?${new URLSearchParams(sel)}`).then((r) => setEntries(r.entries)));
  }, [run, sel]);
  if (!sets) return <Notice error={error} />;

  const snaps = sets.find((d) => d.dataset === sel.dataset)?.snapshots ?? [];
  const crumbs = sel.path ? sel.path.split("/") : [];
  const join = (name: string) => (sel.path ? `${sel.path}/${name}` : name);
  const doRestore = (path: string) =>
    run(async () => {
      setRestoredTo("");
      const r = await api<{ restored_to: string }>("/storage/snapshots/restore-file", { method: "POST", json: { dataset: sel.dataset, snapshot: sel.snapshot, path, overwrite } });
      setRestoredTo(r.restored_to);
      setRestore(null);
    });

  return (
    <div data-anchor="snap-browser">
      <Card
        title={t("snap.title")}
        action={
          <GlassButton size="xs" variant="ghost" onClick={() => run(loadSets)} disabled={busy} aria-label={t("fw.refresh")}>
            <RefreshCw size={12} />
          </GlassButton>
        }
      >
        <p className="mb-3 text-[11px] text-slate-400">{t("snap.hint")}</p>
        {sets.length === 0 ? (
          <p className="text-xs text-slate-500">{t("snap.none")}</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-3">
              <Field label={t("snap.dataset")}>
                <GlassSelect className="w-64" value={sel.dataset} onChange={(e) => setSel({ dataset: e.target.value, snapshot: sets.find((d) => d.dataset === e.target.value)?.snapshots[0]?.name ?? "", path: "" })}>
                  {sets.map((d) => (
                    <option key={d.dataset}>{d.dataset}</option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label={t("snap.snapshot")}>
                <GlassSelect className="w-72" value={sel.snapshot} onChange={(e) => setSel({ ...sel, snapshot: e.target.value, path: "" })}>
                  {snaps.map((s) => (
                    <option key={s.name} value={s.name}>
                      {`${s.name} · ${when(s.created)} · ${bytes(s.used)}`}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
            </div>
            <nav className="mb-2 flex flex-wrap items-center gap-0.5 text-xs text-slate-300">
              <button type="button" className="font-mono hover:text-white" onClick={() => setSel({ ...sel, path: "" })}>
                {`${sel.dataset}@${sel.snapshot}`}
              </button>
              {crumbs.map((c, n) => (
                <span key={n} className="inline-flex items-center gap-0.5">
                  <ChevronRight size={12} className="text-slate-500" />
                  <button type="button" className="hover:text-white" onClick={() => setSel({ ...sel, path: crumbs.slice(0, n + 1).join("/") })}>
                    {c}
                  </button>
                </span>
              ))}
            </nav>
            <Notice notice={restoredTo && t("snap.restored", { path: restoredTo })} error={restore ? "" : error} />
            <div className="mt-2 max-h-[60vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1.5">{t("snap.name")}</th>
                    <th className="px-2">{t("snap.size")}</th>
                    <th className="px-2 max-md:hidden">{t("snap.modified")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {entries?.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-2 text-slate-500">
                        {t("snap.empty")}
                      </td>
                    </tr>
                  )}
                  {entries?.map((e) => (
                    <tr key={e.name} className="border-t border-white/5">
                      <td className="py-1.5">
                        {e.type === "dir" ? (
                          <button type="button" className="inline-flex items-center gap-1.5 text-sky-200 hover:text-white" onClick={() => setSel({ ...sel, path: join(e.name) })}>
                            <Folder size={13} /> {e.name}
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-slate-100">
                            <File size={13} className="text-slate-400" /> {e.name}
                          </span>
                        )}
                      </td>
                      <td className="px-2 text-slate-400 tabular-nums">{e.type === "dir" ? "—" : bytes(e.size)}</td>
                      <td className="px-2 text-slate-400 max-md:hidden">{when(e.mtime)}</td>
                      <td className="text-right">
                        <GlassButton
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setOverwrite(false);
                            setRestore(join(e.name));
                          }}
                        >
                          <RotateCcw size={12} /> {t("snap.restore")}
                        </GlassButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      <ConfirmModal
        open={!!restore}
        onClose={() => setRestore(null)}
        onConfirm={() => restore && void doRestore(restore)}
        title={t("snap.restoreTitle")}
        message={t("snap.restoreMsg", { path: restore ?? "", snapshot: sel.snapshot })}
        confirmLabel={t("snap.restore")}
        busy={busy}
        error={error}
      >
        <GlassCheckbox checked={overwrite} onChange={setOverwrite} label={t("snap.overwrite")} />
        <p className="text-[11px] text-slate-500">{overwrite ? t("snap.overwriteOn") : t("snap.overwriteOff")}</p>
      </ConfirmModal>
    </div>
  );
}

function UsbDrives() {
  const { t } = useTranslation();
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [mount, setMount] = useState<{ drive: Drive; name: string; read_only: boolean } | null>(null);
  const [attach, setAttach] = useState<{ drive: Drive; vmid: number } | null>(null);
  const [vms, setVms] = useState<Guest[]>([]);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<{ drives: Drive[] }>("/storage/usb").then((r) => setDrives(r.drives)), []);
  useEffect(() => void run(load), [run, load]);
  useEffect(() => {
    api<Guest[]>("/v1/guests").then((g) => setVms(g.filter((x) => x.type === "qemu")), () => setVms([]));
  }, []);
  if (!drives) return <Notice error={error} />;

  // Unmount only knows drives SolarDeck mounted itself (/mnt/usb/<name>).
  const ownMount = (d: Drive) => d.mountpoint?.match(/^\/mnt\/usb\/([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/)?.[1];
  const suggest = (d: Drive) => (d.label || d.name).replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 32) || "usb";
  const doMount = () =>
    mount &&
    run(async () => {
      await api("/storage/usb/mount", { method: "POST", json: { device: mount.drive.device, name: mount.name, read_only: mount.read_only } });
      setMount(null);
      await load();
    }, t("usb.mounted", { path: `/mnt/usb/${mount.name}` }));
  const doAttach = () =>
    attach &&
    run(async () => {
      await api("/storage/usb/attach", { method: "POST", json: { device: attach.drive.device, vmid: attach.vmid } });
      setAttach(null);
    }, t("usb.attached", { vmid: attach.vmid }));

  return (
    <div data-anchor="usb-drives">
      <Card
        title={t("usb.title")}
        action={
          <GlassButton size="xs" variant="ghost" onClick={() => run(load)} disabled={busy} aria-label={t("fw.refresh")}>
            <RefreshCw size={12} />
          </GlassButton>
        }
      >
        <Notice error={mount || attach ? "" : error} notice={notice} />
        {drives.length === 0 ? (
          <p className="text-xs text-slate-500">{t("usb.none")}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1.5">{t("usb.model")}</th>
                  <th className="px-2">{t("usb.label")}</th>
                  <th className="px-2">{t("snap.size")}</th>
                  <th className="px-2">{t("usb.fs")}</th>
                  <th className="px-2 max-md:hidden">{t("usb.device")}</th>
                  <th className="px-2">{t("usb.mountedAt")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {drives.map((d) => {
                  const own = ownMount(d);
                  return (
                    <tr key={d.device} className="border-t border-white/5">
                      <td className="py-1.5 text-slate-100">
                        <span className="inline-flex items-center gap-1.5">
                          <HardDrive size={13} className="text-slate-400" />
                          {d.model || "—"}
                        </span>
                      </td>
                      <td className="px-2 text-slate-300">{d.label || "—"}</td>
                      <td className="px-2 text-slate-300 tabular-nums">{d.size || "—"}</td>
                      <td className="px-2 text-slate-300">{d.fstype || "—"}</td>
                      <td className="px-2 font-mono text-[10px] text-slate-400 max-md:hidden" title={d.device}>
                        {`/dev/${d.name} · ${d.type}`}
                      </td>
                      <td className="px-2 font-mono text-slate-300">{d.mountpoint || "—"}</td>
                      <td className="whitespace-nowrap text-right">
                        {d.mountpoint ? (
                          <GlassButton
                            size="xs"
                            variant="ghost"
                            disabled={busy || !own}
                            title={own ? undefined : t("usb.foreign")}
                            onClick={() => own && run(() => api("/storage/usb/unmount", { method: "POST", json: { device: d.device, name: own, read_only: false } }).then(load), t("usb.unmounted"))}
                          >
                            {t("usb.unmount")}
                          </GlassButton>
                        ) : (
                          <>
                            {d.fstype && (
                              <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => setMount({ drive: d, name: suggest(d), read_only: false })}>
                                {t("usb.mount")}
                              </GlassButton>
                            )}
                            <GlassButton size="xs" variant="ghost" disabled={busy || !vms.length} onClick={() => setAttach({ drive: d, vmid: vms[0].vmid })}>
                              {t("usb.attach")}
                            </GlassButton>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <GlassModal
        open={!!mount}
        onClose={() => setMount(null)}
        title={t("usb.mountTitle")}
        footer={
          <>
            <GlassButton onClick={() => setMount(null)}>{t("fw.cancel")}</GlassButton>
            <GlassButton variant="primary" disabled={busy || !mount || !NAME_RE.test(mount.name)} onClick={doMount}>
              {t("usb.mount")}
            </GlassButton>
          </>
        }
      >
        {mount && (
          <div className="space-y-3">
            <Field label={t("usb.name")} hint={t("usb.nameHint", { path: `/mnt/usb/${mount.name}` })}>
              <GlassInput className="w-full font-mono" value={mount.name} onChange={(e) => setMount({ ...mount, name: e.target.value })} spellCheck={false} />
            </Field>
            <GlassSwitch checked={mount.read_only} onChange={(read_only) => setMount({ ...mount, read_only })} label={t("nfs.readOnly")} />
            <Notice error={error} />
          </div>
        )}
      </GlassModal>

      <GlassModal
        open={!!attach}
        onClose={() => setAttach(null)}
        title={t("usb.attachTitle")}
        footer={
          <>
            <GlassButton onClick={() => setAttach(null)}>{t("fw.cancel")}</GlassButton>
            <GlassButton variant="primary" disabled={busy} onClick={doAttach}>
              {t("usb.attach")}
            </GlassButton>
          </>
        }
      >
        {attach && (
          <div className="space-y-3">
            <Field label={t("usb.vm")}>
              <GlassSelect className="w-full" value={attach.vmid} onChange={(e) => setAttach({ ...attach, vmid: Number(e.target.value) })}>
                {vms.map((g) => (
                  <option key={g.vmid} value={g.vmid}>{`${g.vmid} · ${g.name}`}</option>
                ))}
              </GlassSelect>
            </Field>
            <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200 ring-1 ring-amber-300/20 ring-inset">{t("usb.attachWarn")}</p>
            <Notice error={error} />
          </div>
        )}
      </GlassModal>
    </div>
  );
}
