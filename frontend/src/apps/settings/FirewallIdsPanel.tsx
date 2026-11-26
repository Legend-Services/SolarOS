import { useCallback, useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { useTranslation, type TKey } from "../../i18n";
import { Card } from "../ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassCheckbox, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice } from "../../components/ui/GlassKit";
import { swapped, withItem } from "./netstore/lists";

type Kind = "management" | "vlan" | "dmz" | "isolated_lab" | "wan";
type Proto = "any" | "tcp" | "udp" | "icmp";
type Action = "accept" | "drop" | "reject";
interface Zone {
  id: string;
  name: string;
  kind: Kind;
  interfaces: string[];
  color: string;
}
interface Rule {
  source_zone: string;
  dest_zone: string;
  protocol: Proto;
  port_range: string;
  action: Action;
  log: boolean;
  enabled: boolean;
  comment: string;
}
interface FwState {
  zones: Zone[];
  rules: Rule[];
  ruleset: string;
}
interface IdsSettings {
  jails: string[];
  bantime: number;
  findtime: number;
  maxretry: number;
  ignoreip: string[];
}
interface IdsState {
  installed: boolean;
  settings: IdsSettings;
  jails: Record<string, { failed: number; banned_total: number; banned: string[] }>;
  catalog: Record<string, string>;
}

const KINDS: Kind[] = ["management", "vlan", "dmz", "isolated_lab", "wan"];
const PROTOS: Proto[] = ["any", "tcp", "udp", "icmp"];
const ACTIONS: Action[] = ["accept", "drop", "reject"];
const ACTION_TONE = { accept: "success", drop: "danger", reject: "warning" } as const;
const KIND_TONE = { management: "info", vlan: "neutral", dmz: "warning", isolated_lab: "success", wan: "danger" } as const;
const ZONE_RE = /^[a-z][a-z0-9_]{0,15}$/;
const PORTS_RE = /^(\d{1,5}(-\d{1,5})?)?$/;
const JAIL_KEYS: Record<string, TKey> = { sshd: "ids.jail.sshd", recidive: "ids.jail.recidive", "nginx-http-auth": "ids.jail.httpAuth", "nginx-limit-req": "ids.jail.limitReq" };
const NEW_ZONE: Zone = { id: "", name: "", kind: "vlan", interfaces: [], color: "#38bdf8" };
const NEW_RULE: Rule = { source_zone: "", dest_zone: "", protocol: "any", port_range: "", action: "drop", log: false, enabled: true, comment: "" };

/** Settings > Network & Services > Firewall & IDS: inter-zone firewall (zones view) and intrusion prevention (ids view). */
export default function FirewallIdsPanel({ view }: { view: "zones" | "ids" }) {
  return view === "zones" ? <ZonesView /> : <IdsView />;
}

function ZoneDot({ zone }: { zone?: Zone }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: zone?.color ?? "#64748b" }} />
      {zone?.name ?? "?"}
    </span>
  );
}

