import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Bug, ChevronLeft, Cpu, BellRing, PencilRuler, CloudDownload, KeyRound, Network, Palette, Power, RefreshCw, RotateCcw, ShieldCheck, Smartphone, SquareTerminal } from "lucide-react";
import { api } from "../lib/api";
import type { SystemInfo, UpdateSettings, UpdateStatus, VersionEntry } from "../lib/types";
import { copyText, uptime } from "../lib/format";
import { usePoll, useRunner } from "../lib/hooks";
import { TRADEMARK_NOTICE } from "../lib/brand";
import { MAGNIFICATION, useBugReport, useDock, useIntent, usePrefs, useWindows, type Magnification } from "../lib/stores";
import ThemeStudio from "./ThemeStudio";
import { APPS, APP_IDS } from "./registry";
import { AppIcon } from "../components/icons/AppIcons";
import HardwarePanel from "./HardwarePanel";
import { LayoutControls } from "../components/ViewOptions";
import AutomationPanel from "./AutomationPanel";
import LanguagePill from "../components/LanguagePill";
import { LANGS, isLang, useTranslation, type TKey } from "../i18n";
import { useWidgets } from "../store/widgetStore";
import { driverBadgeKey, useCapabilities } from "../store/capabilitiesStore";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";

type Section = "security" | "network" | "appearance" | "automation" | "hardware" | "power";

const SECTIONS: { id: Section; title: TKey; desc: TKey; icon: ReactNode; tint: string }[] = [
  { id: "security", title: "cp.security", desc: "cp.securityDesc", icon: <ShieldCheck size={22} />, tint: "from-indigo-400 to-violet-600" },
  { id: "network", title: "cp.network", desc: "cp.networkDesc", icon: <Network size={22} />, tint: "from-sky-400 to-cyan-600" },
  { id: "appearance", title: "cp.appearance", desc: "cp.appearanceDesc", icon: <Palette size={22} />, tint: "from-pink-400 to-rose-600" },
  { id: "automation", title: "cp.automation", desc: "cp.automationDesc", icon: <BellRing size={22} />, tint: "from-fuchsia-400 to-purple-600" },
  { id: "hardware", title: "cp.hardware", desc: "cp.hardwareDesc", icon: <Cpu size={22} />, tint: "from-emerald-400 to-teal-600" },
  { id: "power", title: "cp.power", desc: "cp.powerDesc", icon: <Power size={22} />, tint: "from-amber-300 to-orange-600" },
];

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
      <Card title={`Change password for "${info.admin_username}"`}>
        <form onSubmit={submit} className="grid max-w-md gap-3">
          <Field label="Current password">
            <GlassInput type="password" className="w-full" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="At least 8 characters. Quotes, backslashes and line breaks are not allowed.">
            <GlassInput type="password" className="w-full" value={f.next} minLength={8} pattern={"[^'\\\\]+"} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" required />
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
      <TwoFactorCard />
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
        SolarDeck reaches <span className="font-mono">{b?.target || "the Proxmox host"}</span> as root with its own ed25519 key, so Host Shell, container shells, GPU drivers and network
        services work without a second login. Anyone signed in to SolarDeck has full root on the host; keep 2FA on.
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
            <KeyRound size={13} /> {copied ? "Copied: paste it into the Proxmox host shell" : "Copy SSH Setup Command"}
          </GlassButton>
        )}
      </div>
    </Card>
  );
}

function TwoFactorCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr_svg: string } | null>(null);
  const [code, setCode] = useState("");
  const { busy, error, notice, run } = useRunner();
  useEffect(() => {
    api<{ enabled: boolean }>("/auth/2fa/status").then((r) => setEnabled(r.enabled), () => setEnabled(false));
  }, []);
  const begin = () => run(() => api<{ secret: string; qr_svg: string }>("/auth/2fa/setup", { method: "POST" }).then(setSetup));
  const confirm = (path: "enable" | "disable") =>
    run(
      () => api<{ enabled: boolean }>(`/auth/2fa/${path}`, { method: "POST", json: { code } }).then((r) => (setEnabled(r.enabled), setSetup(null), setCode(""))),
      path === "enable" ? "Two-factor authentication is on. You will be asked for a code at sign-in." : "Two-factor authentication is off.",
    );
  return (
    <Card
      title="Two-Factor Authentication (2FA)"
      action={enabled !== null && <GlassBadge tone={enabled ? "success" : "neutral"}>{enabled ? "ENABLED" : "DISABLED"}</GlassBadge>}
    >
      <p className="mb-3 text-xs text-slate-400">Require a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, …) when signing in.</p>
      {enabled ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Current code to disable">
            <GlassInput className="w-32 font-mono tracking-widest" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <GlassButton variant="danger" disabled={busy || code.length !== 6} onClick={() => confirm("disable")}>
            Disable 2FA
          </GlassButton>
        </div>
      ) : setup ? (
        <div className="flex flex-wrap gap-4">
          <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} alt="2FA QR code" className="h-40 w-40 rounded-xl bg-white p-2" />
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-xs text-slate-300">1. Scan the QR code, or enter this secret manually:</p>
            <code className="block rounded-lg bg-black/30 px-3 py-2 font-mono text-xs break-all text-sky-200 select-all">{setup.secret}</code>
            <p className="text-xs text-slate-300">2. Enter the 6-digit code shown by the app:</p>
            <div className="flex gap-2">
              <GlassInput className="w-32 font-mono tracking-widest" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <GlassButton variant="primary" disabled={busy || code.length !== 6} onClick={() => confirm("enable")}>
                Verify & enable
              </GlassButton>
              <GlassButton variant="ghost" onClick={() => (setSetup(null), setCode(""))}>
                Cancel
              </GlassButton>
            </div>
          </div>
        </div>
      ) : (
        <GlassButton variant="primary" disabled={busy || enabled === null} onClick={begin}>
          <Smartphone size={13} /> Set up 2FA
        </GlassButton>
      )}
      <div className="mt-3">
        <Notice error={error} notice={notice} />
      </div>
    </Card>
  );
}

const MODES: { id: UpdateSettings["mode"]; label: string }[] = [
  { id: "manual", label: "Manual Only" },
  { id: "notify", label: "Notify Me When Available" },
  { id: "auto", label: "Automatic Updates" },
];
const FREQUENCIES: { id: UpdateSettings["schedule_frequency"]; label: string }[] = [
  { id: "6h", label: "Every 6 Hours" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const short = (c?: string | null) => (c ? c.slice(0, 10) : "unknown");
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never");
type Start = (path: "apply" | "rollback", targetRef?: string) => Promise<unknown>;

/** Control Panel → System & Updates: version check, update preferences and version history share one job state. */
function UpdatesSection() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback((check = false) => api<UpdateStatus>(`/system/updates/status${check ? "?check=true" : ""}`).then((s) => (setSt(s), s)), []);
  // While an update runs, poll; the backend restarts near the end, so failed polls are expected and ignored.
  const poll = useCallback(() => {
    if (started) load().catch(() => {});
  }, [started, load]);
  usePoll(poll, 3000);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (started && st && !st.running && st.exit_code !== null) setStarted(false);
  }, [started, st]);
  const start: Start = (path, targetRef) =>
    api(`/system/updates/${path}`, { method: "POST", json: targetRef ? { target_ref: targetRef } : {} }).then(() => setStarted(true));
  const running = !!st?.running || started;

  return (
    <>
      <Notice error={error} />
      <UpdateCard st={st} running={running} load={load} start={start} />
      {st && <UpdatePreferences initial={st.settings} onSaved={() => load()} />}
      <VersionHistory st={st} running={running} start={start} />
    </>
  );
}

