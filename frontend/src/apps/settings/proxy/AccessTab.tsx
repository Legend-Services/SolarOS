import { useState } from "react";
import { Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useRunner } from "../../../lib/hooks";
import { useTranslation } from "../../../i18n";
import { Card } from "../../ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassInput, GlassModal, Notice, Segmented } from "../../../components/ui/GlassKit";
import { area, list, type Acl, type Ctx } from "./shared";

export default function AccessTab(ctx: Ctx) {
  const { d, call, run, busy, ask } = ctx;
  const { t } = useTranslation();
  const [edit, setEdit] = useState<Acl | "new" | null>(null);
  const [s, setS] = useState(d.ov.settings);
  return (
    <div className="space-y-3">
      <div data-anchor="rp-access">
        <Card
          title={t("rp.acl.title")}
          action={
            <GlassButton size="xs" variant="primary" onClick={() => setEdit("new")}>
              <Plus size={12} />
              {t("rp.acl.add")}
            </GlassButton>
          }
        >
          {d.acls.length === 0 ? (
            <p className="text-xs text-slate-500">{t("rp.acl.empty")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1.5">{t("rp.name")}</th>
                  <th className="px-2">{t("rp.acl.rules")}</th>
                  <th className="px-2">{t("rp.acl.users")}</th>
                  <th className="px-2">{t("rp.acl.satisfy")}</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {d.acls.map((a) => (
                  <tr key={a.id} className="border-t border-white/5">
                    <td className="py-1.5 text-slate-100">{a.name}</td>
                    <td className="px-2 text-slate-300">{t("rp.acl.counts", { allow: a.allow.length, deny: a.deny.length })}</td>
                    <td className="px-2 text-slate-300">{a.basic_auth_users.join(", ") || "-"}</td>
                    <td className="px-2">
                      <GlassBadge>{a.satisfy === "any" ? t("rp.acl.any") : t("rp.acl.all")}</GlassBadge>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <GlassButton size="xs" variant="ghost" onClick={() => setEdit(a)} aria-label={t("rp.edit")} title={t("rp.edit")}>
                        <Pencil size={12} />
                      </GlassButton>
                      <GlassButton
                        size="xs"
                        variant="ghost"
                        aria-label={t("rp.delete")}
                        title={t("rp.delete")}
                        onClick={() => ask(t("rp.acl.deleteTitle"), t("rp.acl.deleteMsg", { name: a.name }), () => call(`/proxy/access-lists/${a.id}`, "DELETE"))}
                      >
                        <Trash2 size={12} />
                      </GlassButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <div data-anchor="rp-gate">
        <Card title={t("rp.gate.title")}>
          <div className="flex gap-3">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-sky-300" />
            <div className="space-y-1 text-[11px] text-slate-300">
              <p>{t("rp.gate.intro")}</p>
              <p className="text-slate-400">{t("rp.gate.revoke")}</p>
              <p>
                {t("rp.gate.url")} <span className="font-mono text-slate-100">{d.ov.gate_url}</span>
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label={t("rp.gate.solardeckUrl")} hint={t("rp.gate.solardeckUrlHint")} className="min-w-56 flex-1">
              <GlassInput className="w-full font-mono" value={s.solardeck_url} onChange={(e) => setS({ ...s, solardeck_url: e.target.value.trim() })} placeholder="https://192.168.1.10" />
            </Field>
            <Field label={t("rp.gate.acmeEmail")} hint={t("rp.gate.acmeEmailHint")} className="min-w-56 flex-1">
              <GlassInput className="w-full" type="email" value={s.acme_email} onChange={(e) => setS({ ...s, acme_email: e.target.value.trim() })} />
            </Field>
            <GlassButton variant="primary" disabled={busy} onClick={() => run(() => call("/proxy/settings", "PUT", s))}>
              {t("rp.save")}
            </GlassButton>
          </div>
        </Card>
      </div>
      {edit && <AclModal call={call} acl={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function AclModal({ call, acl, onClose }: { call: Ctx["call"]; acl: Acl | "new"; onClose: () => void }) {
  const { t } = useTranslation();
  const a = acl === "new" ? null : acl;
  const [name, setName] = useState(a?.name ?? "");
  const [allow, setAllow] = useState(a?.allow.join("\n") ?? "");
  const [deny, setDeny] = useState(a?.deny.join("\n") ?? "");
  const [satisfy, setSatisfy] = useState<Acl["satisfy"]>(a?.satisfy ?? "all");
  const [users, setUsers] = useState<[string, string][]>(a?.basic_auth_users.map((u) => [u, ""]) ?? []);
  const m = useRunner();
  const save = () =>
    m
      .run(() =>
        call(a ? `/proxy/access-lists/${a.id}` : "/proxy/access-lists", a ? "PUT" : "POST", {
          name,
          allow: list(allow),
          deny: list(deny),
          satisfy,
          // an empty password keeps the stored one
          basic_auth_users: users.filter(([u]) => u.trim()).map(([u, p]) => ({ username: u.trim(), password: p || null })),
        }),
      )
      .then((ok) => ok && onClose());
  const setUser = (i: number, j: 0 | 1, v: string) => setUsers(users.map((r, n) => (n === i ? (j ? [r[0], v] : [v, r[1]]) : r)));
  return (
    <GlassModal
      open
      onClose={onClose}
      title={a ? t("rp.acl.edit") : t("rp.acl.add")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("rp.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={m.busy || !name.trim()} onClick={save}>
            {t("rp.save")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t("rp.name")}>
          <GlassInput className="w-full" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("rp.acl.allow")} hint={t("rp.listHint")}>
            <textarea className={area} rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="192.168.1.0/24" spellCheck={false} />
          </Field>
          <Field label={t("rp.acl.deny")} hint={t("rp.listHint")}>
            <textarea className={area} rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="0.0.0.0/0" spellCheck={false} />
          </Field>
        </div>
        <div className="space-y-1">
          <span className="text-[11px] text-slate-400">{t("rp.acl.satisfy")}</span>
          <div>
            <Segmented
              value={satisfy}
              onChange={setSatisfy}
              options={[
                { id: "all", label: t("rp.acl.all") },
                { id: "any", label: t("rp.acl.any") },
              ]}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <span className="text-[11px] text-slate-400">{t("rp.acl.users")}</span>
          {users.map(([u, p], i) => (
            <div key={i} className="flex gap-2">
              <GlassInput className="flex-1 font-mono" maxLength={32} value={u} onChange={(e) => setUser(i, 0, e.target.value)} aria-label={t("rp.acl.username")} placeholder={t("rp.acl.username")} />
              <GlassInput
                className="flex-1"
                type="password"
                autoComplete="new-password"
                value={p}
                onChange={(e) => setUser(i, 1, e.target.value)}
                aria-label={t("rp.acl.password")}
                placeholder={a?.basic_auth_users.includes(u) ? t("rp.acl.keepPassword") : t("rp.acl.password")}
              />
              <GlassButton size="xs" variant="ghost" onClick={() => setUsers(users.filter((_, n) => n !== i))} aria-label={t("rp.remove")}>
                <X size={12} />
              </GlassButton>
            </div>
          ))}
          <GlassButton size="xs" variant="ghost" onClick={() => setUsers([...users, ["", ""]])}>
            <Plus size={12} />
            {t("rp.acl.addUser")}
          </GlassButton>
          <p className="text-[10px] text-slate-500">{t("rp.acl.passwordHint")}</p>
        </div>
        <Notice error={m.error} />
      </div>
    </GlassModal>
  );
}
