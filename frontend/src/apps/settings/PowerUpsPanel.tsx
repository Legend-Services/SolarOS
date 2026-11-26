import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, ScanSearch, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { usePoll, useRunner } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation } from "../../i18n";
import { Card } from "../ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassCheckbox, GlassInput, GlassSelect, Notice, Segmented } from "../../components/ui/GlassKit";

type Profile = "performance" | "balanced" | "eco";
type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
interface Entry {
  at: string;
  days: Day[];
  profile: Profile;
}
interface UpsStatus {
  enabled: boolean;
  online?: boolean;
  on_battery?: boolean;
  low_battery?: boolean;
  shutting_down?: boolean;
  charge_percent?: number | null;
  load_percent?: number | null;
  input_voltage?: number | null;
  runtime_seconds?: number | null;
  model?: string;
  manufacturer?: string;
}
interface UpsConfig {
  mode: "usb" | "netclient";
  driver: string;
  port: string;
  remote: string;
  username: string;
  password_set: boolean;
  shutdown_charge_percent: number;
  shutdown_runtime_seconds: number;
  guest_timeout_seconds: number;
  shutdown_order: number[];
  profile: Profile;
  eco_pause_vmids: number[];
  schedule: Entry[];
  available_governors: string[];
}

const DAYS: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PROFILES: Profile[] = ["performance", "balanced", "eco"];
const runtime = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const num = (v: string) => Number(v) || 0;