function UpdateCard({ st, running, load, start }: { st: UpdateStatus | null; running: boolean; load: (check?: boolean) => Promise<UpdateStatus>; start: Start }) {
  const [ask, setAsk] = useState(false);
  const { busy, error, notice, run } = useRunner();
  const check = () => run(() => load(true));
  const apply = () => run(() => start("apply").then(() => setAsk(false)));
  const done = st && !st.running && st.exit_code !== null && st.log.length > 0;
  const latest = st?.remote_tag && st.remote_tag !== st.tag ? st.remote_tag : short(st?.remote_commit);

  return (
    <Card title="SolarDeck Version" action={st?.update_available && !running && <GlassBadge tone="info">UPDATE AVAILABLE</GlassBadge>}>
      <Rows
        rows={[
          ["Version", st ? `${st.version ? `v${st.version}` : "—"}${st.tag ? ` (${st.tag})` : ""}` : "—"],
          ["Commit", <span className="font-mono">{short(st?.commit)}</span>],
          ["Branch", <span className="font-mono">{st?.branch}</span>],
          ["Source", <span className="font-mono">{st?.remote}</span>],
          ["Last checked", when(st?.settings.last_checked_at)],
          ...(st?.update_available ? ([["Latest version", <span className="font-mono">{latest}</span>]] as [string, ReactNode][]) : []),
        ]}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <GlassButton variant={st?.update_available ? "secondary" : "primary"} disabled={busy || running} onClick={check}>
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Check for Updates
        </GlassButton>
        {st?.update_available && (
          <GlassButton variant="primary" disabled={busy || running} onClick={() => setAsk(true)}>
            <CloudDownload size={13} /> {running ? "Updating…" : "Install Update Now"}
          </GlassButton>
        )}
        {st && !st.update_available && st.remote_commit && !st.settings.last_check_error && !running && <span className="text-xs text-emerald-300">SolarDeck is up to date.</span>}
        {done && st.exit_code === 0 && (
          <GlassButton onClick={() => window.location.reload()}>
            <RefreshCw size={13} /> Reload SolarDeck
          </GlassButton>
        )}
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
      {(running || done) && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">{st?.log.join("\n") || "Starting…"}</pre>
      )}
      {done && st.exit_code !== 0 && <Notice error={`Update failed (exit code ${st.exit_code}); see the log above. Your previous settings are saved in /tmp/proxmox-os-state-backup.`} />}
      <p className="mt-2 text-[11px] text-slate-500">
        Updates pull the new code, sync dependencies, rebuild the desktop and restart the services. Settings, users, 2FA, schedules, shares and ZFS pools are kept. Host helper changes still need install.sh on the Proxmox host.
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
        message={`Update SolarDeck from ${st?.tag ?? short(st?.commit)} to ${latest}? Your settings and data are kept. The desktop is briefly unavailable while services restart.`}
      />
    </Card>
  );
}

function UpdatePreferences({ initial, onSaved }: { initial: UpdateSettings; onSaved: () => void }) {
  const [f, setF] = useState(initial);
  const { busy, error, notice, run } = useRunner(onSaved);
  const save = () =>
    run(
      () => api("/system/updates/settings", { method: "PUT", json: { mode: f.mode, schedule_frequency: f.schedule_frequency, schedule_time: f.schedule_time, schedule_day: f.schedule_day } }),
      "Update preferences saved.",
    );
  return (
    <Card title="Automatic Update Preferences">
      <div className="grid gap-3">
        <Field label="When a new version is released">
          <Segmented value={f.mode} onChange={(mode) => setF({ ...f, mode })} options={MODES} />
        </Field>
        {f.mode !== "manual" && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Check for updates">
              <Segmented value={f.schedule_frequency} onChange={(schedule_frequency) => setF({ ...f, schedule_frequency })} options={FREQUENCIES} />
            </Field>
            {f.schedule_frequency === "weekly" && (
              <Field label="Day">
                <GlassSelect value={f.schedule_day} onChange={(e) => setF({ ...f, schedule_day: Number(e.target.value) })}>
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
            )}
            {f.schedule_frequency !== "6h" && (
              <Field label="Time">
                <GlassInput type="time" required value={f.schedule_time} onChange={(e) => setF({ ...f, schedule_time: e.target.value })} />
              </Field>
            )}
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          {f.mode === "manual"
            ? "SolarDeck never checks on its own. Use Check for Updates above."
            : f.mode === "notify"
              ? "SolarDeck checks on this schedule and shows a notification in the top bar when an update is ready."
              : "SolarDeck checks on this schedule and installs updates by itself. Settings and data are always kept."}
        </p>
        <div className="flex items-center gap-2">
          <GlassButton variant="primary" disabled={busy} onClick={save}>
            Save Preferences
          </GlassButton>
        </div>
        <Notice error={error} notice={notice} />
      </div>
    </Card>
  );
}

function VersionHistory({ st, running, start }: { st: UpdateStatus | null; running: boolean; start: Start }) {
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
        title={pick && versions && older(versions.indexOf(pick)) ? "Downgrade SolarDeck" : "Switch SolarDeck version"}
        confirmLabel="Switch Version"
        message={
          <>
            Switch SolarDeck to <b>{pick?.tag ?? pick?.short_hash}</b> ({pick?.subject})?
            <br />
            <br />
            Only the SolarDeck program files change. All settings, users, passwords, 2FA, ZFS pools and datasets, schedules and network shares remain untouched, and you can switch back from
            this list at any time. {st?.settings.mode === "auto" && "Automatic updates are switched to Notify so they do not undo the downgrade."}
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
        <p className="mt-3 text-[11px] text-slate-500">Read-only view. Network changes are made in the Proxmox web UI so a typo cannot cut off access to the host.</p>
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

/** Hypervisor driver badge: "Proxmox VE" or "Standalone Hypervisor". */
function DriverBadge() {
  const { t } = useTranslation();
  const driver = useCapabilities((s) => s.capabilities.driver);
  return <GlassBadge tone={driver === "proxmox" ? "info" : "success"}>{t(driverBadgeKey(driver))}</GlassBadge>;
}

function AboutCard() {
  const { t } = useTranslation();
  const caps = useCapabilities((s) => s.capabilities);
  return (
    <Card title={t("about.title")} action={<DriverBadge />}>
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
  const platform = useCapabilities((s) => s.capabilities.platform_label);
  const openBugReport = useBugReport((s) => s.set);
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
            ["Version", info.version.version ? `${info.version.version}${info.version.repoid ? ` (${info.version.repoid})` : ""}` : info.pveversion],
            ["Manager", info.pveversion],
            ["Kernel", info.kernel],
            ["CPU", info.cpus ? `${info.cpu_model} · ${info.cpus} threads` : info.cpu_model],
            ["Boot mode", info.boot_mode.toUpperCase()],
            ["Uptime", uptime(info.uptime)],
            ["Storage root", <span className="font-mono">{info.storage_root}</span>],
          ]}
        />
      </Card>
      <UpdatesSection />
      <Card title="Report a Bug">
        <p className="mb-3 text-xs text-slate-400">Something not working? Send a report to the SolarDeck developers on GitHub, with anonymized diagnostics if you like.</p>
        <GlassButton onClick={() => openBugReport(true)}>
          <Bug size={13} /> Report a Bug
        </GlassButton>
      </Card>
      <Card title="Power">
        <p className="mb-3 text-xs text-slate-400">All VMs and containers on the host stop, and SolarDeck goes offline until the host is back.</p>
        <div className="flex flex-wrap gap-2">
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
            : "The server restarts. SolarDeck will be unavailable for a few minutes."
        }
      />
      <AboutCard />
      <p className="px-1 text-[11px] leading-snug text-slate-500">{TRADEMARK_NOTICE}</p>
    </div>
  );
}

