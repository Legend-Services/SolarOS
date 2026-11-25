import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Bell, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { usePoll, useRunner } from "../lib/hooks";
import { useTranslation, type TKey } from "../i18n";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";

/* ---------------- Types (mirror backend/app/automation.py) ---------------- */

type ChannelId = "telegram" | "discord" | "webhook" | "email";
interface Channels {
  telegram: { enabled: boolean; bot_token: string; chat_id: string };
  discord: { enabled: boolean; webhook_url: string };
  webhook: { enabled: boolean; url: string; method: "POST" | "PUT"; bearer_token: string };
  email: { enabled: boolean; smtp_host: string; smtp_port: number; username: string; password: string; from_email: string; to_email: string; use_tls: boolean };
}
type Trigger = "gpu_temp_above" | "disk_temp_above" | "zfs_pool_degraded" | "storage_usage_above" | "guest_stopped_unexpectedly" | "scheduled_time";
type Action = "send_external_alert" | "restart_guest" | "start_guest" | "stop_guest" | "prune_old_snapshots";
interface GuestRef {
  type: "qemu" | "lxc";
  vmid: number;
}
interface Rule {
  id?: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  threshold: number | null;
  target: GuestRef | null;
  time: string | null;
  days: number[];
  action: Action;
  channels: ChannelId[];
  cooldown_minutes: number;
  prune_older_than_days: number;
  last_fired?: number | null;
  last_status?: string | null;
}
interface LogEntry {
  id: string;
  timestamp: number;
  rule_name: string;
  trigger_summary: string;
  action_result: string;
  status: "ok" | "partial" | "error";
}
interface Guest {
  vmid: number;
  name: string;
  type: "qemu" | "lxc";
}

const CHANNELS: ChannelId[] = ["telegram", "discord", "webhook", "email"];
const TRIGGERS: Trigger[] = ["gpu_temp_above", "disk_temp_above", "zfs_pool_degraded", "storage_usage_above", "guest_stopped_unexpectedly", "scheduled_time"];
const ACTIONS: Action[] = ["send_external_alert", "restart_guest", "start_guest", "stop_guest", "prune_old_snapshots"];
const UNIT: Partial<Record<Trigger, { unit: string; def: number; min: number; max: number }>> = {
  gpu_temp_above: { unit: "°C", def: 80, min: 20, max: 120 },
  disk_temp_above: { unit: "°C", def: 55, min: 20, max: 100 },
  storage_usage_above: { unit: "%", def: 85, min: 1, max: 100 },
};
const GUEST_ACTIONS: Action[] = ["restart_guest", "start_guest", "stop_guest"];
const EMPTY: Rule = { name: "", enabled: true, trigger: "gpu_temp_above", threshold: 80, target: null, time: "03:00", days: [], action: "send_external_alert", channels: [], cooldown_minutes: 15, prune_older_than_days: 7 };
const CH_NAME: Record<ChannelId, string> = { telegram: "Telegram", discord: "Discord", webhook: "Webhook", email: "Email" };

type T = ReturnType<typeof useTranslation>["t"];

/** Plain-English one-liner, e.g. "When GPU Temperature > 80°C → Send Telegram & Discord Alert". */
export function ruleSummary(r: Rule, t: T, guestName: (g: GuestRef | null) => string): string {
  const guest = guestName(r.target);
  const days = r.days.length ? r.days.map((d) => t(`auto.day.${d}` as TKey)).join(", ") : t("auto.sum.everyDay");
  const trigger = t(`auto.sum.${r.trigger}`, { n: r.threshold ?? "", guest, time: r.time ?? "", days });
  const channels = r.channels.length ? r.channels.map((c) => CH_NAME[c]).join(` ${t("auto.and")} `) : t("auto.sum.allChannels");
  const action =
    r.action === "send_external_alert" ? t("auto.sum.alert", { channels })
    : r.action === "restart_guest" ? t("auto.sum.restart", { guest })
    : r.action === "start_guest" ? t("auto.sum.start", { guest })
    : r.action === "stop_guest" ? t("auto.sum.stop", { guest })
    : t("auto.sum.prune", { n: r.prune_older_than_days });
  return t("auto.sum.rule", { trigger, action });
}

