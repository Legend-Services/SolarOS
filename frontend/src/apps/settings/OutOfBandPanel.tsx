import { useCallback, useEffect, useState } from "react";
import { Activity, Pencil, Plus, Power, PowerOff, RefreshCw, RotateCcw, Trash2, Zap } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { useTranslation } from "../../i18n";
import { Card } from "../ControlPanelApp";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, Notice } from "../../components/ui/GlassKit";

type Protocol = "ipmi" | "redfish" | "wol_only";
type Action = "on" | "off" | "cycle" | "soft-reset";
interface Host {
  id: string;
  name: string;
  protocol: Protocol;
  address: string;
  username: string;
  mac: string;
  wol_broadcast: string;
  password_set: boolean;
}
type Form = Omit<Host, "id" | "password_set"> & { password: string };
interface Sensors {
  power: string;
  sensors: { name: string; status: string; reading: string }[];
}

const BLANK: Form = { name: "", protocol: "ipmi", address: "", username: "", mac: "", wol_broadcast: "255.255.255.255", password: "" };
const ACTIONS: { id: Action; icon: typeof Power }[] = [
  { id: "on", icon: Power },
  { id: "off", icon: PowerOff },
  { id: "cycle", icon: RefreshCw },
  { id: "soft-reset", icon: RotateCcw },
];

