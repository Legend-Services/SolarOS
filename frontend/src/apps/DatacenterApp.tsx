import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { edition } from "@edition";
import { Boxes, FileText, Globe, KeyRound, Pencil, Plus, RefreshCw, Shield, ShieldCheck, Trash2, User, Users, UserCog, Flame } from "lucide-react";
import { api } from "../lib/api";
import { usePoll, useRunner } from "../lib/hooks";
import type { Guest } from "../lib/types";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";
import { useCapabilities } from "../store/capabilitiesStore";

/* ---------------- Types (local to this app) ---------------- */

interface AccessUser {
  userid: string;
  enable?: number;
  expire?: number;
  email?: string;
  firstname?: string;
  lastname?: string;
  comment?: string;
  groups?: string | string[];
  tokens?: { tokenid: string }[] | null;
  "realm-type"?: string;
}
interface Group { groupid: string; comment?: string; users?: string }
interface Role { roleid: string; privs?: string; special?: number }
interface Acl { path: string; type: "user" | "group" | "token"; ugid: string; roleid: string; propagate: number }
interface Pool { poolid: string; comment?: string; members?: { id: string; type: string; vmid?: number; storage?: string; name?: string }[] }
interface Token { userid: string; tokenid: string; comment?: string; expire?: number; privsep?: number; service?: boolean }
interface Realm { realm: string; type: string; comment?: string; default?: number; tfa?: string }
interface Rule {
  pos: number;
  type: "in" | "out" | "group";
  action: string;
  enable?: number;
  macro?: string;
  proto?: string;
  source?: string;
  dest?: string;
  sport?: string;
  dport?: string;
  iface?: string;
  log?: string;
  comment?: string;
}
interface FwOptions { enable?: number; policy_in?: string; policy_out?: string }
interface StorageCfg { storage: string }
interface ClusterLog { uid: string; time: number; user: string; tag: string; msg: string; pri: number }

export type DcTab = Tab;
type Tab = "users" | "groups" | "roles" | "acl" | "pools" | "tokens" | "realms" | "firewall" | "logs";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "users", label: "Users", icon: <User size={15} /> },
  { id: "groups", label: "Groups", icon: <Users size={15} /> },
  { id: "roles", label: "Roles", icon: <UserCog size={15} /> },
  { id: "acl", label: "Permissions", icon: <ShieldCheck size={15} /> },
  { id: "pools", label: "Pools", icon: <Boxes size={15} /> },
  { id: "tokens", label: "API Tokens", icon: <KeyRound size={15} /> },
  { id: "realms", label: "Realms", icon: <Globe size={15} /> },
  { id: "firewall", label: "Firewall", icon: <Flame size={15} /> },
  { id: "logs", label: "Logs", icon: <FileText size={15} /> },
];

const enc = encodeURIComponent;
const dateOf = (t?: number) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "");
const epochOf = (d: string) => (d ? Math.floor(new Date(`${d}T23:59:59`).getTime() / 1000) : 0);
const list = (v?: string | string[]) => (Array.isArray(v) ? v : (v ?? "").split(",").filter(Boolean));

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (path) api<T>(path).then((d) => (setData(d), setError("")), (e) => setError(e.message));
  }, [path]);
  useEffect(load, [load]);
  return { data, error, load };
}

/* ---------------- Shared bits ---------------- */

