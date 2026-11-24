import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, FolderOpen, Plus, Share2, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../lib/api";
import type { Share, ZfsDatasetInfo } from "../lib/types";
import { useRunner } from "../lib/hooks";
import { Field, GlassBadge, GlassButton, GlassInput, GlassSelect, GlassSwitch, Notice } from "../components/ui/GlassKit";

type Tab = "shares" | "users";

async function copyText(text: string) {
  // navigator.clipboard only exists in secure contexts; the UI is usually plain http on the LAN.
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function CopyPath({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="flex min-w-0 items-center gap-1.5 rounded-md bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-300 hover:bg-black/50"
      onClick={() => copyText(value).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
      title={`Copy ${label} path`}
    >
      <span className="shrink-0 font-sans text-[10px] text-slate-500">{label}</span>
      <span className="truncate">{value}</span>
      {done ? <Check size={11} className="shrink-0 text-emerald-300" /> : <Copy size={11} className="shrink-0" />}
    </button>
  );
}

function ShareForm({ users, onDone }: { users: string[]; onDone: () => void }) {
  const [f, setF] = useState({
    name: "",
    path: "",
    comment: "",
    read_only: false,
    guest_ok: false,
    browseable: true,
    recycle_bin: false,
    timemachine: false,
    users: [] as string[],
  });
  const [withDataset, setWithDataset] = useState(false);
  const [parents, setParents] = useState<string[]>([]);
  const [parent, setParent] = useState("");
  const { busy, error, run } = useRunner();
  const base = parents.includes(parent) ? parent : (parents[0] ?? "");

  useEffect(() => {
    api<ZfsDatasetInfo[]>("/pve/zfs/datasets").then(
      (d) => setParents(d.filter((x) => x.type === "filesystem" && !x.guest_volume).map((x) => x.name)),
      () => {},
    );
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const json = withDataset ? { ...f, dataset: `${base}/${f.name}`, create_dataset: true } : { ...f, path: f.path || `/${f.name}` };
    if (await run(() => api("/shares", { method: "POST", json }))) onDone();
  };
  const toggle = (k: "read_only" | "guest_ok" | "browseable" | "recycle_bin" | "timemachine") => (v: boolean) => setF({ ...f, [k]: v });

  return (
    <form onSubmit={submit} className="glass-soft space-y-4 rounded-2xl p-4">
      <h3 className="text-sm font-semibold text-white">New shared folder</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Share name">
          <GlassInput className="w-full" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" required />
        </Field>
        {withDataset ? (
          <Field label="Create dataset under" hint={base && f.name ? `New ZFS dataset ${base}/${f.name}, mounted at /mnt/storage/${base}/${f.name}` : undefined}>
            <GlassSelect className="w-full" value={base} onChange={(e) => setParent(e.target.value)}>
              {parents.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </GlassSelect>
          </Field>
        ) : (
          <Field label="Folder in /mnt/storage">
            <GlassInput className="w-full" value={f.path} placeholder={`/${f.name || "media"}`} onChange={(e) => setF({ ...f, path: e.target.value })} />
          </Field>
        )}
      </div>
      <GlassSwitch
        checked={withDataset}
        onChange={setWithDataset}
        disabled={!parents.length}
        label={parents.length ? "Create a dedicated ZFS dataset for this share" : "Create a dedicated ZFS dataset (no ZFS pool available)"}
      />
      <Field label="Description">
        <GlassInput className="w-full" value={f.comment} maxLength={100} onChange={(e) => setF({ ...f, comment: e.target.value })} />
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <GlassSwitch checked={f.read_only} onChange={toggle("read_only")} label="Read-only" />
        <GlassSwitch checked={f.guest_ok} onChange={toggle("guest_ok")} label="Guest access (no password)" />
        <GlassSwitch checked={f.recycle_bin} onChange={toggle("recycle_bin")} label="Recycle bin (.recycle folder)" />
        <GlassSwitch checked={f.timemachine} onChange={toggle("timemachine")} label="macOS Time Machine target" />
        <GlassSwitch checked={f.browseable} onChange={toggle("browseable")} label="Visible in network browsing" />
      </div>
      <fieldset>
        <legend className="mb-1.5 text-[11px] text-slate-400">Allowed users {f.users.length === 0 && "(none selected: any Samba user)"}</legend>
        <div className="flex flex-wrap gap-2">
          {users.length === 0 && <span className="text-[11px] text-slate-500">No Samba users yet — add them in the Users tab.</span>}
          {users.map((u) => {
            const on = f.users.includes(u);
            return (
              <button
                key={u}
                type="button"
                aria-pressed={on}
                onClick={() => setF({ ...f, users: on ? f.users.filter((x) => x !== u) : [...f.users, u] })}
                className={`rounded-full px-2.5 py-1 text-xs ring-1 transition active:scale-95 ring-inset ${on ? "bg-sky-500/25 text-white ring-sky-300/40" : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"}`}
              >
                {u}
              </button>
            );
          })}
        </div>
      </fieldset>
      <Notice error={error} />
      <div className="flex justify-end gap-2">
        <GlassButton onClick={onDone}>Cancel</GlassButton>
        <GlassButton type="submit" variant="primary" disabled={busy}>
          {withDataset ? "Create share + dataset" : "Create share"}
        </GlassButton>
      </div>
    </form>
  );
}

function UsersTab({ users, reload }: { users: string[]; reload: () => void }) {
  const [f, setF] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api("/shares/users", { method: "POST", json: f });
      setMsg(users.includes(f.username) ? `Password for ${f.username} updated.` : `User ${f.username} created.`);
      setF({ username: "", password: "" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (u: string) => {
    if (!window.confirm(`Remove Samba user ${u}? They will no longer be able to connect.`)) return;
    try {
      await api(`/shares/users/${encodeURIComponent(u)}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="glass-soft flex flex-wrap items-end gap-2 rounded-2xl p-4">
        <Field label="Username">
          <GlassInput className="w-40" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} pattern="[a-z_][a-z0-9_\-]{0,31}" required />
        </Field>
        <Field label="Password">
          <GlassInput type="password" className="w-40" value={f.password} minLength={4} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required />
        </Field>
        <GlassButton type="submit" variant="primary">
          <UserPlus size={12} /> Add / set password
        </GlassButton>
      </form>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {msg && !error && <p className="text-xs text-emerald-300">{msg}</p>}
      <ul className="space-y-1">
        {users.length === 0 && <li className="text-sm text-slate-400">No Samba users.</li>}
        {users.map((u) => (
          <li key={u} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-200">
            <Users size={13} className="text-slate-400" />
            <span className="flex-1">{u}</span>
            <GlassButton size="xs" variant="ghost" onClick={() => remove(u)} aria-label={`Remove ${u}`}>
              <Trash2 size={12} className="text-rose-300" />
            </GlassButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SharesManager() {
  const [tab, setTab] = useState<Tab>("shares");
  const [shares, setShares] = useState<Share[] | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const host = location.hostname;

  const load = useCallback(() => {
    api<Share[]>("/shares")
      .then((s) => (setShares(s), setError("")))
      .catch((e) => setError(e.message));
    api<{ username: string }[]>("/shares/users")
      .then((u) => setUsers(u.map((x) => x.username)))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const remove = async (s: Share) => {
    if (!window.confirm(`Stop sharing "${s.name}"? The folder ${s.path} and its files are kept.`)) return;
    try {
      await api(`/shares/${encodeURIComponent(s.name)}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex h-full">
      <nav className="w-44 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        {(
          [
            ["shares", "Shared Folders", Share2],
            ["users", "Users", Users],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id}
            title={label}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${
              tab === id ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <Icon size={15} />
            <span className="max-sm:hidden">{label}</span>
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 space-y-4 overflow-auto p-4">
        {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
        {tab === "users" ? (
          <UsersTab users={users} reload={load} />
        ) : (
          <>
            <div className="flex items-center">
              <h3 className="text-sm font-semibold text-white">SMB shared folders</h3>
              {!creating && (
                <GlassButton variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
                  <Plus size={12} /> Create share
                </GlassButton>
              )}
            </div>
            {creating && <ShareForm users={users} onDone={() => (setCreating(false), load())} />}
            {shares === null && !error && <p className="text-sm text-slate-400">Loading…</p>}
            {shares?.length === 0 && !creating && <p className="text-sm text-slate-400">No shares yet. Create one to access /mnt/storage folders from your computers.</p>}
            {shares?.map((s) => (
              <section key={s.name} className="glass-soft space-y-2 rounded-2xl p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <FolderOpen size={16} className="text-cyan-300" />
                  <h4 className="text-sm font-semibold text-white">{s.name}</h4>
                  <span className="font-mono text-[11px] text-slate-400">{s.path}</span>
                  <GlassBadge tone={s.read_only ? "warning" : "success"}>{s.read_only ? "READ-ONLY" : "READ/WRITE"}</GlassBadge>
                  {s.guest_ok && <GlassBadge tone="info">GUEST</GlassBadge>}
                  {s.timemachine && <GlassBadge tone="info">TIME MACHINE</GlassBadge>}
                  {s.recycle_bin && <GlassBadge>RECYCLE BIN</GlassBadge>}
                  {!s.browseable && <GlassBadge>HIDDEN</GlassBadge>}
                  <GlassButton size="xs" variant="danger" className="ml-auto" onClick={() => remove(s)} aria-label={`Delete share ${s.name}`}>
                    <Trash2 size={12} /> Remove
                  </GlassButton>
                </div>
                {s.comment && <p className="text-xs text-slate-400">{s.comment}</p>}
                <p className="text-[11px] text-slate-400">Users: {s.users.length ? s.users.join(", ") : "any Samba user"}</p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <CopyPath label="macOS / Linux" value={`smb://${host}/${s.name}`} />
                  <CopyPath label="Windows" value={`\\\\${host}\\${s.name}`} />
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