/* ---------------- Alert channels ---------------- */

function ChannelCard({ id, enabled, onToggle, onTest, testing, children, t }: { id: ChannelId; enabled: boolean; onToggle: (v: boolean) => void; onTest: () => void; testing: boolean; children: ReactNode; t: T }) {
  return (
    <section className="glass-soft space-y-3 rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">{t(`auto.channel.${id}`)}</h3>
        <GlassButton size="xs" onClick={onTest} disabled={!enabled || testing}>
          <Send size={12} /> {t("auto.sendTest")}
        </GlassButton>
        <GlassSwitch checked={enabled} onChange={onToggle} label={t("common.enabled")} />
      </div>
      {enabled && <div className="grid gap-3 sm:grid-cols-2">{children}</div>}
    </section>
  );
}

function ChannelsTab({ t }: { t: T }) {
  const [c, setC] = useState<Channels | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [testing, setTesting] = useState<ChannelId | null>(null);
  const [test, setTest] = useState<{ error?: string; notice?: string }>({});
  const { busy, error, notice, run } = useRunner();
  useEffect(() => {
    api<Channels>("/automation/channels").then((x) => (setC(x), setSaved(JSON.stringify(x))), (e) => setTest({ error: e.message }));
  }, []);
  if (!c) return <Notice error={test.error} />;
  const set = <K extends ChannelId>(id: K, patch: Partial<Channels[K]>) => setC({ ...c, [id]: { ...c[id], ...patch } });
  const dirty = JSON.stringify(c) !== saved;
  const secret = (v: string) => (v.startsWith("•") ? t("auto.secretKept") : undefined);
  const save = () =>
    run(async () => {
      const x = await api<Channels>("/automation/channels", { method: "PUT", json: c });
      setC(x);
      setSaved(JSON.stringify(x));
    }, t("auto.saved"));
  const sendTest = async (id: ChannelId) => {
    setTesting(id);
    setTest({});
    try {
      if (dirty) await save();
      const r = await api<{ ok: boolean; detail: string }>("/automation/channels/test", { method: "POST", json: { channel: id } });
      setTest(r.ok ? { notice: t("auto.testOk", { detail: `${CH_NAME[id]} — ${r.detail}` }) } : { error: t("auto.testFail", { detail: `${CH_NAME[id]} — ${r.detail}` }) });
    } catch (e) {
      setTest({ error: t("auto.testFail", { detail: (e as Error).message }) });
    } finally {
      setTesting(null);
    }
  };
  const card = (id: ChannelId, children: ReactNode) => (
    <ChannelCard id={id} enabled={c[id].enabled} onToggle={(v) => set(id, { enabled: v })} onTest={() => sendTest(id)} testing={testing === id} t={t}>
      {children}
    </ChannelCard>
  );
  return (
    <div className="space-y-4">
      {card(
        "telegram",
        <>
          <Field label={t("auto.botToken")} hint={secret(c.telegram.bot_token)}>
            <GlassInput className="w-full font-mono" value={c.telegram.bot_token} placeholder="123456789:AA…" onChange={(e) => set("telegram", { bot_token: e.target.value.trim() })} autoComplete="off" />
          </Field>
          <Field label={t("auto.chatId")}>
            <GlassInput className="w-full font-mono" value={c.telegram.chat_id} placeholder="-1001234567890" onChange={(e) => set("telegram", { chat_id: e.target.value.trim() })} />
          </Field>
        </>,
      )}
      {card(
        "discord",
        <Field label={t("auto.webhookUrl")} hint={secret(c.discord.webhook_url)} className="sm:col-span-2">
          <GlassInput className="w-full font-mono" value={c.discord.webhook_url} placeholder="https://discord.com/api/webhooks/…" onChange={(e) => set("discord", { webhook_url: e.target.value.trim() })} autoComplete="off" />
        </Field>,
      )}
      {card(
        "webhook",
        <>
          <Field label={t("auto.url")} className="sm:col-span-2">
            <GlassInput className="w-full font-mono" value={c.webhook.url} placeholder="https://example.com/hooks/solardeck" onChange={(e) => set("webhook", { url: e.target.value.trim() })} />
          </Field>
          <Field label={t("auto.method")}>
            <GlassSelect className="w-full" value={c.webhook.method} onChange={(e) => set("webhook", { method: e.target.value as "POST" | "PUT" })}>
              <option>POST</option>
              <option>PUT</option>
            </GlassSelect>
          </Field>
          <Field label={t("auto.bearer")} hint={secret(c.webhook.bearer_token)}>
            <GlassInput className="w-full font-mono" value={c.webhook.bearer_token} onChange={(e) => set("webhook", { bearer_token: e.target.value.trim() })} autoComplete="off" />
          </Field>
        </>,
      )}
      {card(
        "email",
        <>
          <Field label={t("auto.smtpHost")}>
            <GlassInput className="w-full" value={c.email.smtp_host} placeholder="smtp.example.com" onChange={(e) => set("email", { smtp_host: e.target.value.trim() })} />
          </Field>
          <Field label={t("auto.smtpPort")}>
            <GlassInput className="w-full" type="number" min={1} max={65535} value={c.email.smtp_port} onChange={(e) => set("email", { smtp_port: Number(e.target.value) })} />
          </Field>
          <Field label={t("auto.smtpUser")}>
            <GlassInput className="w-full" value={c.email.username} onChange={(e) => set("email", { username: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={t("auto.smtpPass")} hint={secret(c.email.password)}>
            <GlassInput className="w-full" type="password" value={c.email.password} onChange={(e) => set("email", { password: e.target.value })} autoComplete="new-password" />
          </Field>
          <Field label={t("auto.from")}>
            <GlassInput className="w-full" type="email" value={c.email.from_email} onChange={(e) => set("email", { from_email: e.target.value.trim() })} />
          </Field>
          <Field label={t("auto.to")}>
            <GlassInput className="w-full" type="email" value={c.email.to_email} onChange={(e) => set("email", { to_email: e.target.value.trim() })} />
          </Field>
          <GlassSwitch className="sm:col-span-2" checked={c.email.use_tls} onChange={(v) => set("email", { use_tls: v })} label={t("auto.useTls")} />
        </>,
      )}
      <Notice error={error || test.error} notice={test.notice || notice} />
      <div className="flex justify-end">
        <GlassButton variant="primary" onClick={save} disabled={busy || !dirty}>
          {t("auto.saveChannels")}
        </GlassButton>
      </div>
    </div>
  );
}

/* ---------------- Rules ---------------- */

function RuleEditor({ rule, guests, onClose, onSaved, t }: { rule: Rule; guests: Guest[]; onClose: () => void; onSaved: () => void; t: T }) {
  const [r, setR] = useState<Rule>(rule);
  const { busy, error, run } = useRunner();
  const u = UNIT[r.trigger];
  const needsGuest = r.trigger === "guest_stopped_unexpectedly" || GUEST_ACTIONS.includes(r.action);
  const set = (patch: Partial<Rule>) => setR((x) => ({ ...x, ...patch }));
  const save = () =>
    run(async () => {
      const { id, last_fired: _f, last_status: _s, ...body } = r;
      await api(id ? `/automation/rules/${id}` : "/automation/rules", { method: id ? "PUT" : "POST", json: { ...body, name: body.name.trim() } });
      onSaved();
    });
  const toggle = <V,>(list: V[], v: V) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <GlassModal
      open
      onClose={onClose}
      title={rule.id ? t("auto.editRule") : t("auto.newRule")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" onClick={save} disabled={busy || !r.name.trim() || (needsGuest && !r.target)}>
            {t("common.save")}
          </GlassButton>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={t("auto.ruleName")}>
          <GlassInput className="w-full" maxLength={80} value={r.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label={t("auto.when")}>
            <GlassSelect className="w-full" value={r.trigger} onChange={(e) => {
              const trigger = e.target.value as Trigger;
              set({ trigger, threshold: UNIT[trigger]?.def ?? null });
            }}>
              {TRIGGERS.map((x) => (
                <option key={x} value={x}>{t(`auto.trigger.${x}`)}</option>
              ))}
            </GlassSelect>
          </Field>
          {u && (
            <Field label={`${t("auto.threshold")} (${u.unit})`}>
              <GlassInput className="w-full" type="number" min={u.min} max={u.max} value={r.threshold ?? ""} onChange={(e) => set({ threshold: e.target.value === "" ? null : Number(e.target.value) })} />
            </Field>
          )}
        </div>
        {r.trigger === "scheduled_time" && (
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <Field label={t("auto.time")}>
              <GlassInput className="w-full" type="time" value={r.time ?? ""} onChange={(e) => set({ time: e.target.value })} />
            </Field>
            <Field label={t("auto.days")}>
              <div className="flex flex-wrap gap-1">
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <button key={d} type="button" aria-pressed={r.days.includes(d)} onClick={() => set({ days: toggle(r.days, d).sort() })}
                    className={`rounded-md px-2 py-1 text-[11px] ${r.days.includes(d) ? "bg-sky-400/25 text-white ring-1 ring-sky-300/50" : "bg-white/5 text-slate-300 hover:bg-white/10"}`}>
                    {t(`auto.day.${d}` as TKey)}
                  </button>
                ))}
              </div>
            </Field>
          </div>
        )}
        <Field label={t("auto.then")}>
          <GlassSelect className="w-full" value={r.action} onChange={(e) => set({ action: e.target.value as Action })}>
            {ACTIONS.map((x) => (
              <option key={x} value={x}>{t(`auto.action.${x}`)}</option>
            ))}
          </GlassSelect>
        </Field>
        {needsGuest && (
          <Field label={t("auto.guest")}>
            <GlassSelect className="w-full" value={r.target ? `${r.target.type}:${r.target.vmid}` : ""} onChange={(e) => {
              const [type, vmid] = e.target.value.split(":");
              set({ target: e.target.value ? { type: type as GuestRef["type"], vmid: Number(vmid) } : null });
            }}>
              <option value="">{t("auto.chooseGuest")}</option>
              {guests.map((g) => (
                <option key={`${g.type}:${g.vmid}`} value={`${g.type}:${g.vmid}`}>{`${g.vmid} · ${g.name} (${g.type === "qemu" ? "VM" : "LXC"})`}</option>
              ))}
            </GlassSelect>
          </Field>
        )}
        {r.action === "send_external_alert" && (
          <Field label={t("auto.channels")}>
            <div className="flex flex-wrap gap-3">
              {CHANNELS.map((c) => (
                <GlassSwitch key={c} checked={r.channels.includes(c)} onChange={() => set({ channels: toggle(r.channels, c) })} label={CH_NAME[c]} />
              ))}
            </div>
          </Field>
        )}
        {r.action === "prune_old_snapshots" && (
          <Field label={t("auto.pruneDays")}>
            <GlassInput className="w-full" type="number" min={0} max={3650} value={r.prune_older_than_days} onChange={(e) => set({ prune_older_than_days: Number(e.target.value) })} />
          </Field>
        )}
        {r.trigger !== "scheduled_time" && (
          <Field label={t("auto.cooldown")} hint={t("auto.cooldownHint")}>
            <GlassInput className="w-full" type="number" min={0} max={10080} value={r.cooldown_minutes} onChange={(e) => set({ cooldown_minutes: Number(e.target.value) })} />
          </Field>
        )}
        <p className="rounded-lg bg-white/5 px-3 py-2 text-[11px] text-sky-200">{ruleSummary(r, t, (g) => guestLabel(g, guests))}</p>
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

const guestLabel = (g: GuestRef | null, guests: Guest[]) => {
  if (!g) return "…";
  const x = guests.find((y) => y.type === g.type && y.vmid === g.vmid);
  return x ? `${x.name} (${g.vmid})` : `${g.type === "qemu" ? "VM" : "CT"} ${g.vmid}`;
};
const STATUS_TONE = { ok: "success", partial: "warning", error: "danger" } as const;

function RulesTab({ t, language }: { t: T; language: string }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [edit, setEdit] = useState<Rule | null>(null);
  const [del, setDel] = useState<Rule | null>(null);
  const { error, run } = useRunner();
  const load = useCallback(() => {
    api<Rule[]>("/automation/rules").then(setRules, () => setRules([]));
    api<LogEntry[]>("/automation/logs").then(setLogs, () => {});
  }, []);
  usePoll(load, 15000);
  useEffect(() => {
    api<Guest[]>("/v1/guests").then(setGuests, () => {});
  }, []);
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
  const toggle = (r: Rule, enabled: boolean) =>
    run(async () => {
      const { id, last_fired: _f, last_status: _s, ...body } = r;
      await api(`/automation/rules/${id}`, { method: "PUT", json: { ...body, enabled } });
      load();
    });
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <GlassButton variant="primary" onClick={() => setEdit({ ...EMPTY })}>
          <Plus size={13} /> {t("auto.newRule")}
        </GlassButton>
      </div>
      <Notice error={error} />
      {!rules ? (
        <p className="text-xs text-slate-400">{t("common.loading")}</p>
      ) : rules.length === 0 ? (
        <p className="glass-soft rounded-2xl p-6 text-center text-xs text-slate-400">{t("auto.noRules")}</p>
      ) : (
        <ul className="space-y-2">
          {rules.map((r) => (
            <li key={r.id} className={`glass-soft flex items-center gap-3 rounded-xl px-4 py-3 ${r.enabled ? "" : "opacity-60"}`}>
              <Bell size={16} className="shrink-0 text-sky-300" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-100">{r.name}</div>
                <div className="truncate text-[11px] text-slate-300">{ruleSummary(r, t, (g) => guestLabel(g, guests))}</div>
                <div className="text-[10px] text-slate-500">
                  {t("auto.lastFired", { when: r.last_fired ? fmt(r.last_fired) : t("common.never") })}
                  {r.last_status && <GlassBadge className="ml-2" tone={STATUS_TONE[r.last_status as keyof typeof STATUS_TONE] ?? "neutral"}>{r.last_status.toUpperCase()}</GlassBadge>}
                </div>
              </div>
              <GlassSwitch checked={r.enabled} onChange={(v) => toggle(r, v)} />
              <GlassButton variant="ghost" size="xs" onClick={() => setEdit(r)} aria-label={t("common.edit")} title={t("common.edit")}>
                <Pencil size={13} />
              </GlassButton>
              <GlassButton variant="ghost" size="xs" onClick={() => setDel(r)} aria-label={t("auto.deleteRule")} title={t("auto.deleteRule")}>
                <Trash2 size={13} className="text-rose-300" />
              </GlassButton>
            </li>
          ))}
        </ul>
      )}

      <section className="glass-soft rounded-2xl p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-100">{t("auto.logs")}</h3>
        {logs.length === 0 ? (
          <p className="text-xs text-slate-400">{t("auto.noLogs")}</p>
        ) : (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-slate-900/80 text-slate-400">
                <tr>
                  {(["time", "rule", "trigger", "result", "status"] as const).map((c) => (
                    <th key={c} className="px-2 py-1.5 font-medium">{t(`auto.col.${c}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-white/5 align-top text-slate-200">
                    <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{fmt(l.timestamp)}</td>
                    <td className="px-2 py-1.5">{l.rule_name}</td>
                    <td className="px-2 py-1.5 text-slate-300">{l.trigger_summary}</td>
                    <td className="px-2 py-1.5 break-words text-slate-300">{l.action_result}</td>
                    <td className="px-2 py-1.5"><GlassBadge tone={STATUS_TONE[l.status] ?? "neutral"}>{l.status.toUpperCase()}</GlassBadge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {edit && <RuleEditor rule={edit} guests={guests} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), load())} t={t} />}
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        title={t("auto.deleteRule")}
        message={t("auto.deleteConfirm", { name: del?.name ?? "" })}
        confirmLabel={t("common.delete")}
        onConfirm={() => run(async () => (await api(`/automation/rules/${del!.id}`, { method: "DELETE" }), setDel(null), load()))}
      />
    </div>
  );
}

/** Control Panel → Automation & Alerts. */
export default function AutomationPanel() {
  const { t, language } = useTranslation();
  const [tab, setTab] = useState<"channels" | "rules">("rules");
  return (
    <div className="space-y-4">
      <Segmented value={tab} onChange={setTab} options={[{ id: "rules", label: t("auto.tab.rules") }, { id: "channels", label: t("auto.tab.channels") }]} />
      {tab === "channels" ? <ChannelsTab t={t} /> : <RulesTab t={t} language={language} />}
    </div>
  );
}