function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="glass-soft overflow-x-auto rounded-2xl">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children}
          {empty && (
            <tr>
              <td colSpan={head.length} className="px-3 py-6 text-center text-slate-500">
                Nothing here yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const Td = ({ children, mono, className = "" }: { children: ReactNode; mono?: boolean; className?: string }) => (
  <td className={`border-t border-white/5 px-3 py-2 text-slate-200 ${mono ? "font-mono" : ""} ${className}`}>{children}</td>
);

function Header({ title, children, onRefresh }: { title: string; children?: ReactNode; onRefresh?: () => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h3 className="flex-1 text-sm font-semibold text-slate-100">{title}</h3>
      {children}
      {onRefresh && (
        <GlassButton variant="ghost" size="xs" onClick={onRefresh} aria-label="Refresh">
          <RefreshCw size={13} />
        </GlassButton>
      )}
    </div>
  );
}

/** Delete-with-confirmation button. */
function DeleteButton({ what, onDelete, disabled }: { what: string; onDelete: () => Promise<unknown>; disabled?: boolean }) {
  const [ask, setAsk] = useState(false);
  const { busy, error, run } = useRunner();
  return (
    <>
      <GlassButton variant="ghost" size="xs" className="text-rose-300" disabled={disabled} onClick={() => setAsk(true)} aria-label={`Delete ${what}`}>
        <Trash2 size={12} />
      </GlassButton>
      <ConfirmModal
        open={ask}
        onClose={() => setAsk(false)}
        busy={busy}
        error={error}
        title={`Delete ${what}`}
        confirmLabel="Delete"
        message={`Delete ${what}? This cannot be undone.`}
        onConfirm={async () => (await run(onDelete)) && setAsk(false)}
      />
    </>
  );
}

/* ---------------- Users ---------------- */

const emptyUser = { userid: "", password: "", email: "", firstname: "", lastname: "", comment: "", expire: "", enable: true, groups: [] as string[] };

function UsersTab({ service }: { service: string }) {
  const users = useLoad<AccessUser[]>("/v1/access/users");
  const groups = useLoad<Group[]>("/v1/access/groups");
  const [edit, setEdit] = useState<AccessUser | "new" | null>(null);
  const [pw, setPw] = useState<string | null>(null);
  const [f, setF] = useState(emptyUser);
  const [newPw, setNewPw] = useState("");
  const { busy, error, run, setError } = useRunner(users.load);

  useEffect(() => {
    setError("");
    if (edit === "new") setF(emptyUser);
    else if (edit)
      setF({
        userid: edit.userid, password: "", email: edit.email ?? "", firstname: edit.firstname ?? "", lastname: edit.lastname ?? "",
        comment: edit.comment ?? "", expire: dateOf(edit.expire), enable: edit.enable !== 0, groups: list(edit.groups),
      });
  }, [edit, setError]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { email: f.email, firstname: f.firstname, lastname: f.lastname, comment: f.comment, expire: epochOf(f.expire), enable: f.enable, groups: f.groups };
    const ok = await run(() =>
      edit === "new"
        ? api("/v1/access/users", { method: "POST", json: { ...body, userid: f.userid, password: f.password || undefined } })
        : api(`/v1/access/users/${enc(f.userid)}`, { method: "PUT", json: body }),
    );
    if (ok) setEdit(null);
  };

  return (
    <div>
      <Header title="Users" onRefresh={users.load}>
        <GlassButton variant="primary" onClick={() => setEdit("new")}>
          <Plus size={13} /> Add user
        </GlassButton>
      </Header>
      <Notice error={users.error} />
      <Table head={["User", "Name", "Email", "Groups", "Status", "Expires", "Tokens", ""]} empty={users.data?.length === 0}>
        {users.data?.map((u) => {
          const locked = u.userid === service;
          return (
            <tr key={u.userid}>
              <Td mono>
                {u.userid} {locked && <GlassBadge tone="info">SOLARDECK</GlassBadge>}
              </Td>
              <Td>{[u.firstname, u.lastname].filter(Boolean).join(" ") || "—"}</Td>
              <Td>{u.email || "—"}</Td>
              <Td>{list(u.groups).join(", ") || "—"}</Td>
              <Td>
                <GlassBadge tone={u.enable === 0 ? "neutral" : "success"}>{u.enable === 0 ? "DISABLED" : "ENABLED"}</GlassBadge>
              </Td>
              <Td>{dateOf(u.expire) || "Never"}</Td>
              <Td>{u.tokens?.length ?? 0}</Td>
              <Td className="text-right whitespace-nowrap">
                <GlassButton variant="ghost" size="xs" disabled={locked} onClick={() => setEdit(u)} aria-label={`Edit ${u.userid}`}>
                  <Pencil size={12} />
                </GlassButton>
                <GlassButton variant="ghost" size="xs" disabled={locked} onClick={() => (setPw(u.userid), setNewPw(""), setError(""))} aria-label={`Set password for ${u.userid}`}>
                  <KeyRound size={12} />
                </GlassButton>
                <DeleteButton what={`user ${u.userid}`} disabled={locked || u.userid === "root@pam"} onDelete={() => api(`/v1/access/users/${enc(u.userid)}`, { method: "DELETE" }).then(users.load)} />
              </Td>
            </tr>
          );
        })}
      </Table>

      <GlassModal open={!!edit} onClose={() => setEdit(null)} title={edit === "new" ? "Add user" : `Edit ${f.userid}`}>
        <form onSubmit={submit} className="space-y-3">
          {edit === "new" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="User ID" hint={`name@realm, e.g. alice@${edition.localRealm}`}>
                <GlassInput className="w-full font-mono" value={f.userid} pattern="[A-Za-z0-9._\-]+@[A-Za-z0-9._\-]+" onChange={(e) => setF({ ...f, userid: e.target.value })} required />
              </Field>
              <Field label="Password" hint={`Only for the @${edition.localRealm} realm (min. 8)`}>
                <GlassInput type="password" className="w-full" minLength={8} value={f.password} disabled={!f.userid.endsWith(`@${edition.localRealm}`)} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
              </Field>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name">
              <GlassInput className="w-full" value={f.firstname} onChange={(e) => setF({ ...f, firstname: e.target.value })} />
            </Field>
            <Field label="Last name">
              <GlassInput className="w-full" value={f.lastname} onChange={(e) => setF({ ...f, lastname: e.target.value })} />
            </Field>
            <Field label="Email">
              <GlassInput type="email" className="w-full" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </Field>
            <Field label="Expires" hint="Empty = never">
              <GlassInput type="date" className="w-full" value={f.expire} onChange={(e) => setF({ ...f, expire: e.target.value })} />
            </Field>
          </div>
          <Field label="Comment">
            <GlassInput className="w-full" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
          </Field>
          <div>
            <p className="mb-1 text-[11px] text-slate-400">Groups</p>
            <div className="flex flex-wrap gap-3">
              {groups.data?.length ? (
                groups.data.map((g) => (
                  <label key={g.groupid} className="flex items-center gap-1.5 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={f.groups.includes(g.groupid)}
                      onChange={() => setF({ ...f, groups: f.groups.includes(g.groupid) ? f.groups.filter((x) => x !== g.groupid) : [...f.groups, g.groupid] })}
                    />
                    {g.groupid}
                  </label>
                ))
              ) : (
                <span className="text-[11px] text-slate-500">No groups defined.</span>
              )}
            </div>
          </div>
          <GlassSwitch checked={f.enable} onChange={(v) => setF({ ...f, enable: v })} label="Enabled" />
          <Notice error={error} />
          <div className="flex justify-end gap-2">
            <GlassButton onClick={() => setEdit(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="primary" disabled={busy}>
              Save
            </GlassButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal open={!!pw} onClose={() => setPw(null)} title={`Set password — ${pw}`}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api(`/v1/access/users/${enc(pw!)}/password`, { method: "PUT", json: { password: newPw } }))) setPw(null);
          }}
          className="space-y-3"
        >
          <Field label="New password" hint="At least 8 characters. Applies to the user's realm (PAM changes the Linux password).">
            <GlassInput type="password" className="w-full" minLength={8} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" required autoFocus />
          </Field>
          <Notice error={error} />
          <div className="flex justify-end gap-2">
            <GlassButton onClick={() => setPw(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="primary" disabled={busy}>
              Set password
            </GlassButton>
          </div>
        </form>
      </GlassModal>
    </div>
  );
}

/* ---------------- Groups ---------------- */

function GroupsTab() {
  const groups = useLoad<Group[]>("/v1/access/groups");
  const [f, setF] = useState({ groupid: "", comment: "" });
  const { busy, error, run } = useRunner(groups.load);
  return (
    <div>
      <Header title="Groups" onRefresh={groups.load} />
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api("/v1/access/groups", { method: "POST", json: f }))) setF({ groupid: "", comment: "" });
        }}
      >
        <Field label="Group ID">
          <GlassInput value={f.groupid} pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" onChange={(e) => setF({ ...f, groupid: e.target.value })} required />
        </Field>
        <Field label="Comment">
          <GlassInput className="w-64" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </Field>
        <GlassButton type="submit" variant="primary" disabled={busy}>
          <Plus size={13} /> Create group
        </GlassButton>
      </form>
      <Notice error={error || groups.error} />
      <Table head={["Group", "Members", "Comment", ""]} empty={groups.data?.length === 0}>
        {groups.data?.map((g) => (
          <tr key={g.groupid}>
            <Td mono>{g.groupid}</Td>
            <Td>{g.users || "—"}</Td>
            <Td>{g.comment || "—"}</Td>
            <Td className="text-right">
              <DeleteButton what={`group ${g.groupid}`} onDelete={() => api(`/v1/access/groups/${enc(g.groupid)}`, { method: "DELETE" }).then(groups.load)} />
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

/* ---------------- Roles ---------------- */

function RolesTab() {
  const roles = useLoad<Role[]>("/v1/access/roles");
  const privs = useLoad<string[]>("/v1/access/privileges");
  const [edit, setEdit] = useState<Role | "new" | null>(null);
  const [id, setId] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const { busy, error, run, setError } = useRunner(roles.load);
  useEffect(() => {
    setError("");
    setId(edit && edit !== "new" ? edit.roleid : "");
    setSel(edit && edit !== "new" ? list(edit.privs) : []);
  }, [edit, setError]);
  const byGroup = useMemo(() => {
    const m: Record<string, string[]> = {};
    privs.data?.forEach((p) => (m[p.split(".")[0]] ??= []).push(p));
    return m;
  }, [privs.data]);
  const save = async () => {
    const ok = await run(() =>
      edit === "new" ? api("/v1/access/roles", { method: "POST", json: { roleid: id, privs: sel } }) : api(`/v1/access/roles/${enc(id)}`, { method: "PUT", json: { privs: sel } }),
    );
    if (ok) setEdit(null);
  };
  return (
    <div>
      <Header title="Roles" onRefresh={roles.load}>
        <GlassButton variant="primary" onClick={() => setEdit("new")}>
          <Plus size={13} /> Create role
        </GlassButton>
      </Header>
      <Notice error={roles.error} />
      <Table head={["Role", "Type", "Privileges", ""]} empty={roles.data?.length === 0}>
        {roles.data
          ?.slice()
          .sort((a, b) => (a.special ?? 0) - (b.special ?? 0) || a.roleid.localeCompare(b.roleid))
          .map((r) => (
            <tr key={r.roleid}>
              <Td mono>{r.roleid}</Td>
              <Td>
                <GlassBadge tone={r.special ? "neutral" : "info"}>{r.special ? "BUILT-IN" : "CUSTOM"}</GlassBadge>
              </Td>
              <Td className="max-w-md truncate text-slate-400" >
                <span title={r.privs}>{list(r.privs).length} · {r.privs}</span>
              </Td>
              <Td className="text-right whitespace-nowrap">
                <GlassButton variant="ghost" size="xs" disabled={!!r.special} onClick={() => setEdit(r)} aria-label={`Edit ${r.roleid}`}>
                  <Pencil size={12} />
                </GlassButton>
                <DeleteButton what={`role ${r.roleid}`} disabled={!!r.special} onDelete={() => api(`/v1/access/roles/${enc(r.roleid)}`, { method: "DELETE" }).then(roles.load)} />
              </Td>
            </tr>
          ))}
      </Table>
      <GlassModal
        open={!!edit}
        onClose={() => setEdit(null)}
        width="max-w-3xl"
        title={edit === "new" ? "Create role" : `Edit role ${id}`}
        footer={
          <>
            <GlassButton onClick={() => setEdit(null)}>Cancel</GlassButton>
            <GlassButton variant="primary" disabled={busy || !id || !sel.length} onClick={save}>
              Save ({sel.length} privileges)
            </GlassButton>
          </>
        }
      >
        <div className="space-y-3">
          {edit === "new" && (
            <Field label="Role ID">
              <GlassInput value={id} pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" onChange={(e) => setId(e.target.value)} autoFocus />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(byGroup).map(([g, ps]) => (
              <fieldset key={g} className="glass-soft rounded-xl p-2">
                <legend className="px-1 text-[11px] font-semibold text-slate-300">{g}</legend>
                {ps.map((p) => (
                  <label key={p} className="flex items-center gap-1.5 py-0.5 text-[11px] text-slate-200">
                    <input type="checkbox" checked={sel.includes(p)} onChange={() => setSel(sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p])} />
                    {p.slice(g.length + 1)}
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <Notice error={error || privs.error} />
        </div>
      </GlassModal>
    </div>
  );
}

/* ---------------- Permissions (ACL) ---------------- */

function AclTab({ service }: { service: string }) {
  const acl = useLoad<Acl[]>("/v1/access/acl");
  const users = useLoad<AccessUser[]>("/v1/access/users");
  const groups = useLoad<Group[]>("/v1/access/groups");
  const roles = useLoad<Role[]>("/v1/access/roles");
  const tokens = useLoad<Token[]>("/v1/access/tokens");
  const guests = useLoad<Guest[]>("/v1/guests");
  const storages = useLoad<StorageCfg[]>("/v1/storage-config");
  const pools = useLoad<Pool[]>("/v1/pools");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ path: "/", type: "user" as Acl["type"], ugid: "", roleid: edition.vmUserRole, propagate: true });
  const { busy, error, run } = useRunner(acl.load);
  const paths = ["/", "/vms", "/storage", "/pool", "/nodes", "/access", "/sdn"]
    .concat(guests.data?.map((g) => `/vms/${g.vmid}`) ?? [], storages.data?.map((s) => `/storage/${s.storage}`) ?? [], pools.data?.map((p) => `/pool/${p.poolid}`) ?? []);
  const subjects = f.type === "user" ? users.data?.map((u) => u.userid) : f.type === "group" ? groups.data?.map((g) => g.groupid) : tokens.data?.map((t) => `${t.userid}!${t.tokenid}`);
  return (
    <div>
      <Header title="Permissions" onRefresh={acl.load}>
        <GlassButton variant="primary" onClick={() => setOpen(true)}>
          <Plus size={13} /> Add permission
        </GlassButton>
      </Header>
      <Notice error={acl.error} />
      <Table head={["Path", "Type", "User / Group / Token", "Role", "Propagate", ""]} empty={acl.data?.length === 0}>
        {acl.data?.map((a, i) => {
          const locked = a.ugid === service || a.ugid.startsWith(`${service}!`);
          return (
            <tr key={i}>
              <Td mono>{a.path}</Td>
              <Td className="capitalize">{a.type}</Td>
              <Td mono>{a.ugid}</Td>
              <Td mono>{a.roleid}</Td>
              <Td>{a.propagate ? "Yes" : "No"}</Td>
              <Td className="text-right">
                <DeleteButton
                  what={`${a.roleid} on ${a.path} for ${a.ugid}`}
                  disabled={locked}
                  onDelete={() => api(`/v1/access/acl?${new URLSearchParams({ path: a.path, roleid: a.roleid, type: a.type, ugid: a.ugid })}`, { method: "DELETE" }).then(acl.load)}
                />
              </Td>
            </tr>
          );
        })}
      </Table>
      <GlassModal open={open} onClose={() => setOpen(false)} title="Add permission">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api("/v1/access/acl", { method: "POST", json: f }))) setOpen(false);
          }}
        >
          <Field label="Path" hint="/ (everything), /vms/<id>, /storage/<id>, /pool/<name>, …">
            <GlassInput className="w-full font-mono" list="dc-acl-paths" value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} required />
            <datalist id="dc-acl-paths">
              {paths.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <GlassSelect className="w-full" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Acl["type"], ugid: "" })}>
                <option value="user">User</option>
                <option value="group">Group</option>
                <option value="token">API token</option>
              </GlassSelect>
            </Field>
            <Field label={f.type === "user" ? "User" : f.type === "group" ? "Group" : "Token"}>
              <GlassSelect className="w-full" value={f.ugid} onChange={(e) => setF({ ...f, ugid: e.target.value })} required>
                <option value="">Select…</option>
                {subjects?.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            <Field label="Role">
              <GlassSelect className="w-full" value={f.roleid} onChange={(e) => setF({ ...f, roleid: e.target.value })}>
                {roles.data?.map((r) => (
                  <option key={r.roleid} value={r.roleid}>
                    {r.roleid}
                  </option>
                ))}
              </GlassSelect>
            </Field>
          </div>
          <GlassSwitch checked={f.propagate} onChange={(v) => setF({ ...f, propagate: v })} label="Propagate to child paths" />
          <Notice error={error} />
          <div className="flex justify-end gap-2">
            <GlassButton onClick={() => setOpen(false)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="primary" disabled={busy}>
              Add
            </GlassButton>
          </div>
        </form>
      </GlassModal>
    </div>
  );
}

/* ---------------- Pools ---------------- */

function PoolsTab() {
  const pools = useLoad<Pool[]>("/v1/pools");
  const guests = useLoad<Guest[]>("/v1/guests");
  const storages = useLoad<StorageCfg[]>("/v1/storage-config");
  const [sel, setSel] = useState<string | null>(null);
  const detail = useLoad<Pool>(sel ? `/v1/pools/${enc(sel)}` : null);
  const [f, setF] = useState({ poolid: "", comment: "" });
  const [addVm, setAddVm] = useState("");
  const [addSt, setAddSt] = useState("");
  const { busy, error, run } = useRunner();
  const members = (vms: number[], storage: string[], remove = false) =>
    run(() => api(`/v1/pools/${enc(sel!)}/members`, { method: "PUT", json: { vms, storage, remove } }).then(detail.load));
  return (
    <div>
      <Header title="Resource pools" onRefresh={pools.load} />
      <form
        className="mb-3 flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api("/v1/pools", { method: "POST", json: f }).then(pools.load))) setF({ poolid: "", comment: "" });
        }}
      >
        <Field label="Pool ID">
          <GlassInput value={f.poolid} pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" onChange={(e) => setF({ ...f, poolid: e.target.value })} required />
        </Field>
        <Field label="Comment">
          <GlassInput className="w-64" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </Field>
        <GlassButton type="submit" variant="primary" disabled={busy}>
          <Plus size={13} /> Create pool
        </GlassButton>
      </form>
      <Notice error={error || pools.error} />
      <Table head={["Pool", "Comment", ""]} empty={pools.data?.length === 0}>
        {pools.data?.map((p) => (
          <tr key={p.poolid} className={sel === p.poolid ? "bg-white/5" : ""}>
            <Td mono>{p.poolid}</Td>
            <Td>{p.comment || "—"}</Td>
            <Td className="text-right whitespace-nowrap">
              <GlassButton size="xs" onClick={() => setSel(p.poolid)}>
                Members
              </GlassButton>
              <DeleteButton what={`pool ${p.poolid}`} onDelete={() => api(`/v1/pools/${enc(p.poolid)}`, { method: "DELETE" }).then(() => (setSel(null), pools.load()))} />
            </Td>
          </tr>
        ))}
      </Table>
      {sel && (
        <section className="glass-soft mt-4 rounded-2xl p-4">
          <h4 className="mb-3 text-sm font-semibold text-slate-100">Members of {sel}</h4>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Field label="Add guest">
              <GlassSelect value={addVm} onChange={(e) => setAddVm(e.target.value)}>
                <option value="">Select…</option>
                {guests.data?.map((g) => (
                  <option key={g.vmid} value={g.vmid}>
                    {g.vmid} · {g.name}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            <GlassButton disabled={!addVm || busy} onClick={() => members([Number(addVm)], []).then(() => setAddVm(""))}>
              <Plus size={13} /> Add
            </GlassButton>
            <Field label="Add storage">
              <GlassSelect value={addSt} onChange={(e) => setAddSt(e.target.value)}>
                <option value="">Select…</option>
                {storages.data?.map((s) => (
                  <option key={s.storage} value={s.storage}>
                    {s.storage}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            <GlassButton disabled={!addSt || busy} onClick={() => members([], [addSt]).then(() => setAddSt(""))}>
              <Plus size={13} /> Add
            </GlassButton>
          </div>
          <Notice error={detail.error} />
          <ul className="space-y-1 text-xs">
            {detail.data?.members?.length ? (
              detail.data.members.map((m) => (
                <li key={m.id} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-1.5">
                  <GlassBadge>{m.type.toUpperCase()}</GlassBadge>
                  <span className="flex-1 font-mono text-slate-200">{m.vmid ? `${m.vmid} · ${m.name ?? ""}` : m.storage ?? m.id}</span>
                  <GlassButton
                    variant="ghost"
                    size="xs"
                    className="text-rose-300"
                    disabled={busy}
                    onClick={() => (m.vmid ? members([m.vmid], [], true) : members([], [m.storage ?? ""], true))}
                    aria-label={`Remove ${m.id}`}
                  >
                    <Trash2 size={12} />
                  </GlassButton>
                </li>
              ))
            ) : (
              <li className="text-slate-500">No members.</li>
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ---------------- API tokens ---------------- */

function TokensTab() {
  const tokens = useLoad<Token[]>("/v1/access/tokens");
  const users = useLoad<AccessUser[]>("/v1/access/users");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ userid: "", tokenid: "", comment: "", expire: "", privsep: true });
  const [secret, setSecret] = useState<{ full_tokenid: string; value: string } | null>(null);
  const { busy, error, run } = useRunner(tokens.load);
  return (
    <div>
      <Header title="API tokens" onRefresh={tokens.load}>
        <GlassButton variant="primary" onClick={() => (setOpen(true), setSecret(null))}>
          <Plus size={13} /> Add token
        </GlassButton>
      </Header>
      <Notice error={tokens.error} />
      <Table head={["Token", "Comment", "Privilege separation", "Expires", ""]} empty={tokens.data?.length === 0}>
        {tokens.data?.map((t) => (
          <tr key={`${t.userid}!${t.tokenid}`}>
            <Td mono>
              {t.userid}!{t.tokenid} {t.service && <GlassBadge tone="info">SOLARDECK</GlassBadge>}
            </Td>
            <Td>{t.comment || "—"}</Td>
            <Td>{t.privsep ? "Yes" : "No (full user rights)"}</Td>
            <Td>{dateOf(t.expire) || "Never"}</Td>
            <Td className="text-right">
              <DeleteButton what={`token ${t.userid}!${t.tokenid}`} disabled={t.service} onDelete={() => api(`/v1/access/tokens/${enc(t.userid)}/${enc(t.tokenid)}`, { method: "DELETE" }).then(tokens.load)} />
            </Td>
          </tr>
        ))}
      </Table>
      <GlassModal open={open} onClose={() => setOpen(false)} title="Add API token">
        {secret ? (
          <div className="space-y-3 text-xs text-slate-300">
            <p>Copy the secret now; {edition.platform} will not show it again.</p>
            <Field label="Token ID">
              <code className="block rounded-lg bg-black/30 px-3 py-2 font-mono text-sky-200 select-all">{secret.full_tokenid}</code>
            </Field>
            <Field label="Secret">
              <code className="block rounded-lg bg-black/30 px-3 py-2 font-mono break-all text-emerald-200 select-all">{secret.value}</code>
            </Field>
            <div className="flex justify-end">
              <GlassButton variant="primary" onClick={() => setOpen(false)}>
                Done
              </GlassButton>
            </div>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() =>
                api<{ full_tokenid: string; value: string }>("/v1/access/tokens", { method: "POST", json: { ...f, expire: epochOf(f.expire) } }).then(setSecret),
              );
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="User">
                <GlassSelect className="w-full" value={f.userid} onChange={(e) => setF({ ...f, userid: e.target.value })} required>
                  <option value="">Select…</option>
                  {users.data?.map((u) => (
                    <option key={u.userid} value={u.userid}>
                      {u.userid}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label="Token ID">
                <GlassInput className="w-full font-mono" value={f.tokenid} pattern="[A-Za-z][A-Za-z0-9._\-]*" onChange={(e) => setF({ ...f, tokenid: e.target.value })} required />
              </Field>
              <Field label="Expires" hint="Empty = never">
                <GlassInput type="date" className="w-full" value={f.expire} onChange={(e) => setF({ ...f, expire: e.target.value })} />
              </Field>
              <Field label="Comment">
                <GlassInput className="w-full" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
              </Field>
            </div>
            <GlassSwitch checked={f.privsep} onChange={(v) => setF({ ...f, privsep: v })} label="Privilege separation (token needs its own permissions)" />
            <Notice error={error} />
            <div className="flex justify-end gap-2">
              <GlassButton onClick={() => setOpen(false)}>Cancel</GlassButton>
              <GlassButton type="submit" variant="primary" disabled={busy}>
                Create
              </GlassButton>
            </div>
          </form>
        )}
      </GlassModal>
    </div>
  );
}

/* ---------------- Realms ---------------- */

function RealmsTab() {
  const realms = useLoad<Realm[]>("/v1/access/domains");
  return (
    <div>
      <Header title="Authentication realms" onRefresh={realms.load} />
      <Notice error={realms.error} />
      <Table head={["Realm", "Type", "Default", "2FA", "Comment"]} empty={realms.data?.length === 0}>
        {realms.data?.map((r) => (
          <tr key={r.realm}>
            <Td mono>{r.realm}</Td>
            <Td className="uppercase">{r.type}</Td>
            <Td>{r.default ? "Yes" : "—"}</Td>
            <Td>{r.tfa || "—"}</Td>
            <Td>{r.comment || "—"}</Td>
          </tr>
        ))}
      </Table>
      {edition.realmsNote && <p className="mt-3 text-[11px] text-slate-500">{edition.realmsNote}</p>}
    </div>
  );
}

/* ---------------- Firewall ---------------- */

type FwScope = "cluster" | "node" | "guest";
const emptyRule = { type: "in" as Rule["type"], action: "ACCEPT", enable: true, macro: "", proto: "", source: "", dest: "", sport: "", dport: "", iface: "", log: "", comment: "" };
const mgmtPort = new RegExp(`(^|,)(22|${edition.webUiPort})(,|$|:)`);
const allowsMgmt = (rules: Rule[]) => rules.some((r) => r.enable && r.type === "in" && r.action === "ACCEPT" && (mgmtPort.test(r.dport ?? "") || /SSH/i.test(r.macro ?? "")));

function FirewallTab() {
  const [scope, setScope] = useState<FwScope>("cluster");
  const guests = useLoad<Guest[]>("/v1/guests");
  const [guest, setGuest] = useState<Guest | null>(null);
  const base = scope === "guest" ? (guest ? `/v1/firewall/${guest.type}` : null) : `/v1/firewall/${scope}`;
  const q = scope === "guest" && guest ? `?vmid=${guest.vmid}` : "";
  const rules = useLoad<Rule[]>(base && `${base}/rules${q}`);
  const opts = useLoad<FwOptions>(base && `${base}/options${q}`);
  const [edit, setEdit] = useState<Rule | "new" | null>(null);
  const [f, setF] = useState(emptyRule);
  const [warn, setWarn] = useState<FwOptions | null>(null);
  const { busy, error, run, setError } = useRunner();
  useEffect(() => {
    setError("");
    if (edit === "new") setF(emptyRule);
    else if (edit) setF({ ...emptyRule, ...Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)), enable: !!edit.enable } as typeof emptyRule);
  }, [edit, setError]);

  const saveRule = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() =>
      edit === "new" ? api(`${base}/rules${q}`, { method: "POST", json: f }) : api(`${base}/rules/${(edit as Rule).pos}${q}`, { method: "PUT", json: f }),
    );
    if (ok) (setEdit(null), rules.load());
  };
  const toggleRule = (r: Rule) =>
    run(() => api(`${base}/rules/${r.pos}${q}`, { method: "PUT", json: { ...emptyRule, ...Object.fromEntries(Object.entries(r).filter(([k]) => k in emptyRule)), enable: !r.enable } }).then(rules.load));
  const setOpts = (patch: FwOptions) => run(() => api(`${base}/options${q}`, { method: "PUT", json: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, k === "enable" ? !!v : v])) }).then(opts.load));
  const requestOpts = (patch: FwOptions) => {
    const next = { ...opts.data, ...patch };
    // Cluster default inbound policy is DROP; enabling without an SSH or web UI allow rule risks locking the host out.
    const dropping = (next.policy_in ?? (scope === "cluster" ? "DROP" : "ACCEPT")) !== "ACCEPT";
    if (scope !== "guest" && next.enable && dropping && !allowsMgmt(rules.data ?? [])) setWarn(patch);
    else setOpts(patch);
  };

  return (
    <div className="space-y-4">
      <Header title="Firewall" onRefresh={() => (rules.load(), opts.load())}>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { id: "cluster", label: "Datacenter" },
            { id: "node", label: "Host" },
            { id: "guest", label: "Guest" },
          ]}
        />
        {scope === "guest" && (
          <GlassSelect value={guest ? `${guest.type}/${guest.vmid}` : ""} onChange={(e) => setGuest(guests.data?.find((g) => `${g.type}/${g.vmid}` === e.target.value) ?? null)}>
            <option value="">Select guest…</option>
            {guests.data?.map((g) => (
              <option key={`${g.type}/${g.vmid}`} value={`${g.type}/${g.vmid}`}>
                {g.vmid} · {g.name}
              </option>
            ))}
          </GlassSelect>
        )}
      </Header>
      <Notice error={error || rules.error || opts.error} />
      {base && opts.data && (
        <section className="glass-soft flex flex-wrap items-center gap-4 rounded-2xl p-4">
          <GlassSwitch checked={!!opts.data.enable} onChange={(v) => requestOpts({ enable: v ? 1 : 0 })} label="Firewall enabled" disabled={busy} />
          {scope !== "node" &&
            (["policy_in", "policy_out"] as const).map((k) => (
              <Field key={k} label={k === "policy_in" ? "Input policy" : "Output policy"}>
                <GlassSelect value={opts.data?.[k] ?? (k === "policy_in" && scope === "cluster" ? "DROP" : "ACCEPT")} onChange={(e) => requestOpts({ [k]: e.target.value })}>
                  {["ACCEPT", "DROP", "REJECT"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </GlassSelect>
              </Field>
            ))}
          {scope === "guest" && <p className="text-[11px] text-slate-500">Guest rules only apply to NICs with firewall=1 and while the Datacenter firewall is enabled.</p>}
        </section>
      )}
      {base && (
        <div>
          <Header title="Rules">
            <GlassButton variant="primary" onClick={() => setEdit("new")}>
              <Plus size={13} /> Add rule
            </GlassButton>
          </Header>
          <Table head={["#", "On", "Direction", "Action", "Macro", "Proto", "Source", "Dest", "D-Port", "Comment", ""]} empty={rules.data?.length === 0}>
            {rules.data?.map((r) => (
              <tr key={r.pos}>
                <Td>{r.pos}</Td>
                <Td>
                  <GlassSwitch checked={!!r.enable} onChange={() => toggleRule(r)} label="" disabled={busy} />
                </Td>
                <Td className="uppercase">{r.type}</Td>
                <Td>
                  <GlassBadge tone={r.action === "ACCEPT" ? "success" : r.action === "DROP" || r.action === "REJECT" ? "danger" : "info"}>{r.action}</GlassBadge>
                </Td>
                <Td>{r.macro || "—"}</Td>
                <Td>{r.proto || "—"}</Td>
                <Td mono>{r.source || "any"}</Td>
                <Td mono>{r.dest || "any"}</Td>
                <Td mono>{r.dport || "—"}</Td>
                <Td className="max-w-40 truncate">{r.comment || "—"}</Td>
                <Td className="text-right whitespace-nowrap">
                  <GlassButton variant="ghost" size="xs" onClick={() => setEdit(r)} aria-label={`Edit rule ${r.pos}`}>
                    <Pencil size={12} />
                  </GlassButton>
                  <DeleteButton what={`rule #${r.pos}`} onDelete={() => api(`${base}/rules/${r.pos}${q}`, { method: "DELETE" }).then(rules.load)} />
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {scope === "cluster" && <AliasesAndIpsets />}

      <GlassModal open={!!edit} onClose={() => setEdit(null)} title={edit === "new" ? "Add firewall rule" : `Edit rule #${(edit as Rule | null)?.pos}`} width="max-w-2xl">
        <form onSubmit={saveRule} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Direction">
              <GlassSelect className="w-full" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Rule["type"] })}>
                <option value="in">In</option>
                <option value="out">Out</option>
                <option value="group">Security group</option>
              </GlassSelect>
            </Field>
            <Field label="Action" hint={f.type === "group" ? "Security group name" : undefined}>
              {f.type === "group" ? (
                <GlassInput className="w-full" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} required />
              ) : (
                <GlassSelect className="w-full" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
                  {["ACCEPT", "DROP", "REJECT"].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </GlassSelect>
              )}
            </Field>
            <Field label="Macro" hint="e.g. SSH, HTTPS, DNS">
              <GlassInput className="w-full" value={f.macro} onChange={(e) => setF({ ...f, macro: e.target.value })} />
            </Field>
            <Field label="Protocol">
              <GlassSelect className="w-full" value={f.proto} onChange={(e) => setF({ ...f, proto: e.target.value })}>
                {["", "tcp", "udp", "icmp", "icmpv6"].map((p) => (
                  <option key={p} value={p}>
                    {p || "any"}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            <Field label="Source" hint="IP, CIDR, alias or +ipset">
              <GlassInput className="w-full font-mono" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
            </Field>
            <Field label="Destination">
              <GlassInput className="w-full font-mono" value={f.dest} onChange={(e) => setF({ ...f, dest: e.target.value })} />
            </Field>
            <Field label="Source port">
              <GlassInput className="w-full font-mono" value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value })} />
            </Field>
            <Field label="Destination port" hint={edition.destPortHint}>
              <GlassInput className="w-full font-mono" value={f.dport} onChange={(e) => setF({ ...f, dport: e.target.value })} />
            </Field>
            <Field label="Interface">
              <GlassInput className="w-full font-mono" value={f.iface} placeholder="net0" onChange={(e) => setF({ ...f, iface: e.target.value })} />
            </Field>
            <Field label="Log level">
              <GlassSelect className="w-full" value={f.log} onChange={(e) => setF({ ...f, log: e.target.value })}>
                {["", "nolog", "info", "notice", "warning", "err", "crit", "alert", "emerg", "debug"].map((l) => (
                  <option key={l} value={l}>
                    {l || "default"}
                  </option>
                ))}
              </GlassSelect>
            </Field>
          </div>
          <Field label="Comment">
            <GlassInput className="w-full" value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
          </Field>
          <GlassSwitch checked={f.enable} onChange={(v) => setF({ ...f, enable: v })} label="Enabled" />
          <Notice error={error} />
          <div className="flex justify-end gap-2">
            <GlassButton onClick={() => setEdit(null)}>Cancel</GlassButton>
            <GlassButton type="submit" variant="primary" disabled={busy}>
              Save rule
            </GlassButton>
          </div>
        </form>
      </GlassModal>
      <ConfirmModal
        open={!!warn}
        onClose={() => setWarn(null)}
        busy={busy}
        error={error}
        title="Risk of locking yourself out"
        confirmLabel="Enable anyway"
        message={edition.firewallLockout}
        onConfirm={async () => {
          await setOpts(warn!);
          setWarn(null);
        }}
      />
    </div>
  );
}

function AliasesAndIpsets() {
  const aliases = useLoad<{ name: string; cidr: string; comment?: string }[]>("/v1/firewall/cluster/aliases");
  const ipsets = useLoad<{ name: string; comment?: string }[]>("/v1/firewall/cluster/ipsets");
  const [set, setSet] = useState<string | null>(null);
  const entries = useLoad<{ cidr: string; comment?: string; nomatch?: number }[]>(set ? `/v1/firewall/cluster/ipsets/${enc(set)}` : null);
  const [a, setA] = useState({ name: "", cidr: "", comment: "" });
  const [s, setS] = useState("");
  const [cidr, setCidr] = useState("");
  const { busy, error, run } = useRunner();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="glass-soft rounded-2xl p-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-100">Aliases</h4>
        <form
          className="mb-2 flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api("/v1/firewall/cluster/aliases", { method: "POST", json: a }).then(aliases.load))) setA({ name: "", cidr: "", comment: "" });
          }}
        >
          <GlassInput className="w-28" placeholder="name" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} required aria-label="Alias name" />
          <GlassInput className="w-36 font-mono" placeholder="10.0.0.0/24" value={a.cidr} onChange={(e) => setA({ ...a, cidr: e.target.value })} required aria-label="Alias CIDR" />
          <GlassButton type="submit" disabled={busy}>
            <Plus size={13} /> Add
          </GlassButton>
        </form>
        <ul className="space-y-1 text-xs">
          {aliases.data?.map((x) => (
            <li key={x.name} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-1">
              <span className="w-28 font-mono text-slate-200">{x.name}</span>
              <span className="flex-1 font-mono text-slate-400">{x.cidr}</span>
              <DeleteButton what={`alias ${x.name}`} onDelete={() => api(`/v1/firewall/cluster/aliases/${enc(x.name)}`, { method: "DELETE" }).then(aliases.load)} />
            </li>
          ))}
        </ul>
      </section>
      <section className="glass-soft rounded-2xl p-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-100">IP sets</h4>
        <form
          className="mb-2 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api("/v1/firewall/cluster/ipsets", { method: "POST", json: { name: s } }).then(ipsets.load))) setS("");
          }}
        >
          <GlassInput className="w-36" placeholder="name" value={s} onChange={(e) => setS(e.target.value)} required aria-label="IP set name" />
          <GlassButton type="submit" disabled={busy}>
            <Plus size={13} /> Add
          </GlassButton>
        </form>
        <ul className="space-y-1 text-xs">
          {ipsets.data?.map((x) => (
            <li key={x.name} className={`flex items-center gap-2 rounded-lg px-3 py-1 ${set === x.name ? "bg-white/10" : "bg-black/20"}`}>
              <button className="flex-1 text-left font-mono text-slate-200" onClick={() => setSet(x.name)}>
                {x.name}
              </button>
              <DeleteButton what={`IP set ${x.name}`} onDelete={() => api(`/v1/firewall/cluster/ipsets/${enc(x.name)}`, { method: "DELETE" }).then(() => (setSet(null), ipsets.load()))} />
            </li>
          ))}
        </ul>
        {set && (
          <div className="mt-3 border-t border-white/10 pt-3">
            <form
              className="mb-2 flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run(() => api(`/v1/firewall/cluster/ipsets/${enc(set)}`, { method: "POST", json: { cidr } }).then(entries.load))) setCidr("");
              }}
            >
              <GlassInput className="w-40 font-mono" placeholder="192.168.1.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} required aria-label="IP set entry" />
              <GlassButton type="submit" disabled={busy}>
                <Plus size={13} /> Add to {set}
              </GlassButton>
            </form>
            <ul className="space-y-1 text-xs">
              {entries.data?.map((x) => (
                <li key={x.cidr} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-1">
                  <span className="flex-1 font-mono text-slate-300">{x.cidr}</span>
                  <DeleteButton what={x.cidr} onDelete={() => api(`/v1/firewall/cluster/ipsets/${enc(set)}/entry?cidr=${enc(x.cidr)}`, { method: "DELETE" }).then(entries.load)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <Notice error={error} />
      </section>
    </div>
  );
}

/* ---------------- Logs ---------------- */

function LogsTab() {
  const clustering = useCapabilities((s) => s.capabilities.supports_clustering);
  const [src, setSrc] = useState<"syslog" | "journal" | "cluster">("syslog");
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    // Syslog reads from the start of the window, so limit it to today.
    const today = new Date().toISOString().slice(0, 10);
    const p =
      src === "cluster"
        ? api<ClusterLog[]>("/v1/logs/cluster?max=500").then((r) => r.map((x) => `${new Date(x.time * 1000).toLocaleString()}  ${x.user}  [${x.tag}]  ${x.msg}`))
        : api<{ lines: string[] }>(src === "syslog" ? `/v1/logs/syslog?limit=5000&since=${today}` : "/v1/logs/journal?lastentries=2000").then((r) => r.lines);
    p.then((l) => (setLines(l), setError("")), (e) => setError(e.message));
  }, [src]);
  useEffect(load, [load]);
  const tick = useCallback(() => auto && load(), [auto, load]);
  usePoll(tick, 5000);
  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  }, [lines, filter]);
  return (
    <div className="flex h-full flex-col">
      <Header title="Logs" onRefresh={load}>
        <Segmented
          value={src}
          onChange={setSrc}
          options={[
            { id: "syslog", label: "Syslog" },
            { id: "journal", label: "Journal" },
            ...(clustering ? [{ id: "cluster" as const, label: "Tasks & access" }] : []),
          ]}
        />
        <GlassInput className="w-48" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter log lines" />
        <GlassSwitch checked={auto} onChange={setAuto} label="Auto-refresh" />
      </Header>
      <Notice error={error} />
      <pre className="min-h-64 flex-1 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-slate-300">
        {shown.join("\n") || "No entries."}
      </pre>
      <p className="mt-2 text-[11px] text-slate-500">APT repositories and package updates are managed in the System app.</p>
    </div>
  );
}

