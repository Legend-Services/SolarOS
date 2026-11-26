import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation } from "../../i18n";
import { Card } from "../ControlPanelApp";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassCheckbox, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice } from "../../components/ui/GlassKit";

type Role = "admin" | "operator" | "seat_user" | "viewer";
interface Account {
  username: string;
  display_name: string;
  role: Role;
  enabled: boolean;
  allowed_vm_ids: number[];
  allowed_seat_ids: string[];
  allowed_shares: string[];
}
interface Seat {
  seat_id: string;
  name?: string;
}

const ROLES: Role[] = ["admin", "operator", "seat_user", "viewer"];
const TONE = { admin: "danger", operator: "info", seat_user: "warning", viewer: "neutral" } as const;
const BLANK: Account = { username: "", display_name: "", role: "viewer", enabled: true, allowed_vm_ids: [], allowed_seat_ids: [], allowed_shares: [] };
// Mirrors accounts.check_new_credentials; the server has the final word.
const weak = (p: string) => p.length < 10 || p.length > 128 || !/[A-Za-z]/.test(p) || !/[^A-Za-z]/.test(p);
const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

/** Settings > Privilege & Security > Users & Roles > SolarDeck Accounts: extra sign-ins with a role and resource scopes. */
export default function UsersRolesPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ administrator: string; users: Account[] } | null>(null);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [edit, setEdit] = useState<{ isNew: boolean; a: Account; password: string; shares: string } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const { error, run } = useRunner();
  const modal = useRunner();

  const load = useCallback(() => api<{ administrator: string; users: Account[] }>("/rbac/users").then(setData), []);
  useEffect(() => {
    void run(load);
    api<Guest[]>("/v1/guests").then(setGuests, () => {});
    api<{ seats: Seat[] }>("/multiseat/seats").then((r) => setSeats(r.seats), () => {});
  }, [run, load]);

  const open = (a: Account | null) => {
    modal.setError("");
    setEdit({ isNew: !a, a: a ?? BLANK, password: "", shares: (a?.allowed_shares ?? []).join(", ") });
  };
  const setA = (p: Partial<Account>) => setEdit((e) => e && { ...e, a: { ...e.a, ...p } });
  const save = async () => {
    if (!edit) return;
    const { isNew, a, password, shares } = edit;
    if ((isNew || password) && weak(password)) return modal.setError(t("users.pwRules"));
    const json = { ...a, password: password || null, allowed_shares: shares.split(/[\s,]+/).filter(Boolean) };
    const ok = await modal.run(() => api(isNew ? "/rbac/users" : `/rbac/users/${a.username}`, { method: isNew ? "POST" : "PUT", json }).then(load));
    if (ok) setEdit(null);
  };
  const remove = async () => {
    if (del && (await modal.run(() => api(`/rbac/users/${del}`, { method: "DELETE" }).then(load)))) setDel(null);
  };
  const scopes = (a: Account) =>
    [
      a.allowed_vm_ids.length && t("users.nVms", { n: a.allowed_vm_ids.length }),
      a.allowed_seat_ids.length && t("users.nSeats", { n: a.allowed_seat_ids.length }),
      a.allowed_shares.length && t("users.nShares", { n: a.allowed_shares.length }),
    ]
      .filter(Boolean)
      .join(" · ") || "—";
  const a = edit?.a;

  return (
    <div className="space-y-4">
      <div data-anchor="users-accounts">
        <Card
          title={t("users.accounts")}
          action={
            <GlassButton size="xs" onClick={() => open(null)}>
              <Plus size={12} /> {t("users.add")}
            </GlassButton>
          }
        >
          <Notice error={error} />
          {data && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1.5">{t("users.username")}</th>
                    <th className="px-2 max-md:hidden">{t("users.displayName")}</th>
                    <th className="px-2">{t("users.role")}</th>
                    <th className="px-2 max-md:hidden">{t("users.scopes")}</th>
                    <th className="px-2">{t("common.enabled")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-white/5">
                    <td className="py-1.5 font-mono text-slate-100">{data.administrator}</td>
                    <td className="px-2 text-slate-400 max-md:hidden">{t("users.administrator")}</td>
                    <td className="px-2">
                      <GlassBadge tone="danger">{t("users.r.admin")}</GlassBadge>
                    </td>
                    <td className="px-2 text-slate-400 max-md:hidden">{t("users.everything")}</td>
                    <td className="px-2 text-slate-300">✓</td>
                    <td />
                  </tr>
                  {data.users.map((u) => (
                    <tr key={u.username} className="border-t border-white/5">
                      <td className="py-1.5 font-mono text-slate-100">{u.username}</td>
                      <td className="px-2 text-slate-300 max-md:hidden">{u.display_name || "—"}</td>
                      <td className="px-2">
                        <GlassBadge tone={TONE[u.role]}>{t(`users.r.${u.role}`)}</GlassBadge>
                      </td>
                      <td className="px-2 text-slate-400 max-md:hidden">{u.role === "admin" ? t("users.everything") : scopes(u)}</td>
                      <td className="px-2">{u.enabled ? <span className="text-slate-300">✓</span> : <GlassBadge>{t("users.disabled")}</GlassBadge>}</td>
                      <td className="whitespace-nowrap text-right">
                        <GlassButton size="xs" variant="ghost" title={t("common.edit")} aria-label={`${t("common.edit")}: ${u.username}`} onClick={() => open(u)}>
                          <Pencil size={12} />
                        </GlassButton>
                        <GlassButton
                          size="xs"
                          variant="ghost"
                          title={t("common.delete")}
                          aria-label={`${t("common.delete")}: ${u.username}`}
                          onClick={() => (modal.setError(""), setDel(u.username))}
                        >
                          <Trash2 size={12} />
                        </GlassButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div data-anchor="users-roles-help">
        <Card title={t("users.rolesTitle")}>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            {ROLES.map((r) => (
              <div key={r} className="rounded-lg bg-white/[0.04] p-2.5">
                <dt>
                  <GlassBadge tone={TONE[r]}>{t(`users.r.${r}`)}</GlassBadge>
                </dt>
                <dd className="mt-1.5 text-slate-300">{t(`users.rd.${r}`)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <GlassModal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.isNew ? t("users.add") : t("users.edit", { name: a?.username ?? "" })}
        footer={
          <>
            <GlassButton onClick={() => setEdit(null)}>{t("common.cancel")}</GlassButton>
            <GlassButton variant="primary" disabled={modal.busy || !a?.username} onClick={save}>
              {t("common.save")}
            </GlassButton>
          </>
        }
      >
        {edit && a && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("users.username")} hint={edit.isNew ? t("users.usernameHint") : undefined}>
                <GlassInput
                  className="w-full font-mono"
                  value={a.username}
                  disabled={!edit.isNew}
                  onChange={(e) => setA({ username: e.target.value.toLowerCase() })}
                  autoComplete="off"
                  autoFocus
                />
              </Field>
              <Field label={t("users.displayName")}>
                <GlassInput className="w-full" value={a.display_name} maxLength={60} onChange={(e) => setA({ display_name: e.target.value })} />
              </Field>
              <Field label={t("users.role")} hint={t(`users.rd.${a.role}`)}>
                <GlassSelect className="w-full" value={a.role} onChange={(e) => setA({ role: e.target.value as Role })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`users.r.${r}`)}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label={t("users.password")} hint={edit.isNew ? t("users.pwRules") : t("users.pwKeep")}>
                <GlassInput
                  type="password"
                  className="w-full"
                  value={edit.password}
                  onChange={(e) => setEdit({ ...edit, password: e.target.value })}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <GlassSwitch checked={a.enabled} onChange={(enabled) => setA({ enabled })} label={t("users.canSignIn")} />
            {a.role !== "admin" && (
              <>
                <div>
                  <p className="mb-1 text-[11px] text-slate-400">{t("users.vms")}</p>
                  <div className="flex max-h-28 flex-wrap gap-x-4 gap-y-1.5 overflow-auto">
                    {guests.map((g) => (
                      <GlassCheckbox
                        key={g.vmid}
                        label={`${g.vmid} · ${g.name}`}
                        checked={a.allowed_vm_ids.includes(g.vmid)}
                        onChange={(on) => setA({ allowed_vm_ids: toggle(a.allowed_vm_ids, g.vmid, on) })}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-[11px] text-slate-400">{t("users.seats")}</p>
                  {seats.length ? (
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {seats.map((s) => (
                        <GlassCheckbox
                          key={s.seat_id}
                          label={s.name || s.seat_id}
                          checked={a.allowed_seat_ids.includes(s.seat_id)}
                          onChange={(on) => setA({ allowed_seat_ids: toggle(a.allowed_seat_ids, s.seat_id, on) })}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500">{t("users.noSeats")}</p>
                  )}
                </div>
                <Field label={t("users.shares")} hint={t("users.sharesHint")}>
                  <GlassInput className="w-full" value={edit.shares} onChange={(e) => setEdit({ ...edit, shares: e.target.value })} />
                </Field>
              </>
            )}
            <Notice error={modal.error} />
          </div>
        )}
      </GlassModal>

      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={remove}
        busy={modal.busy}
        error={modal.error}
        title={t("users.deleteTitle")}
        message={t("users.deleteMsg", { name: del ?? "" })}
        confirmLabel={t("common.delete")}
      />
    </div>
  );
}
