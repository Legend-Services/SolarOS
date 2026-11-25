import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Bug, CalendarClock, CheckCircle2, Copy, Disc3, PencilRuler, CloudDownload, KeyRound, Power, RefreshCw, RotateCcw, SquareTerminal } from "lucide-react";
import { api } from "../lib/api";
import type { HypervisorIsoStatus, SystemInfo, UpdateSchedule, UpdateScheduleState, UpdateStatus, VersionEntry } from "../lib/types";
import { bytes, copyText, uptime } from "../lib/format";
import { useClock, usePoll, useRunner } from "../lib/hooks";
import { edition } from "@edition";
import { MAGNIFICATION, useBugReport, useDock, usePrefs, useWindows, type Magnification } from "../lib/stores";
import ThemeStudio from "./ThemeStudio";
import { APPS, APP_IDS } from "./registry";
import { AppIcon } from "../components/icons/AppIcons";
import { LayoutControls } from "../components/ViewOptions";
import { LANGS, isLang, useTranslation, type TKey } from "../i18n";
import { useUpdateStore } from "../store/updateStore";
import { useWidgets } from "../store/widgetStore";
import { productOf, useCapabilities, useProduct } from "../store/capabilitiesStore";
import { SessionsCard, TwoFactorCard } from "./security/SecurityCenter";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";

export function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="glass-soft rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-6 gap-y-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-400">{k}</dt>
          <dd className="min-w-0 truncate text-slate-100">{v || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Security({ info }: { info: SystemInfo }) {
  const platform = useCapabilities((s) => s.capabilities.platform_label);
  const [f, setF] = useState({ current: "", next: "", confirm: "" });
  const { busy, error, notice, run, setError } = useRunner();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.confirm) return setError("The new passwords do not match");
    run(
      () => api("/system/password", { method: "POST", json: { current_password: f.current, new_password: f.next } }).then(() => setF({ current: "", next: "", confirm: "" })),
      "Password changed. Use it the next time you sign in.",
    );
  };
  return (
    <div className="space-y-4">
      <div id="sec-password">
      <Card title={`Change password for "${info.admin_username}"`}>
        <form onSubmit={submit} className="grid max-w-md gap-3">
          <Field label="Current password">
            <GlassInput type="password" className="w-full" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="10 to 128 characters with letters and a digit or symbol. Quotes, backslashes and line breaks are not allowed. Other signed-in devices are signed out.">
            <GlassInput type="password" className="w-full" value={f.next} minLength={10} pattern={"[^'\\\\]+"} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" required />
          </Field>
          <Field label="Confirm new password">
            <GlassInput type="password" className="w-full" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" required />
          </Field>
          <Notice error={error} notice={notice} />
          <div>
            <GlassButton type="submit" variant="primary" disabled={busy}>
              <KeyRound size={13} /> Change password
            </GlassButton>
          </div>
        </form>
      </Card>
      </div>
      <TwoFactorCard />
      <SessionsCard />
      <BridgeCard />
      <Card title={`${platform} API connection`} action={<GlassBadge tone={info.api.connected ? "success" : "danger"}>{info.api.connected ? "CONNECTED" : "UNREACHABLE"}</GlassBadge>}>
        <Rows
          rows={[
            ["API endpoint", <span className="font-mono">{info.api.host}</span>],
            ["Token", <span className="font-mono">{info.api.token_id}</span>],
            ["TLS verification", info.api.verify_ssl ? "Enabled" : "Disabled (self-signed certificate)"],
            ["Host helper", <span className="font-mono">{info.helper}</span>],
          ]}
        />
      </Card>
    </div>
  );
}

interface Bridge {
  target: string;
  public_key: string;
  connected: boolean;
  error: string | null;
  hostname?: string;
  setup_command: string | null;
}