/* ---------------- App ---------------- */

/** `tabs`: the tabs this Settings module owns (users & roles, firewall or host logs). */
export default function DatacenterApp({ initialTab, tabs }: { initialTab?: Tab; tabs?: Tab[] }) {
  const caps = useCapabilities((s) => s.capabilities);
  const shown = TABS.filter((t) => (!tabs || tabs.includes(t.id)) && (t.id !== "realms" || caps.supports_rbac_realms));
  const [tab, setTab] = useState<Tab>(shown.find((x) => x.id === initialTab)?.id ?? shown[0]?.id ?? "users");
  const tokens = useLoad<Token[]>("/v1/access/tokens");
  const service = tokens.data?.find((t) => t.service)?.userid ?? edition.serviceUserFallback;
  return (
    <div className="flex h-full">
      {shown.length > 1 && (
      <nav className="w-44 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        <p className="flex items-center gap-1.5 px-3 pb-1 text-[10px] font-semibold tracking-wide text-slate-500 uppercase max-sm:hidden">
          <Shield size={11} /> Datacenter
        </p>
        {shown.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id}
            title={t.label}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${
              tab === t.id ? "bg-white/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            {t.icon}
            <span className="max-sm:hidden">{t.label}</span>
          </button>
        ))}
      </nav>
      )}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {tab === "users" ? (
          <UsersTab service={service} />
        ) : tab === "groups" ? (
          <GroupsTab />
        ) : tab === "roles" ? (
          <RolesTab />
        ) : tab === "acl" ? (
          <AclTab service={service} />
        ) : tab === "pools" ? (
          <PoolsTab />
        ) : tab === "tokens" ? (
          <TokensTab />
        ) : tab === "realms" ? (
          <RealmsTab />
        ) : tab === "firewall" ? (
          <FirewallTab />
        ) : (
          <LogsTab />
        )}
      </div>
    </div>
  );
}