export default function ControlPanelApp() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<SystemInfo>("/system/info").then((i) => (setInfo(i), setError("")), (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const current = SECTIONS.find((s) => s.id === section);
  const intent = useIntent((s) => s.controlpanel);
  const takeIntent = useIntent((s) => s.take);
  useEffect(() => {
    if (intent) (setSection(intent), takeIntent("controlpanel"));
  }, [intent, takeIntent]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        {current ? (
          <GlassButton variant="ghost" size="xs" onClick={() => setSection(null)}>
            <ChevronLeft size={14} /> {t("cp.all")}
          </GlassButton>
        ) : (
          <h2 className="text-sm font-semibold text-white">{t("cp.title")}</h2>
        )}
        {current && <span className="text-sm font-medium text-slate-200">{t(current.title)}</span>}
        <LanguagePill className="ml-auto" />
        <GlassButton variant="ghost" size="xs" onClick={load} aria-label={t("common.refresh")}>
          <RefreshCw size={13} />
        </GlassButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Notice error={error} />
        {!current ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className="glass-soft flex items-center gap-3 rounded-2xl p-4 text-left transition hover:bg-white/[0.08] active:scale-[0.98]"
              >
                <span className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg shadow-black/30 ${s.tint}`}>{s.icon}</span>
                <span>
                  <span className="block text-sm font-semibold text-slate-100">{t(s.title)}</span>
                  <span className="block text-[11px] text-slate-400">{t(s.desc)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : section === "appearance" ? (
          <Appearance />
        ) : section === "automation" ? (
          <AutomationPanel />
        ) : section === "hardware" ? (
          <HardwarePanel />
        ) : !info ? (
          !error && <p className="text-sm text-slate-400">Loading…</p>
        ) : section === "security" ? (
          <Security info={info} />
        ) : section === "network" ? (
          <NetworkSection info={info} />
        ) : (
          <PowerSection info={info} />
        )}
      </div>
    </div>
  );
}
