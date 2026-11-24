import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, FolderOpen, Plus, Share2, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../lib/api";
import type { Share } from "../lib/types";

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
  const [f, setF] = useState({ name: "", path: "", comment: "", read_only: false, guest_ok: false, users: [] as string[] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/shares", { method: "POST", json: { ...f, path: f.path || `/${f.name}` } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="glass-soft space-y-3 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-white">New shared folder</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-slate-400">
          Share name
          <input className="input mt-1 w-full py-1.5 text-xs" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" required />
        </label>
        <label className="text-[11px] text-slate-400">
          Folder in /mnt/storage
          <input className="input mt-1 w-full py-1.5 text-xs" value={f.path} placeholder={`/${f.name || "media"}`} onChange={(e) => setF({ ...f, path: e.target.value })} />
        </label>
      </div>
      <label className="block text-[11px] text-slate-400">
        Description
        <input className="input mt-1 w-full py-1.5 text-xs" value={f.comment} maxLength={100} onChange={(e) => setF({ ...f, comment: e.target.value })} />
      </label>
      <div className="flex flex-wrap gap-4 text-xs text-slate-200">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.read_only} onChange={(e) => setF({ ...f, read_only: e.target.checked })} /> Read-only
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.guest_ok} onChange={(e) => setF({ ...f, guest_ok: e.target.checked })} /> Allow guest access
        </label>
      </div>
      <fieldset>
        <legend className="mb-1 text-[11px] text-slate-400">Allowed users {f.users.length === 0 && "(none selected: any Samba user)"}</legend>
        <div className="flex flex-wrap gap-2">
          {users.length === 0 && <span className="text-[11px] text-slate-500">No Samba users yet — add them in the Users tab.</span>}
          {users.map((u) => (
            <label key={u} className="flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs text-slate-200">
              <input
                type="checkbox"
                checked={f.users.includes(u)}
                onChange={(e) => setF({ ...f, users: e.target.checked ? [...f.users, u] : f.users.filter((x) => x !== u) })}
              />
              {u}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn border-sky-400/40 bg-sky-500/25 text-white" disabled={busy}>
          Create share
        </button>
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
      <form onSubmit={submit} className="glass-soft flex flex-wrap items-end gap-2 rounded-xl p-4">
        <label className="text-[11px] text-slate-400">
          Username
          <input className="input mt-1 block w-40 py-1.5 text-xs" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} pattern="[a-z_][a-z0-9_\-]{0,31}" required />
        </label>
        <label className="text-[11px] text-slate-400">
          Password
          <input type="password" className="input mt-1 block w-40 py-1.5 text-xs" value={f.password} minLength={4} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required />
        </label>
        <button className="btn border-sky-400/40 bg-sky-500/25 text-white">
          <UserPlus size={12} /> Add / set password
        </button>
      </form>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      {msg && !error && <p className="text-xs text-emerald-300">{msg}</p>}
      <ul className="space-y-1">
        {users.length === 0 && <li className="text-sm text-slate-400">No Samba users.</li>}
        {users.map((u) => (
          <li key={u} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-200">
            <Users size={13} className="text-slate-400" />
            <span className="flex-1">{u}</span>
            <button className="btn text-rose-300" onClick={() => remove(u)} aria-label={`Remove ${u}`}>
              <Trash2 size={12} />
            </button>
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
                <button className="btn ml-auto" onClick={() => setCreating(true)}>
                  <Plus size={12} /> Create
                </button>
              )}
            </div>
            {creating && <ShareForm users={users} onDone={() => (setCreating(false), load())} />}
            {shares === null && !error && <p className="text-sm text-slate-400">Loading…</p>}
            {shares?.length === 0 && !creating && <p className="text-sm text-slate-400">No shares yet. Create one to access /mnt/storage folders from your computers.</p>}
            {shares?.map((s) => (
              <section key={s.name} className="glass-soft space-y-2 rounded-xl p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <FolderOpen size={16} className="text-cyan-300" />
                  <h4 className="text-sm font-semibold text-white">{s.name}</h4>
                  <span className="font-mono text-[11px] text-slate-400">{s.path}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${s.read_only ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"}`}>
                    {s.read_only ? "Read-only" : "Read/write"}
                  </span>
                  {s.guest_ok && <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] text-sky-300">Guest</span>}
                  <button className="btn ml-auto text-rose-300" onClick={() => remove(s)} aria-label={`Delete share ${s.name}`}>
                    <Trash2 size={12} /> Remove
                  </button>
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