function BridgeCard() {
  const product = useProduct().short;
  const [b, setB] = useState<Bridge | null>(null);
  const [copied, setCopied] = useState(false);
  const open = useWindows((s) => s.open);
  useEffect(() => {
    api<Bridge>("/host/bridge").then(setB, (e) => setB({ target: "", public_key: "", connected: false, error: e.message, setup_command: null }));
  }, []);
  return (
    <Card
      title="Host root shell (SSH key bridge)"
      action={b && <GlassBadge tone={b.connected ? "success" : "danger"}>{b.connected ? "CONNECTED" : "UNAVAILABLE"}</GlassBadge>}
    >
      <p className="mb-3 text-xs text-slate-400">
        {product} reaches <span className="font-mono">{b?.target || edition.host}</span> as root with its own ed25519 key, so Host Shell, container shells, GPU drivers and network
        services work without a second login. Anyone signed in to {product} has full root on the host; keep 2FA on.
      </p>
      {b && (
        <Rows
          rows={[
            ["Host", b.hostname ?? "—"],
            ["Public key", <span className="font-mono text-[10px] break-all whitespace-normal select-all">{b.public_key}</span>],
          ]}
        />
      )}
      {b?.error && (
        <div className="mt-3">
          <Notice error={b.error} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <GlassButton variant="primary" onClick={() => open("terminal")} disabled={!b?.connected}>
          <SquareTerminal size={13} /> Open Host Shell
        </GlassButton>
        {b && !b.connected && b.setup_command && (
          <GlassButton onClick={() => copyText(b.setup_command!).then(() => setCopied(true))}>
            <KeyRound size={13} /> {copied ? `Copied: paste it into ${edition.host} shell` : "Copy SSH Setup Command"}
          </GlassButton>
        )}
      </div>
    </Card>
  );
}

const short = (c?: string | null) => (c ? c.slice(0, 10) : "unknown");
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never");
type Start = (path: "apply" | "rollback", targetRef?: string, includeSystemPackages?: boolean) => Promise<unknown>;

/** Settings → Software & Repositories: version check, live update progress, schedule and version history share one state. */
function UpdatesSection() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState("");
  const share = useUpdateStore((s) => s.apply);
  const load = useCallback(
    (check = false) => api<UpdateStatus>(`/system/updates/status${check ? "?check=true" : ""}`).then((s) => (setSt(s), share(s), s)),
    [share],
  );
  const running = st?.update_status === "running" || !!st?.running;
  // The backend restarts at ~92%: a 502 or network error while polling is expected, so polling just carries on.
  const poll = useCallback(() => {
    if (running) load().catch(() => {});
  }, [running, load]);
  usePoll(poll, 1500);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  const start: Start = (path, targetRef, includeSystemPackages) =>
    api(`/system/updates/${path}`, {
      method: "POST",
      json: { ...(targetRef ? { target_ref: targetRef } : {}), ...(includeSystemPackages ? { include_system_packages: true } : {}) },
    }).then(() => load().catch(() => {}));

  return (
    <>
      <Notice error={error} />
      {st && st.update_status !== "idle" && <UpdateProgressCard st={st} onDismiss={() => api("/system/updates/acknowledge", { method: "POST" }).then(() => load())} />}
      <UpdateCard st={st} running={running} load={load} start={start} />
      <UpdateScheduleCard />
      <VersionHistory st={st} running={running} start={start} />
      <HypervisorIsoCard />
    </>
  );
}

const STAGES: Record<string, TKey> = {
  starting: "upd.stage.starting",
  prepare: "upd.stage.prepare",
  fetch: "upd.stage.fetch",
  checkout: "upd.stage.checkout",
  "os-packages": "upd.stage.os-packages",
  backend: "upd.stage.backend",
  frontend: "upd.stage.frontend",
  restart: "upd.stage.restart",
  done: "upd.stage.done",
};
const RELOAD_MS = 2000;
const mmss = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

/** Live update progress: stage, percentage, elapsed time and the runner's log; reloads the page once it reaches 100%. */
function UpdateProgressCard({ st, onDismiss }: { st: UpdateStatus; onDismiss: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const product = useProduct().short;
  const now = useClock();
  const logRef = useRef<HTMLPreElement>(null);
  const status = st.update_status;
  const pct = Math.min(100, Math.max(0, st.progress_percent));
  const stage = st.stage && STAGES[st.stage] ? t(STAGES[st.stage], { product }) : (st.current_stage ?? t("upd.stage.starting"));
  const elapsed = st.started_at ? mmss((st.finished_at ? Date.parse(st.finished_at) : now.getTime()) - Date.parse(st.started_at)) : null;
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [st.logs.length]);
  useEffect(() => {
    if (status !== "completed") return;
    // Acknowledge first, so the reloaded page starts idle instead of reloading again.
    const timer = setTimeout(() => window.location.reload(), RELOAD_MS);
    onDismiss().catch(() => {});
    return () => clearTimeout(timer);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const tone = status === "failed" ? "from-rose-500 to-rose-400" : status === "completed" ? "from-emerald-400 to-emerald-300" : "from-sky-400 to-emerald-400";
  return (
    <Card
      title={t("upd.progress.title")}
      action={<GlassBadge tone={status === "failed" ? "danger" : status === "completed" ? "success" : "info"}>{t(`upd.status.${status as "running" | "completed" | "failed"}`)}</GlassBadge>}
    >
      <div className="flex items-end justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-slate-200" aria-live="polite">
          {status === "completed" ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-300">
              <CheckCircle2 size={14} /> {t("upd.reloading")}
            </span>
          ) : status === "failed" ? (
            t("upd.failedAt", { stage })
          ) : (
            `${stage}…`
          )}
        </p>
        <span className="text-2xl font-bold tabular-nums text-white">{pct}%</span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={stage}>
        <div className={`h-full rounded-full bg-gradient-to-r ${tone} transition-[width] duration-700 ease-out ${status === "running" ? "animate-pulse" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 text-[11px] text-slate-400">
        {elapsed && <span>{t("upd.elapsed", { time: elapsed })}</span>}
        {status === "completed" && st.completed_version && <span>{t("upd.installedVersion", { version: st.completed_version })}</span>}
        {status === "running" && pct >= 92 && <span>{t("upd.restartHint")}</span>}
      </div>
      {status === "failed" && (
        <div className="mt-3 space-y-2">
          <Notice error={st.error_message ?? t("upd.failedGeneric")} />
          <p className="text-[11px] text-slate-400">{t("upd.failedHint")}</p>
          <GlassButton size="xs" onClick={() => void onDismiss()}>
            {t("upd.dismiss")}
          </GlassButton>
        </div>
      )}
      <pre ref={logRef} className="mt-3 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">
        {st.logs.join("\n") || t("upd.stage.starting")}
      </pre>
    </Card>
  );
}

/** Settings → Software & Repositories: how to build the bootable SolarOS installer ISO, and the ISOs already built. */
function HypervisorIsoCard() {
  const [st, setSt] = useState<HypervisorIsoStatus | null>(null);
  const [copied, setCopied] = useState("");
  const { busy, error, run } = useRunner();
  // The first load hashes new ISOs (several GB), so it can take a while; later loads are cached.
  const load = useCallback(() => run(() => api<HypervisorIsoStatus>("/system/updates/iso").then(setSt)), [run]);
  useEffect(() => {
    load();
  }, [load]);
  const copy = (text: string) => copyText(text).then(() => setCopied(text));
  const command = (text: string) => (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-200">{text}</code>
      <GlassButton size="xs" onClick={() => copy(text)} aria-label={`Copy ${text}`}>
        <Copy size={12} /> {copied === text ? "Copied" : "Copy"}
      </GlassButton>
    </div>
  );

  return (
    <Card title="SolarOS Installer ISO" action={<GlassButton size="xs" variant="ghost" disabled={busy} onClick={load} aria-label="Refresh ISO list"><RefreshCw size={12} className={busy ? "animate-spin" : ""} /></GlassButton>}>
      <p className="mb-2 text-[11px] text-slate-400">
        Build a bootable SolarOS installer (USB stick, bare metal or a nested test VM). Run on a Linux host with xorriso; add <span className="font-mono">--auto-disk /dev/sda</span> for an unattended VM test entry{edition.isoDeployNote}.
      </p>
      {st && command(st.build_command)}
      {st?.test_command && <div className="mt-2">{command(st.test_command)}</div>}
      <div className="mt-3">
        {st && st.isos.length === 0 && <p className="text-xs text-slate-400">No built ISO found in {st.search_paths.join(" or ")}.</p>}
        {busy && !st && <p className="text-xs text-slate-400">Looking for built ISOs…</p>}
        {st && st.isos.length > 0 && (
          <ul className="space-y-2">
            {st.isos.map((i) => (
              <li key={i.path} className="rounded-lg bg-black/20 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <Disc3 size={14} className="shrink-0 text-sky-300" />
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-100" title={i.path}>{i.name}</span>
                  <span className="text-slate-400">{bytes(i.size)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-6">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400 select-all">SHA-256 {i.sha256 ?? "unavailable"}</span>
                  {i.sha256 && (
                    <GlassButton size="xs" variant="ghost" onClick={() => copy(i.sha256!)} aria-label={`Copy SHA-256 of ${i.name}`}>
                      <Copy size={11} /> {copied === i.sha256 ? "Copied" : ""}
                    </GlassButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-2">
        <Notice error={error} />
      </div>
    </Card>
  );
}

function UpdateCard({ st, running, load, start }: { st: UpdateStatus | null; running: boolean; load: (check?: boolean) => Promise<UpdateStatus>; start: Start }) {
  const product = useProduct().short;
  const [ask, setAsk] = useState(false);
  const [sysPkgs, setSysPkgs] = useState(false);
  const { busy, error, notice, run } = useRunner();
  const check = () => run(() => load(true));
  const apply = () => run(() => start("apply", undefined, sysPkgs && st?.supports_system_packages).then(() => setAsk(false)));
  const latest = st?.latest_version ?? short(st?.remote_commit);

  return (
    <Card title={`${product} Version`} action={st?.update_available && !running && <GlassBadge tone="info">UPDATE AVAILABLE</GlassBadge>}>
      <Rows
        rows={[
          ["Edition", st ? <GlassBadge tone={st.driver === "native_ubuntu" ? "success" : "info"}>{st.edition}</GlassBadge> : "—"],
          ["Driver", <span className="font-mono">{st?.driver ?? "—"}</span>],
          ["Version", st ? `${st.version ? `v${st.version}` : "—"}${st.tag ? ` (${st.tag})` : ""}` : "—"],
          ["Commit", <span className="font-mono">{short(st?.commit)}</span>],
          ["Branch", <span className="font-mono">{st ? `origin/${st.branch}` : ""}</span>],
          ["Source", <span className="font-mono">{st?.remote}</span>],
          ["Last checked", when(st?.settings.last_checked_at)],
          ...(st?.update_available ? ([["Latest version", <span className="font-mono">{latest}</span>]] as [string, ReactNode][]) : []),
        ]}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <GlassButton variant={st?.update_available ? "secondary" : "primary"} disabled={busy || running} onClick={check}>
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Check for Updates
        </GlassButton>
        <GlassButton variant="primary" disabled={busy || running || !st?.update_available} onClick={() => setAsk(true)}>
          <CloudDownload size={13} /> Install Update Now
        </GlassButton>
        {st && !st.update_available && st.remote_commit && !st.settings.last_check_error && !running && <span className="text-xs text-emerald-300">{product} is up to date.</span>}
      </div>
      {st?.update_available && st.incoming.length > 0 && !running && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium text-slate-400">What's new ({st.incoming.length} change{st.incoming.length === 1 ? "" : "s"})</p>
          <ul className="max-h-36 space-y-1 overflow-auto rounded-lg bg-black/25 p-2 text-[11px] text-slate-300">
            {st.incoming.map((c) => (
              <li key={c.hash} className="flex gap-2">
                <span className="font-mono text-slate-500">{c.short_hash}</span>
                <span className="min-w-0 flex-1">{c.subject}</span>
                {c.tag && <GlassBadge tone="info">{c.tag}</GlassBadge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {st?.settings.last_check_error && !error && (
        <div className="mt-3">
          <Notice error={`Last update check failed: ${st.settings.last_check_error}`} />
        </div>
      )}
      <p className="mt-2 text-[11px] text-slate-500">
        {edition.updatesIntro}Updates pull the new code, sync dependencies, rebuild the desktop and restart the services. Settings, users, 2FA, schedules, shares and ZFS pools are kept.
        {st?.driver === "native_ubuntu" ? " The host helper and the console dashboard are updated as well." : edition.hostHelperNote}
      </p>
      <div className="mt-2">
        <Notice error={error} notice={notice} />
      </div>
      <ConfirmModal
        open={ask}
        onClose={() => setAsk(false)}
        onConfirm={apply}
        busy={busy}
        error={error}
        title="Install update"
        confirmLabel="Install Update Now"
        message={`Update ${product} from ${st?.tag ?? short(st?.commit)} to ${latest}? Your settings and data are kept. The desktop is briefly unavailable while services restart.`}
      >
        {st?.supports_system_packages && (
          <div className="mt-3">
            <GlassSwitch checked={sysPkgs} onChange={setSysPkgs} label="Also upgrade host system packages (apt-get upgrade)" />
          </div>
        )}
      </ConfirmModal>
    </Card>
  );
}

const INTERVALS = ["1", "6", "12", "24"] as const;
// 2026-11-22 is a Sunday: day i of that week is weekday i (0 = Sunday), named in the interface language.
const weekday = (lang: string, i: number) => new Date(2026, 10, 22 + i).toLocaleDateString(lang, { weekday: "long" });
const at = (lang: string, iso: string) => new Date(iso).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });

/** Manual updates, or scheduled automatic installs (daily / weekly / monthly at a set time); background checks either way. */
function UpdateScheduleCard() {
  const { t, language } = useTranslation();
  const [f, setF] = useState<UpdateScheduleState | null>(null);
  const { busy, error, notice, run } = useRunner();
  useEffect(() => {
    run(() => api<UpdateScheduleState>("/system/updates/schedule").then(setF));
  }, [run]);
  if (!f) return <Card title={t("upd.schedule.title")}><Notice error={error} /></Card>;
  const set = (p: Partial<UpdateSchedule>) => setF({ ...f, ...p });
  const save = () => {
    const body: UpdateSchedule = {
      auto_check_enabled: f.auto_check_enabled,
      check_interval_hours: f.check_interval_hours,
      auto_install_enabled: f.auto_install_enabled,
      schedule_frequency: f.schedule_frequency,
      schedule_day_of_week: f.schedule_day_of_week,
      schedule_day_of_month: f.schedule_day_of_month,
      schedule_time: f.schedule_time,
      include_os_packages: f.supports_os_packages && f.include_os_packages,
    };
    run(() => api<UpdateScheduleState>("/system/updates/schedule", { method: "PUT", json: body }).then(setF), t("upd.schedule.saved"));
  };

  return (
    <Card title={t("upd.schedule.title")} action={<CalendarClock size={14} className="text-slate-400" />}>
      <div className="grid gap-3">
        <Field label={t("upd.schedule.mode")}>
          <Segmented
            value={f.auto_install_enabled ? "auto" : "manual"}
            onChange={(v) => set({ auto_install_enabled: v === "auto" })}
            options={[
              { id: "manual", label: t("upd.schedule.manual") },
              { id: "auto", label: t("upd.schedule.auto") },
            ]}
          />
        </Field>
        {f.auto_install_enabled && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("upd.schedule.frequency")}>
              <Segmented
                value={f.schedule_frequency}
                onChange={(schedule_frequency) => set({ schedule_frequency })}
                options={[
                  { id: "daily", label: t("upd.schedule.daily") },
                  { id: "weekly", label: t("upd.schedule.weekly") },
                  { id: "monthly", label: t("upd.schedule.monthly") },
                ]}
              />
            </Field>
            {f.schedule_frequency === "weekly" && (
              <Field label={t("upd.schedule.day")}>
                <GlassSelect value={f.schedule_day_of_week} onChange={(e) => set({ schedule_day_of_week: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                    <option key={i} value={i}>
                      {weekday(language, i)}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
            )}
            {f.schedule_frequency === "monthly" && (
              <Field label={t("upd.schedule.dayOfMonth")}>
                <GlassSelect value={f.schedule_day_of_month} onChange={(e) => set({ schedule_day_of_month: Number(e.target.value) })}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
            )}
            <Field label={t("upd.schedule.time")}>
              <GlassInput type="time" required value={f.schedule_time} onChange={(e) => set({ schedule_time: e.target.value })} />
            </Field>
          </div>
        )}
        {f.auto_install_enabled && f.supports_os_packages && (
          <GlassSwitch checked={f.include_os_packages} onChange={(include_os_packages) => set({ include_os_packages })} label={t("upd.schedule.osPackages")} />
        )}
        <div className="flex flex-wrap items-end gap-3">
          <GlassSwitch checked={f.auto_check_enabled} onChange={(auto_check_enabled) => set({ auto_check_enabled })} label={t("upd.schedule.autoCheck")} />
          {f.auto_check_enabled && (
            <Segmented
              value={String(f.check_interval_hours) as (typeof INTERVALS)[number]}
              onChange={(v) => set({ check_interval_hours: Number(v) as UpdateSchedule["check_interval_hours"] })}
              options={INTERVALS.map((h) => ({ id: h, label: t("upd.schedule.everyHours", { hours: h }) }))}
            />
          )}
        </div>
        <p className="text-[11px] text-slate-500">{f.auto_install_enabled ? t("upd.schedule.autoHint") : t("upd.schedule.manualHint")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <GlassButton variant="primary" disabled={busy} onClick={save}>
            {t("upd.schedule.save")}
          </GlassButton>
          <span className="text-[11px] text-slate-400">
            {[
              f.next_check_at && t("upd.schedule.nextCheck", { time: at(language, f.next_check_at) }),
              f.next_install_at && t("upd.schedule.nextInstall", { time: at(language, f.next_install_at) }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <Notice error={error} notice={notice} />
      </div>
    </Card>
  );
}

function VersionHistory({ st, running, start }: { st: UpdateStatus | null; running: boolean; start: Start }) {
  const product = useProduct().short;
  const [versions, setVersions] = useState<VersionEntry[] | null>(null);
  const [pick, setPick] = useState<VersionEntry | null>(null);
  const { busy, error, notice, run, setError } = useRunner();
  const checked = st?.settings.last_checked_at;
  useEffect(() => {
    api<{ versions: VersionEntry[] }>("/system/updates/versions").then((r) => setVersions(r.versions), (e) => setError(e.message));
  }, [checked, setError]);
  const currentIdx = versions?.findIndex((v) => v.is_current) ?? -1;
  const older = (i: number) => currentIdx >= 0 && i > currentIdx;
  const go = () => {
    if (!pick || !versions) return;
    const i = versions.indexOf(pick);
    run(() => start(older(i) ? "rollback" : "apply", pick.hash).then(() => setPick(null)));
  };

  return (
    <Card title="Version History & Downgrade">
      {!versions ? (
        <p className="text-xs text-slate-400">{error ? "" : "Loading version history…"}</p>
      ) : !versions.length ? (
        <p className="text-xs text-slate-400">No version history yet. It appears after the first successful Check for Updates.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-white/5 overflow-auto rounded-lg bg-black/20">
          {versions.map((v, i) => (
            <li key={v.hash} className={`flex items-center gap-3 px-3 py-2 text-xs ${v.is_current ? "bg-sky-400/10" : ""}`}>
              <div className="w-16 shrink-0">{v.tag ? <GlassBadge tone="info">{v.tag}</GlassBadge> : <span className="font-mono text-slate-500">{v.short_hash}</span>}</div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-slate-100" title={v.subject}>
                  {v.subject}
                </p>
                <p className="text-[10px] text-slate-500">
                  {when(v.date)} · <span className="font-mono">{v.short_hash}</span>
                </p>
              </div>
              {v.is_current ? (
                <GlassBadge tone="success">CURRENT</GlassBadge>
              ) : (
                <GlassButton size="xs" variant={older(i) ? "secondary" : "ghost"} disabled={busy || running} onClick={() => setPick(v)}>
                  <RotateCcw size={12} /> {older(i) ? "Downgrade to This Version" : "Install This Version"}
                </GlassButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2">
        <Notice error={error} notice={notice} />
      </div>
      <ConfirmModal
        open={!!pick}
        onClose={() => setPick(null)}
        onConfirm={go}
        busy={busy}
        error={error}
        title={pick && versions && older(versions.indexOf(pick)) ? `Downgrade ${product}` : `Switch ${product} version`}
        confirmLabel="Switch Version"
        message={
          <>
            Switch {product} to <b>{pick?.tag ?? pick?.short_hash}</b> ({pick?.subject})?
            <br />
            <br />
            Only the {product} program files change. All settings, users, passwords, 2FA, ZFS pools and datasets, schedules and network shares remain untouched, and you can switch back from
            this list at any time. {st?.settings.auto_install_enabled && "Scheduled automatic installs are switched off so they do not undo the downgrade."}
          </>
        }
      />
    </Card>
  );
}

function NetworkSection({ info }: { info: SystemInfo }) {
  return (
    <div className="space-y-4">
      <Card title="Interfaces">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="py-1.5 font-medium">Name</th>
                <th className="px-2 font-medium">Type</th>
                <th className="px-2 font-medium">Status</th>
                <th className="px-2 font-medium">Address</th>
                <th className="px-2 font-medium">Gateway</th>
                <th className="px-2 font-medium">Ports / comment</th>
              </tr>
            </thead>
            <tbody>
              {info.network.map((n) => (
                <tr key={n.iface} className="border-t border-white/5">
                  <td className="py-2 font-mono text-slate-100">{n.iface}</td>
                  <td className="px-2 capitalize text-slate-300">{n.type}</td>
                  <td className="px-2">
                    <GlassBadge tone={n.active ? "success" : "neutral"}>{n.active ? "ACTIVE" : "DOWN"}</GlassBadge>
                  </td>
                  <td className="px-2 font-mono text-slate-300">{n.cidr || n.address || (n.method === "dhcp" ? "DHCP" : "—")}</td>
                  <td className="px-2 font-mono text-slate-300">{n.gateway || "—"}</td>
                  <td className="px-2 text-slate-400">{n.bridge_ports || n.comments || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">{edition.networkReadOnlyNote}</p>
      </Card>
      <Card title="DNS">
        <Rows
          rows={[
            ["Search domain", info.dns.search],
            ["DNS server 1", info.dns.dns1],
            ["DNS server 2", info.dns.dns2],
            ["DNS server 3", info.dns.dns3],
          ]}
        />
      </Card>
    </div>
  );
}

function Appearance() {
  const { widgets, set } = usePrefs();
  const { t, language, setLanguage } = useTranslation();
  const editWidgets = useWidgets((s) => s.setEditing);
  return (
    <div className="space-y-4">
      <ThemeStudio />
      <Card title={t("common.language")}>
        <Segmented value={language} onChange={(v) => isLang(v) && setLanguage(v)} options={LANGS.map((l) => ({ id: l.id, label: l.label }))} />
        <p className="mt-2 text-[11px] text-slate-500">{t("cp.languageHint")}</p>
      </Card>
      <Card title={t("cp.desktop")} action={<GlassButton size="xs" onClick={() => editWidgets(true)}><PencilRuler size={12} /> {t("view.customizeWidgets")}</GlassButton>}>
        <GlassSwitch checked={widgets} onChange={(v) => set({ widgets: v })} label={t("cp.showWidgets")} />
        <p className="mt-2 text-[11px] text-slate-500">{t("cp.widgetsHint")}</p>
      </Card>
      <Card title="Desktop Layout">
        <LayoutControls />
      </Card>
      <DockCard />
    </div>
  );
}

const MAG_LABELS: Record<Magnification, string> = { off: "Off", subtle: "Subtle", strong: "Strong", large: "Large" };

function DockCard() {
  const { pinned, autoHide, magnification, pin, unpin, set } = useDock();
  return (
    <Card title="Dock">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Magnification strength" hint="Dock icon size and spacing are under Desktop Layout above.">
          <Segmented value={magnification} onChange={(v) => set({ magnification: v })} options={(Object.keys(MAGNIFICATION) as Magnification[]).map((id) => ({ id, label: MAG_LABELS[id] }))} />
        </Field>
      </div>
      <div className="mt-4">
        <GlassSwitch checked={autoHide} onChange={(v) => set({ autoHide: v })} label="Automatically hide and show the Dock" />
      </div>
      <p className="mt-4 mb-2 text-[11px] text-slate-400">Apps in the Dock (drag icons in the Dock to reorder; right-click an icon to keep or remove it). Every app stays available in the App Gallery.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {APP_IDS.map((id) => (
          <label key={id} className="glass-soft flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-xs text-slate-200">
            <input type="checkbox" checked={pinned.includes(id)} onChange={(e) => (e.target.checked ? pin : unpin)(id)} />
            <AppIcon id={id} size={22} />
            <span className="truncate">{APPS[id].title}</span>
          </label>
        ))}
      </div>
    </Card>
  );
}

/** Hypervisor driver badge: the platform label the backend reports. */
function DriverBadge() {
  const { driver, platform_label } = useCapabilities((s) => s.capabilities);
  return <GlassBadge tone={driver === "native_ubuntu" ? "success" : "info"}>{platform_label}</GlassBadge>;
}

function AboutCard() {
  const { t } = useTranslation();
  const caps = useCapabilities((s) => s.capabilities);
  return (
    <Card title={t("about.title", { product: productOf(caps.driver).name })} action={<DriverBadge />}>
      <p className="mb-3 text-xs text-slate-400">{t("about.desc")}</p>
      <Rows
        rows={[
          [t("about.driver"), <span className="font-mono">{caps.driver}</span>],
          [t("about.platform"), caps.platform_label],
        ]}
      />
    </Card>
  );
}

function PowerSection({ info }: { info: SystemInfo }) {
  const product = useProduct().short;
  const platform = useCapabilities((s) => s.capabilities.platform_label);
  const open = useWindows((s) => s.open);
  const [ask, setAsk] = useState<"reboot" | "shutdown" | null>(null);
  const { busy, error, notice, run } = useRunner();
  const send = async () => {
    const verb = ask === "reboot" ? "Reboot" : "Shutdown";
    if (await run(() => api("/system/power", { method: "POST", json: { command: ask } }), `${verb} command sent to ${info.node}.`)) setAsk(null);
  };
  return (
    <div className="space-y-4">
      <Card title={platform} action={<DriverBadge />}>
        <Rows
          rows={[
            ["Node", info.node],
            ["Version", info.version.version ? `${info.version.version}${info.version.repoid ? ` (${info.version.repoid})` : ""}` : info.platform_version],
            ["Manager", info.platform_version],
            ["Kernel", info.kernel],
            ["CPU", info.cpus ? `${info.cpu_model} · ${info.cpus} threads` : info.cpu_model],
            ["Boot mode", info.boot_mode.toUpperCase()],
            ["Uptime", uptime(info.uptime)],
            ["Storage root", <span className="font-mono">{info.storage_root}</span>],
          ]}
        />
      </Card>
      <Card title="Power">
        <p className="mb-3 text-xs text-slate-400">All VMs and containers on the host stop, and {product} goes offline until the host is back.</p>
        <div className="flex flex-wrap gap-2">
          <GlassButton onClick={() => open("console", { type: "node", vmid: 0, name: info.node, mode: "shell" })}>
            <SquareTerminal size={13} /> Host console shell
          </GlassButton>
          <GlassButton onClick={() => setAsk("reboot")} disabled={!!notice}>
            <RotateCcw size={13} /> Reboot host
          </GlassButton>
          <GlassButton variant="danger" onClick={() => setAsk("shutdown")} disabled={!!notice}>
            <Power size={13} /> Shut down host
          </GlassButton>
        </div>
        <div className="mt-3">
          <Notice notice={notice} />
        </div>
      </Card>
      <ConfirmModal
        open={!!ask}
        onClose={() => setAsk(null)}
        onConfirm={send}
        busy={busy}
        error={error}
        title={ask === "reboot" ? `Reboot ${platform} host` : `Shut down ${platform} host`}
        confirmLabel={ask === "reboot" ? "Reboot now" : "Shut down now"}
        expect={info.node}
        message={
          ask === "shutdown"
            ? "The server powers off and stays off until someone powers it on again."
            : `The server restarts. ${product} will be unavailable for a few minutes.`
        }
      />
      <AboutCard />
      {edition.trademarkNotice && <p className="px-1 text-[11px] leading-snug text-slate-500">{edition.trademarkNotice}</p>}
    </div>
  );
}

/** Loads /system/info for the sections that need it (security, network, power). */
export function WithSystemInfo({ children }: { children: (info: SystemInfo) => ReactNode }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<SystemInfo>("/system/info").then(setInfo, (e) => setError(e.message));
  }, []);
  return info ? children(info) : error ? <Notice error={error} /> : <p className="text-sm text-slate-400">Loading…</p>;
}

export function BugReportCard() {
  const product = useProduct().short;
  const openBugReport = useBugReport((s) => s.set);
  return (
    <Card title="Report a Bug">
      <p className="mb-3 text-xs text-slate-400">Something not working? Send a report to the {product} developers on GitHub, with anonymized diagnostics if you like.</p>
      <GlassButton onClick={() => openBugReport(true)}>
        <Bug size={13} /> Report a Bug
      </GlassButton>
    </Card>
  );
}

export { Appearance, NetworkSection, PowerSection, Security, UpdatesSection };