/** Settings > Cluster & HA > Out-of-Band & Wake-on-LAN: BMC hosts (IPMI / Redfish) with power control, sensors and Wake-on-LAN. */
export default function OutOfBandPanel() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [edit, setEdit] = useState<{ id?: string; set: boolean; f: Form } | null>(null);
  const [confirm, setConfirm] = useState<{ host: Host; action: Action | "delete" } | null>(null);
  const [sensors, setSensors] = useState<{ host: Host; data?: Sensors } | null>(null);
  const { busy, error, notice, run } = useRunner();
  const modal = useRunner();

  const load = useCallback(() => api<{ hosts: Host[] }>("/oob/hosts").then((r) => setHosts(r.hosts)), []);
  useEffect(() => void run(load), [run, load]);

  const power = (h: Host, action: Action) =>
    run(() => api(`/oob/hosts/${h.id}/power/${action}`, { method: "POST" }), t("oob.sent", { action: t(`oob.a.${action}`), name: h.name }));
  const wake = (h: Host) => run(() => api(`/oob/hosts/${h.id}/wake`, { method: "POST" }), t("oob.woke", { name: h.name }));
  const showSensors = (host: Host) => {
    setSensors({ host });
    void modal.run(() => api<Sensors>(`/oob/hosts/${host.id}/sensors`).then((data) => setSensors({ host, data })));
  };
  const save = async () => {
    if (!edit) return;
    const json = { ...edit.f, password: edit.f.password || (edit.id ? null : "") };
    if (await modal.run(() => api(edit.id ? `/oob/hosts/${edit.id}` : "/oob/hosts", { method: edit.id ? "PUT" : "POST", json }).then(load))) setEdit(null);
  };
  const doConfirm = async () => {
    if (!confirm) return;
    const { host, action } = confirm;
    const ok = await modal.run(() =>
      action === "delete" ? api(`/oob/hosts/${host.id}`, { method: "DELETE" }).then(load) : api(`/oob/hosts/${host.id}/power/${action}`, { method: "POST" }),
    );
    if (ok) setConfirm(null);
  };
  const setF = (p: Partial<Form>) => setEdit((e) => e && { ...e, f: { ...e.f, ...p } });
  const f = edit?.f;

  return (
    <div data-anchor="oob-hosts">
      <Card
        title={t("oob.hosts")}
        action={
          <GlassButton size="xs" onClick={() => (modal.setError(""), setEdit({ set: false, f: BLANK }))}>
            <Plus size={12} /> {t("oob.add")}
          </GlassButton>
        }
      >
        <Notice error={error} notice={notice} />
        {hosts && !hosts.length && <p className="text-xs text-slate-400">{t("oob.empty")}</p>}
        {!!hosts?.length && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1.5">{t("oob.name")}</th>
                  <th className="px-2">{t("oob.protocol")}</th>
                  <th className="px-2 max-md:hidden">{t("oob.address")}</th>
                  <th className="px-2 max-md:hidden">{t("oob.mac")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hosts.map((h) => (
                  <tr key={h.id} className="border-t border-white/5">
                    <td className="py-1.5 text-slate-100">{h.name}</td>
                    <td className="px-2">
                      <GlassBadge tone={h.protocol === "wol_only" ? "neutral" : "info"}>{t(`oob.p.${h.protocol}`)}</GlassBadge>
                    </td>
                    <td className="px-2 font-mono text-slate-300 max-md:hidden">{h.address || "—"}</td>
                    <td className="px-2 font-mono text-slate-300 max-md:hidden">{h.mac || "—"}</td>
                    <td className="whitespace-nowrap text-right">
                      {h.protocol !== "wol_only" &&
                        ACTIONS.map(({ id, icon: Icon }) => (
                          <GlassButton
                            key={id}
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            title={t(`oob.a.${id}`)}
                            aria-label={`${t(`oob.a.${id}`)}: ${h.name}`}
                            onClick={() => (id === "off" || id === "cycle" ? (modal.setError(""), setConfirm({ host: h, action: id })) : power(h, id))}
                          >
                            <Icon size={12} />
                          </GlassButton>
                        ))}
                      {h.mac && (
                        <GlassButton size="xs" variant="ghost" disabled={busy} title={t("oob.wake")} aria-label={`${t("oob.wake")}: ${h.name}`} onClick={() => wake(h)}>
                          <Zap size={12} />
                        </GlassButton>
                      )}
                      {h.protocol !== "wol_only" && (
                        <GlassButton size="xs" variant="ghost" title={t("oob.sensors")} aria-label={`${t("oob.sensors")}: ${h.name}`} onClick={() => showSensors(h)}>
                          <Activity size={12} />
                        </GlassButton>
                      )}
                      <GlassButton
                        size="xs"
                        variant="ghost"
                        title={t("common.edit")}
                        aria-label={`${t("common.edit")}: ${h.name}`}
                        onClick={() => (modal.setError(""), setEdit({ id: h.id, set: h.password_set, f: { ...h, password: "" } }))}
                      >
                        <Pencil size={12} />
                      </GlassButton>
                      <GlassButton
                        size="xs"
                        variant="ghost"
                        title={t("common.delete")}
                        aria-label={`${t("common.delete")}: ${h.name}`}
                        onClick={() => (modal.setError(""), setConfirm({ host: h, action: "delete" }))}
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

      <GlassModal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? t("oob.editHost") : t("oob.add")}
        footer={
          <>
            <GlassButton onClick={() => setEdit(null)}>{t("common.cancel")}</GlassButton>
            <GlassButton variant="primary" disabled={modal.busy || !f?.name.trim()} onClick={save}>
              {t("common.save")}
            </GlassButton>
          </>
        }
      >
        {f && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("oob.name")}>
              <GlassInput className="w-full" value={f.name} onChange={(e) => setF({ name: e.target.value })} autoFocus />
            </Field>
            <Field label={t("oob.protocol")}>
              <GlassSelect className="w-full" value={f.protocol} onChange={(e) => setF({ protocol: e.target.value as Protocol })}>
                {(["ipmi", "redfish", "wol_only"] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`oob.p.${p}`)}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            {f.protocol !== "wol_only" && (
              <>
                <Field label={t("oob.address")} className="sm:col-span-2">
                  <GlassInput className="w-full font-mono" value={f.address} onChange={(e) => setF({ address: e.target.value })} placeholder="192.168.1.20" />
                </Field>
                <Field label={t("oob.username")}>
                  <GlassInput className="w-full" value={f.username} onChange={(e) => setF({ username: e.target.value })} autoComplete="off" />
                </Field>
                <Field label={t("oob.password")} hint={edit?.set ? t("oob.passwordKeep") : undefined}>
                  <GlassInput type="password" className="w-full" value={f.password} onChange={(e) => setF({ password: e.target.value })} autoComplete="new-password" />
                </Field>
              </>
            )}
            <Field label={t("oob.mac")} hint={t("oob.macHint")}>
              <GlassInput className="w-full font-mono" value={f.mac} onChange={(e) => setF({ mac: e.target.value })} placeholder="aa:bb:cc:dd:ee:ff" />
            </Field>
            <Field label={t("oob.broadcast")}>
              <GlassInput className="w-full font-mono" value={f.wol_broadcast} onChange={(e) => setF({ wol_broadcast: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Notice error={modal.error} />
            </div>
          </div>
        )}
      </GlassModal>

      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={doConfirm}
        busy={modal.busy}
        error={modal.error}
        title={confirm ? (confirm.action === "delete" ? t("oob.deleteTitle") : t(`oob.a.${confirm.action}`)) : ""}
        message={confirm ? t(confirm.action === "delete" ? "oob.deleteMsg" : "oob.powerMsg", { name: confirm.host.name }) : ""}
        confirmLabel={confirm ? (confirm.action === "delete" ? t("common.delete") : t(`oob.a.${confirm.action}`)) : undefined}
      />

      <GlassModal open={!!sensors} onClose={() => setSensors(null)} side width="max-w-md" title={sensors ? t("oob.sensorsOf", { name: sensors.host.name }) : ""}>
        {modal.busy && <p className="text-xs text-slate-400">{t("common.loading")}</p>}
        <Notice error={sensors && !sensors.data ? modal.error : undefined} />
        {sensors?.data && (
          <div className="space-y-3 text-xs">
            <p className="text-slate-300">
              {t("oob.powerState")}{" "}
              <GlassBadge tone={sensors.data.power === "on" ? "success" : sensors.data.power === "off" ? "neutral" : "warning"}>{sensors.data.power}</GlassBadge>
            </p>
            {sensors.data.sensors.length ? (
              <table className="w-full">
                <tbody>
                  {sensors.data.sensors.map((r, i) => (
                    <tr key={i} className="border-t border-white/5">
                      <td className="py-1 text-slate-200">{r.name}</td>
                      <td className="px-2 text-slate-400">{r.status}</td>
                      <td className="text-right font-mono text-slate-100">{r.reading}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-slate-400">{t("oob.noSensors")}</p>
            )}
          </div>
        )}
      </GlassModal>
    </div>
  );
}