function ZonesView() {
  const { t } = useTranslation();
  const [fw, setFw] = useState<FwState | null>(null);
  const [ifaces, setIfaces] = useState<string[]>([]);
  const [zoneEdit, setZoneEdit] = useState<{ i: number; zone: Zone } | null>(null);
  const [ruleEdit, setRuleEdit] = useState<{ i: number; rule: Rule } | null>(null);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<FwState>("/firewall").then(setFw), []);
  useEffect(() => void run(load), [run, load]);
  useEffect(() => {
    api<{ bridges: { name: string }[]; host_vnics: { name: string }[] }>("/network/switch/state").then(
      (s) => setIfaces([...s.bridges, ...s.host_vnics].map((x) => x.name)),
      () => setIfaces([]),
    );
  }, []);
  if (!fw) return <Notice error={error} />;

  const byId = Object.fromEntries(fw.zones.map((z) => [z.id, z]));
  const saveZones = (zones: Zone[]) =>
    run(async () => {
      setFw(await api<FwState>("/firewall/zones", { method: "PUT", json: zones }));
      setZoneEdit(null);
    }, t("fw.zones.saved"));
  const saveRules = (rules: Rule[]) =>
    run(async () => {
      setFw(await api<FwState>("/firewall/rules", { method: "PUT", json: rules }));
      setRuleEdit(null);
    }, t("fw.rules.saved"));

  return (
    <div className="space-y-4">
      <Notice error={zoneEdit || ruleEdit ? "" : error} notice={notice} />
      <div data-anchor="fw-zones">
        <Card
          title={t("fw.zones.title")}
          action={
            <GlassButton size="xs" onClick={() => setZoneEdit({ i: -1, zone: NEW_ZONE })} disabled={busy}>
              <Plus size={12} /> {t("fw.zones.add")}
            </GlassButton>
          }
        >
          {fw.zones.length === 0 && <p className="text-xs text-slate-400">{t("fw.zones.empty")}</p>}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {fw.zones.map((z, i) => (
              <button
                key={z.id}
                type="button"
                onClick={() => setZoneEdit({ i, zone: z })}
                className="rounded-xl border-l-4 bg-white/[0.04] p-3 text-left ring-1 ring-white/10 transition hover:bg-white/[0.08]"
                style={{ borderLeftColor: z.color }}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-sm font-medium text-white">{z.name}</span>
                  <GlassBadge tone={KIND_TONE[z.kind]}>{t(`fw.kind.${z.kind}`)}</GlassBadge>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-slate-500">{z.id}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {z.interfaces.map((n) => (
                    <span key={n} className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">
                      {n}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <div data-anchor="fw-rules">
        <Card
          title={t("fw.rules.title")}
          action={
            <GlassButton size="xs" onClick={() => setRuleEdit({ i: -1, rule: { ...NEW_RULE, source_zone: fw.zones[0]?.id ?? "", dest_zone: fw.zones[1]?.id ?? fw.zones[0]?.id ?? "" } })} disabled={busy || !fw.zones.length}>
              <Plus size={12} /> {t("fw.rules.add")}
            </GlassButton>
          }
        >
          <p className="mb-3 text-[11px] text-slate-400">{t("fw.rules.hint")}</p>
          {fw.rules.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1.5 pr-2">#</th>
                    <th className="px-2">{t("fw.rules.path")}</th>
                    <th className="px-2">{t("fw.rules.protocol")}</th>
                    <th className="px-2">{t("fw.rules.ports")}</th>
                    <th className="px-2">{t("fw.rules.action")}</th>
                    <th className="px-2">{t("fw.rules.log")}</th>
                    <th className="px-2">{t("fw.rules.enabled")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {fw.rules.map((r, i) => (
                    <tr key={i} className={`border-t border-white/5 ${r.enabled ? "" : "opacity-50"}`}>
                      <td className="py-1.5 pr-2 text-slate-500 tabular-nums">{i + 1}</td>
                      <td className="px-2 whitespace-nowrap text-slate-100">
                        <ZoneDot zone={byId[r.source_zone]} /> <span className="text-slate-500">→</span> <ZoneDot zone={byId[r.dest_zone]} />
                        {r.comment && <div className="text-[10px] text-slate-500">{r.comment}</div>}
                      </td>
                      <td className="px-2 text-slate-300 uppercase">{r.protocol === "any" ? t("fw.proto.any") : r.protocol}</td>
                      <td className="px-2 font-mono text-slate-300">{r.port_range || "—"}</td>
                      <td className="px-2">
                        <GlassBadge tone={ACTION_TONE[r.action]}>{t(`fw.action.${r.action}`)}</GlassBadge>
                      </td>
                      <td className="px-2 text-slate-400">{r.log ? t("fw.yes") : "—"}</td>
                      <td className="px-2">
                        <GlassSwitch checked={r.enabled} disabled={busy} onChange={(enabled) => saveRules(withItem(fw.rules, i, { ...r, enabled }))} />
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <GlassButton size="xs" variant="ghost" disabled={busy || i === 0} onClick={() => saveRules(swapped(fw.rules, i, -1))} aria-label={t("fw.rules.up")} title={t("fw.rules.up")}>
                          <ArrowUp size={12} />
                        </GlassButton>
                        <GlassButton size="xs" variant="ghost" disabled={busy || i === fw.rules.length - 1} onClick={() => saveRules(swapped(fw.rules, i, 1))} aria-label={t("fw.rules.down")} title={t("fw.rules.down")}>
                          <ArrowDown size={12} />
                        </GlassButton>
                        <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => setRuleEdit({ i, rule: r })} aria-label={t("fw.edit")} title={t("fw.edit")}>
                          <Pencil size={12} />
                        </GlassButton>
                        <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => saveRules(withItem(fw.rules, i, null))} aria-label={t("fw.delete")} title={t("fw.delete")}>
                          <Trash2 size={12} />
                        </GlassButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {fw.zones.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-1.5 text-xs font-semibold text-slate-200">{t("fw.matrix.title")}</h4>
              <div className="overflow-x-auto">
                <table className="text-[11px]">
                  <thead>
                    <tr>
                      <th className="px-2 py-1 text-left font-normal text-slate-500">{t("fw.matrix.corner")}</th>
                      {fw.zones.map((d) => (
                        <th key={d.id} className="px-2 py-1 text-left font-medium whitespace-nowrap text-slate-300">
                          <ZoneDot zone={d} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fw.zones.map((s) => (
                      <tr key={s.id} className="border-t border-white/5">
                        <th className="px-2 py-1 text-left font-medium whitespace-nowrap text-slate-300">
                          <ZoneDot zone={s} />
                        </th>
                        {fw.zones.map((d) => {
                          const r = fw.rules.find((x) => x.enabled && x.source_zone === s.id && x.dest_zone === d.id);
                          return (
                            <td key={d.id} className="px-2 py-1 whitespace-nowrap">
                              {r ? (
                                <GlassBadge tone={ACTION_TONE[r.action]}>
                                  {t(`fw.action.${r.action}`)}
                                  {r.protocol !== "any" && ` · ${r.protocol.toUpperCase()}${r.port_range ? ` ${r.port_range}` : ""}`}
                                </GlassBadge>
                              ) : (
                                <span className="text-slate-500">{t("fw.matrix.default")}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-slate-300 select-none">{t("fw.ruleset")}</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[10px] text-slate-300">{fw.ruleset.trim() || t("fw.ruleset.empty")}</pre>
          </details>
        </Card>
      </div>

      {zoneEdit && (
        <ZoneModal
          edit={zoneEdit}
          ifaces={ifaces}
          taken={fw.zones.filter((_, n) => n !== zoneEdit.i).map((z) => z.id)}
          busy={busy}
          error={error}
          onClose={() => setZoneEdit(null)}
          onSave={(z) => saveZones(withItem(fw.zones, zoneEdit.i, z))}
          onDelete={zoneEdit.i < 0 ? undefined : () => saveZones(withItem(fw.zones, zoneEdit.i, null))}
        />
      )}
      {ruleEdit && (
        <RuleModal edit={ruleEdit} zones={fw.zones} busy={busy} error={error} onClose={() => setRuleEdit(null)} onSave={(r) => saveRules(withItem(fw.rules, ruleEdit.i, r))} />
      )}
    </div>
  );
}

function ZoneModal({
  edit,
  ifaces,
  taken,
  busy,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  edit: { i: number; zone: Zone };
  ifaces: string[];
  taken: string[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (z: Zone) => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [z, setZ] = useState(edit.zone);
  const [iface, setIface] = useState("");
  const idOk = ZONE_RE.test(z.id) && !taken.includes(z.id);
  const addIface = () => {
    const v = iface.trim();
    if (v && !z.interfaces.includes(v)) setZ({ ...z, interfaces: [...z.interfaces, v] });
    setIface("");
  };
  return (
    <GlassModal
      open
      onClose={onClose}
      title={edit.i < 0 ? t("fw.zones.add") : t("fw.zones.edit", { name: edit.zone.name })}
      footer={
        <>
          {onDelete && (
            <GlassButton variant="danger" disabled={busy} onClick={onDelete} className="mr-auto">
              <Trash2 size={12} /> {t("fw.delete")}
            </GlassButton>
          )}
          <GlassButton onClick={onClose}>{t("fw.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !idOk || !z.name.trim() || !z.interfaces.length} onClick={() => onSave({ ...z, name: z.name.trim() })}>
            {t("fw.save")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("fw.zone.id")} hint={edit.i < 0 ? t("fw.zone.idHint") : t("fw.zone.idFixed")}>
            <GlassInput className="w-full font-mono" value={z.id} disabled={edit.i >= 0} onChange={(e) => setZ({ ...z, id: e.target.value.toLowerCase() })} placeholder="lab" spellCheck={false} />
          </Field>
          <Field label={t("fw.zone.name")}>
            <GlassInput className="w-full" value={z.name} maxLength={40} onChange={(e) => setZ({ ...z, name: e.target.value })} />
          </Field>
          <Field label={t("fw.zone.kind")}>
            <GlassSelect className="w-full" value={z.kind} onChange={(e) => setZ({ ...z, kind: e.target.value as Kind })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`fw.kind.${k}`)}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label={t("fw.zone.color")}>
            <input type="color" value={z.color} onChange={(e) => setZ({ ...z, color: e.target.value })} className="h-8 w-16 cursor-pointer rounded-lg bg-transparent" />
          </Field>
        </div>
        <Field label={t("fw.zone.interfaces")} hint={t("fw.zone.interfacesHint")}>
          <div className="flex gap-2">
            <GlassInput
              className="flex-1 font-mono"
              list={listId}
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addIface())}
              placeholder="br0"
              spellCheck={false}
            />
            <GlassButton onClick={addIface} disabled={!iface.trim()}>
              <Plus size={12} /> {t("fw.add")}
            </GlassButton>
          </div>
          <datalist id={listId}>
            {ifaces.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Field>
        <div className="flex flex-wrap gap-1">
          {z.interfaces.map((n) => (
            <span key={n} className="inline-flex items-center gap-1 rounded bg-white/10 py-0.5 pr-1 pl-1.5 font-mono text-[11px] text-slate-200">
              {n}
              <button type="button" onClick={() => setZ({ ...z, interfaces: z.interfaces.filter((x) => x !== n) })} aria-label={t("fw.remove", { name: n })} className="text-slate-400 hover:text-white">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        {onDelete && <p className="text-[11px] text-slate-500">{t("fw.zone.deleteHint")}</p>}
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

function RuleModal({ edit, zones, busy, error, onClose, onSave }: { edit: { i: number; rule: Rule }; zones: Zone[]; busy: boolean; error: string; onClose: () => void; onSave: (r: Rule) => void }) {
  const { t } = useTranslation();
  const [r, setR] = useState(edit.rule);
  const ports = r.protocol === "tcp" || r.protocol === "udp";
  const zoneSelect = (key: "source_zone" | "dest_zone") => (
    <GlassSelect className="w-full" value={r[key]} onChange={(e) => setR({ ...r, [key]: e.target.value })}>
      {zones.map((z) => (
        <option key={z.id} value={z.id}>
          {z.name}
        </option>
      ))}
    </GlassSelect>
  );
  return (
    <GlassModal
      open
      onClose={onClose}
      title={edit.i < 0 ? t("fw.rules.add") : t("fw.rules.edit", { n: edit.i + 1 })}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("fw.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !PORTS_RE.test(r.port_range)} onClick={() => onSave(r)}>
            {t("fw.save")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("fw.rules.from")}>{zoneSelect("source_zone")}</Field>
          <Field label={t("fw.rules.to")}>{zoneSelect("dest_zone")}</Field>
          <Field label={t("fw.rules.protocol")}>
            <GlassSelect className="w-full" value={r.protocol} onChange={(e) => setR({ ...r, protocol: e.target.value as Proto, port_range: "" })}>
              {PROTOS.map((p) => (
                <option key={p} value={p}>
                  {p === "any" ? t("fw.proto.any") : p.toUpperCase()}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label={t("fw.rules.ports")} hint={ports ? t("fw.rules.portsHint") : t("fw.rules.portsNeedProto")}>
            <GlassInput className="w-full font-mono" value={r.port_range} disabled={!ports} onChange={(e) => setR({ ...r, port_range: e.target.value.trim() })} placeholder="443 / 8000-8100" />
          </Field>
          <Field label={t("fw.rules.action")}>
            <GlassSelect className="w-full" value={r.action} onChange={(e) => setR({ ...r, action: e.target.value as Action })}>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`fw.action.${a}`)}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label={t("fw.rules.comment")}>
            <GlassInput className="w-full" value={r.comment} maxLength={60} onChange={(e) => setR({ ...r, comment: e.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <GlassCheckbox checked={r.log} onChange={(log) => setR({ ...r, log })} label={t("fw.rules.logLabel")} />
          <GlassCheckbox checked={r.enabled} onChange={(enabled) => setR({ ...r, enabled })} label={t("fw.rules.enabled")} />
        </div>
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

function IdsView() {
  const { t } = useTranslation();
  const [ids, setIds] = useState<IdsState | null>(null);
  const [draft, setDraft] = useState<IdsSettings | null>(null);
  const [ban, setBan] = useState({ jail: "", ip: "" });
  const { busy, error, notice, run } = useRunner();
  const show = (s: IdsState) => {
    setIds(s);
    setDraft(s.settings);
  };
  const load = useCallback(() => api<IdsState>("/firewall/ids").then(show), []);
  useEffect(() => void run(load), [run, load]);
  if (!ids || !draft) return <Notice error={error} />;

  const jailNames = Object.keys(ids.jails);
  const banJail = ban.jail || jailNames[0] || "";
  const num = (key: "bantime" | "findtime" | "maxretry", label: TKey, min: number) => (
    <Field label={t(label)}>
      <GlassInput type="number" min={min} className="w-full" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />
    </Field>
  );
  const unban = (jail: string, ip: string) => run(() => api("/firewall/ids/unban", { method: "POST", json: { jail, ip } }).then(load), t("ids.unbanned", { ip }));

  return (
    <div className="space-y-4">
      <Notice error={error} notice={notice} />
      <div data-anchor="ids-settings">
        <Card title={t("ids.settings.title")} action={<GlassBadge tone={ids.installed ? "success" : "neutral"}>{t(ids.installed ? "ids.installed" : "ids.notInstalled")}</GlassBadge>}>
          <p className="mb-3 text-[11px] text-slate-400">{t("ids.settings.hint")}</p>
          <div className="mb-3 space-y-1.5">
            {Object.entries(ids.catalog).map(([id, desc]) => (
              <GlassCheckbox
                key={id}
                className="flex"
                checked={draft.jails.includes(id)}
                onChange={(on) => setDraft({ ...draft, jails: on ? [...draft.jails, id] : draft.jails.filter((j) => j !== id) })}
                label={
                  <>
                    <span className="font-mono text-slate-100">{id}</span> <span className="text-slate-400">— {JAIL_KEYS[id] ? t(JAIL_KEYS[id]) : desc}</span>
                  </>
                }
              />
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {num("bantime", "ids.bantime", 60)}
            {num("findtime", "ids.findtime", 60)}
            {num("maxretry", "ids.maxretry", 1)}
          </div>
          <Field label={t("ids.ignoreip")} hint={t("ids.ignoreipHint")} className="mt-3">
            <textarea
              className="glass-field h-20 w-full font-mono"
              value={draft.ignoreip.join("\n")}
              onChange={(e) => setDraft({ ...draft, ignoreip: e.target.value.split("\n") })}
              placeholder="192.168.1.0/24"
              spellCheck={false}
            />
          </Field>
          <div className="mt-3 flex items-center gap-3">
            <GlassButton
              variant="primary"
              disabled={busy}
              onClick={() => run(() => api<IdsState>("/firewall/ids", { method: "PUT", json: { ...draft, ignoreip: draft.ignoreip.filter((x) => x.trim()) } }).then(show), t("ids.saved"))}
            >
              {busy ? t("fw.working") : t("fw.save")}
            </GlassButton>
            {!ids.installed && <span className="text-[11px] text-slate-500">{t("ids.firstInstall")}</span>}
          </div>
        </Card>
      </div>

      <div data-anchor="ids-jails">
        <Card
          title={t("ids.jails.title")}
          action={
            <GlassButton size="xs" variant="ghost" onClick={() => run(load)} disabled={busy} aria-label={t("fw.refresh")}>
              <RefreshCw size={12} />
            </GlassButton>
          }
        >
          {jailNames.length === 0 ? (
            <p className="text-xs text-slate-400">{t(ids.installed ? "ids.jails.none" : "ids.jails.notInstalled")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1.5">{t("ids.jail")}</th>
                  <th className="px-2">{t("ids.failed")}</th>
                  <th className="px-2">{t("ids.bannedTotal")}</th>
                  <th className="px-2">{t("ids.banned")}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(ids.jails).map(([jail, s]) => (
                  <tr key={jail} className="border-t border-white/5 align-top">
                    <td className="py-1.5 font-mono text-slate-100">{jail}</td>
                    <td className="px-2 tabular-nums">{s.failed}</td>
                    <td className="px-2 tabular-nums">{s.banned_total}</td>
                    <td className="px-2">
                      <div className="flex flex-wrap gap-1">
                        {s.banned.length === 0 && <span className="text-slate-500">—</span>}
                        {s.banned.map((ip) => (
                          <span key={ip} className="inline-flex items-center gap-1 rounded bg-rose-500/15 py-0.5 pr-0.5 pl-1.5 font-mono text-[11px] text-rose-100">
                            {ip}
                            <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => unban(jail, ip)}>
                              {t("ids.unban")}
                            </GlassButton>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {jailNames.length > 0 && (
            <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/5 pt-3">
              <Field label={t("ids.jail")}>
                <GlassSelect value={banJail} onChange={(e) => setBan({ ...ban, jail: e.target.value })}>
                  {jailNames.map((j) => (
                    <option key={j}>{j}</option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label={t("ids.ip")}>
                <GlassInput className="w-48 font-mono" value={ban.ip} onChange={(e) => setBan({ ...ban, ip: e.target.value })} placeholder="203.0.113.7" spellCheck={false} />
              </Field>
              <GlassButton
                variant="danger"
                disabled={busy || !ban.ip.trim()}
                onClick={() => run(() => api("/firewall/ids/ban", { method: "POST", json: { jail: banJail, ip: ban.ip.trim() } }).then(() => setBan({ ...ban, ip: "" })).then(load), t("ids.bannedIp", { ip: ban.ip.trim() }))}
              >
                {t("ids.ban")}
              </GlassButton>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