/** Settings > System > Power & UPS: live UPS status, NUT setup with guest shutdown order, and power profiles. */
export default function PowerUpsPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpsStatus | null>(null);
  const [cfg, setCfg] = useState<UpsConfig | null>(null);
  const [password, setPassword] = useState("");
  const [guests, setGuests] = useState<Guest[]>([]);
  const [pick, setPick] = useState("");
  const conf = useRunner();
  const prof = useRunner();

  const poll = useCallback(() => void api<UpsStatus>("/ups/status").then(setStatus, () => {}), []);
  usePoll(poll, 10_000);
  const load = useCallback(() => api<UpsConfig>("/ups/config").then(setCfg), []);
  useEffect(() => {
    void conf.run(load);
    api<Guest[]>("/v1/guests").then(setGuests, () => {});
  }, [conf.run, load]);

  const set = (p: Partial<UpsConfig>) => setCfg((c) => c && { ...c, ...p });
  const label = (id: number) => `${id} · ${guests.find((g) => g.vmid === id)?.name ?? "?"}`;
  const detect = () =>
    conf.run(async () => {
      const f = (await api<{ found: Record<string, string>[] }>("/ups/drivers")).found[0];
      if (!f) throw new Error(t("ups.noneFound"));
      set({ driver: f.driver, port: f.port || "auto" });
    }, t("ups.detected"));
  const save = () =>
    cfg &&
    conf.run(async () => {
      await api("/ups/config", { method: "PUT", json: { ...cfg, password: password || null } });
      setPassword("");
      await load();
      poll();
    }, t("ups.saved"));
  const apply = () =>
    cfg && prof.run(() => api("/ups/profile", { method: "PUT", json: { profile: cfg.profile, eco_pause_vmids: cfg.eco_pause_vmids, schedule: cfg.schedule } }), t("ups.profileSaved"));

  const order = cfg?.shutdown_order ?? [];
  const move = (i: number, d: number) => {
    const o = [...order];
    [o[i], o[i + d]] = [o[i + d], o[i]];
    set({ shutdown_order: o });
  };
  const setEntry = (i: number, p: Partial<Entry>) => cfg && set({ schedule: cfg.schedule.map((e, j) => (j === i ? { ...e, ...p } : e)) });

  const s = status;
  const charge = s?.charge_percent ?? null;
  const [tone, state] = s?.shutting_down
    ? (["danger", "ups.state.shutdown"] as const)
    : s?.low_battery
      ? (["danger", "ups.state.low"] as const)
      : s?.on_battery
        ? (["warning", "ups.state.battery"] as const)
        : s?.online
          ? (["success", "ups.state.online"] as const)
          : (["neutral", "ups.state.offline"] as const);
  const stat = (k: Parameters<typeof t>[0], v: string | null) => (
    <div>
      <dt className="text-[11px] text-slate-400">{t(k)}</dt>
      <dd className="tabular-nums text-slate-100">{v ?? "—"}</dd>
    </div>
  );

  return (
    <div className="space-y-4">
      <div data-anchor="ups-status">
        <Card title={t("ups.status")} action={<GlassBadge tone={tone}>{t(state)}</GlassBadge>}>
          {!s?.online ? (
            <p className="text-xs text-slate-400">{t("ups.noData")}</p>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                  <span>{t("ups.charge")}</span>
                  <span className="tabular-nums text-slate-100">{charge === null ? "—" : `${charge} %`}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full ${s.low_battery ? "bg-rose-400" : s.on_battery ? "bg-amber-400" : "bg-emerald-400"}`}
                    style={{ width: `${charge ?? 0}%` }}
                  />
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                {stat("ups.load", s.load_percent == null ? null : `${s.load_percent} %`)}
                {stat("ups.voltage", s.input_voltage == null ? null : `${s.input_voltage} V`)}
                {stat("ups.runtime", s.runtime_seconds == null ? null : runtime(s.runtime_seconds))}
                {stat("ups.model", [s.manufacturer, s.model].filter(Boolean).join(" ") || null)}
              </dl>
            </div>
          )}
        </Card>
      </div>

      {cfg && (
        <div data-anchor="ups-config">
          <Card title={t("ups.config")}>
            <div className="space-y-3">
              <Segmented
                value={cfg.mode}
                onChange={(mode) => set({ mode })}
                options={[
                  { id: "usb", label: t("ups.mode.usb") },
                  { id: "netclient", label: t("ups.mode.net") },
                ]}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                {cfg.mode === "usb" ? (
                  <>
                    <Field label={t("ups.driver")}>
                      <GlassInput className="w-full font-mono" value={cfg.driver} onChange={(e) => set({ driver: e.target.value })} />
                    </Field>
                    <Field label={t("ups.port")}>
                      <div className="flex gap-2">
                        <GlassInput className="w-full font-mono" value={cfg.port} onChange={(e) => set({ port: e.target.value })} />
                        <GlassButton onClick={detect} disabled={conf.busy}>
                          <ScanSearch size={12} /> {t("ups.detect")}
                        </GlassButton>
                      </div>
                    </Field>
                  </>
                ) : (
                  <Field label={t("ups.remote")} hint={t("ups.remoteHint")} className="sm:col-span-2">
                    <GlassInput className="w-full font-mono" placeholder="ups@192.168.1.10" value={cfg.remote} onChange={(e) => set({ remote: e.target.value })} />
                  </Field>
                )}
                <Field label={t("ups.username")}>
                  <GlassInput className="w-full font-mono" value={cfg.username} onChange={(e) => set({ username: e.target.value })} />
                </Field>
                <Field label={t("ups.password")} hint={cfg.password_set ? t("ups.passwordKeep") : t("ups.passwordAuto")}>
                  <GlassInput type="password" className="w-full" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                </Field>
                <Field label={t("ups.atCharge")}>
                  <GlassInput type="number" min={5} max={90} className="w-full" value={cfg.shutdown_charge_percent} onChange={(e) => set({ shutdown_charge_percent: num(e.target.value) })} />
                </Field>
                <Field label={t("ups.atRuntime")} hint={t("ups.atRuntimeHint")}>
                  <GlassInput type="number" min={0} max={7200} className="w-full" value={cfg.shutdown_runtime_seconds} onChange={(e) => set({ shutdown_runtime_seconds: num(e.target.value) })} />
                </Field>
                <Field label={t("ups.guestTimeout")}>
                  <GlassInput type="number" min={10} max={900} className="w-full" value={cfg.guest_timeout_seconds} onChange={(e) => set({ guest_timeout_seconds: num(e.target.value) })} />
                </Field>
              </div>
              <div>
                <p className="mb-1 text-[11px] text-slate-400">{t("ups.order")}</p>
                <ol className="mb-2 space-y-1">
                  {order.map((id, i) => (
                    <li key={id} className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2 py-1 text-xs text-slate-200">
                      <span className="w-5 text-slate-500 tabular-nums">{i + 1}.</span>
                      <span className="flex-1 truncate">{label(id)}</span>
                      <GlassButton size="xs" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("common.moveUp")}>
                        <ArrowUp size={12} />
                      </GlassButton>
                      <GlassButton size="xs" variant="ghost" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={t("common.moveDown")}>
                        <ArrowDown size={12} />
                      </GlassButton>
                      <GlassButton size="xs" variant="ghost" onClick={() => set({ shutdown_order: order.filter((x) => x !== id) })} aria-label={t("common.delete")}>
                        <Trash2 size={12} />
                      </GlassButton>
                    </li>
                  ))}
                </ol>
                <div className="flex gap-2">
                  <GlassSelect value={pick} onChange={(e) => setPick(e.target.value)} className="min-w-0 flex-1">
                    <option value="">{t("ups.pickGuest")}</option>
                    {guests
                      .filter((g) => !order.includes(g.vmid))
                      .map((g) => (
                        <option key={g.vmid} value={g.vmid}>
                          {label(g.vmid)}
                        </option>
                      ))}
                  </GlassSelect>
                  <GlassButton disabled={!pick} onClick={() => (set({ shutdown_order: [...order, Number(pick)] }), setPick(""))}>
                    <Plus size={12} /> {t("common.add")}
                  </GlassButton>
                </div>
                <p className="mt-1 text-[10px] text-slate-500">{t("ups.orderHint")}</p>
              </div>
              <Notice error={conf.error} notice={conf.notice} />
              <div className="flex justify-end">
                <GlassButton variant="primary" onClick={save} disabled={conf.busy}>
                  {conf.busy ? t("common.loading") : t("common.save")}
                </GlassButton>
              </div>
            </div>
          </Card>
        </div>
      )}

      {cfg && (
        <div data-anchor="ups-profiles">
          <Card title={t("ups.profiles")}>
            <div className="space-y-3">
              <Segmented value={cfg.profile} onChange={(profile) => set({ profile })} options={PROFILES.map((id) => ({ id, label: t(`ups.p.${id}`) }))} />
              <p className="text-[11px] text-slate-500">{t("ups.governors", { list: cfg.available_governors.join(", ") || "—" })}</p>
              <div>
                <p className="mb-1 text-[11px] text-slate-400">{t("ups.ecoGuests")}</p>
                <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1.5 overflow-auto">
                  {guests.map((g) => (
                    <GlassCheckbox
                      key={g.vmid}
                      label={label(g.vmid)}
                      checked={cfg.eco_pause_vmids.includes(g.vmid)}
                      onChange={(on) => set({ eco_pause_vmids: on ? [...cfg.eco_pause_vmids, g.vmid] : cfg.eco_pause_vmids.filter((x) => x !== g.vmid) })}
                    />
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[11px] text-slate-400">{t("ups.schedule")}</p>
                <div className="space-y-1.5">
                  {cfg.schedule.map((e, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <GlassInput type="time" className="w-28" value={e.at} onChange={(ev) => setEntry(i, { at: ev.target.value })} aria-label={t("ups.time")} />
                      <div className="flex gap-0.5">
                        {DAYS.map((d) => (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={e.days.includes(d)}
                            onClick={() => setEntry(i, { days: e.days.includes(d) ? e.days.filter((x) => x !== d) : DAYS.filter((x) => x === d || e.days.includes(x)) })}
                            className={`rounded-md px-1.5 py-1 text-[10px] font-medium ${e.days.includes(d) ? "bg-sky-400/30 text-white" : "bg-white/[0.05] text-slate-400 hover:text-slate-200"}`}
                          >
                            {t(`ups.d.${d}`)}
                          </button>
                        ))}
                      </div>
                      <GlassSelect value={e.profile} onChange={(ev) => setEntry(i, { profile: ev.target.value as Profile })} aria-label={t("ups.profiles")}>
                        {PROFILES.map((p) => (
                          <option key={p} value={p}>
                            {t(`ups.p.${p}`)}
                          </option>
                        ))}
                      </GlassSelect>
                      <GlassButton size="xs" variant="ghost" onClick={() => set({ schedule: cfg.schedule.filter((_, j) => j !== i) })} aria-label={t("common.delete")}>
                        <Trash2 size={12} />
                      </GlassButton>
                    </div>
                  ))}
                </div>
                <GlassButton size="xs" className="mt-2" onClick={() => set({ schedule: [...cfg.schedule, { at: "22:00", days: [...DAYS], profile: "eco" }] })}>
                  <Plus size={12} /> {t("ups.addRule")}
                </GlassButton>
              </div>
              <Notice error={prof.error} notice={prof.notice} />
              <div className="flex justify-end">
                <GlassButton variant="primary" onClick={apply} disabled={prof.busy || cfg.schedule.some((e) => !e.days.length)}>
                  {t("ups.applyProfile")}
                </GlassButton>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
