import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ChevronLeft, Cpu, CloudDownload, KeyRound, Network, Palette, Power, RefreshCw, RotateCcw, ShieldCheck, Smartphone, SquareTerminal } from "lucide-react";
import { api } from "../lib/api";
import type { SystemInfo, UpdateStatus } from "../lib/types";
import { uptime } from "../lib/format";
import { usePoll, useRunner } from "../lib/hooks";
import { useIntent, usePrefs, useWindows, WALLPAPERS } from "../lib/stores";
import HardwarePanel from "./HardwarePanel";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassSwitch, Notice } from "../components/ui/GlassKit";

type Section = "security" | "network" | "appearance" | "hardware" | "power";

const SECTIONS: { id: Section; title: string; desc: string; icon: ReactNode; tint: string }[] = [
  { id: "security", title: "User & Security", desc: "Admin password, API token status", icon: <ShieldCheck size={22} />, tint: "from-indigo-400 to-violet-600" },
  { id: "network", title: "Network & DNS", desc: "Host interfaces, bridges, resolvers", icon: <Network size={22} />, tint: "from-sky-400 to-cyan-600" },
  { id: "appearance", title: "Appearance & Dock", desc: "Wallpaper, widgets, Dock size and magnification", icon: <Palette size={22} />, tint: "from-pink-400 to-rose-600" },
  { id: "hardware", title: "Hardware & System", desc: "CPU, memory, GPUs, drives, NICs, GPU drivers", icon: <Cpu size={22} />, tint: "from-emerald-400 to-teal-600" },
  { id: "power", title: "System & Power", desc: "Proxmox VE version, reboot, shut down", icon: <Power size={22} />, tint: "from-amber-300 to-orange-600" },
];

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
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
      <Card title="Proxmox API connection" action={<GlassBadge tone={info.api.connected ? "success" : "danger"}>{info.api.connected ? "CONNECTED" : "UNREACHABLE"}</GlassBadge>}>
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
  host_key_pinned: boolean;
}

function BridgeCard() {
  const [b, setB] = useState<Bridge | null>(null);
  const open = useWindows((s) => s.open);
  useEffect(() => {
    api<Bridge>("/host/bridge").then(setB, (e) => setB({ target: "", public_key: "", connected: false, error: e.message, host_key_pinned: false }));
  }, []);
  return (
    <Card
      title="Host root shell (SSH key bridge)"
      action={b && <GlassBadge tone={b.connected ? "success" : "danger"}>{b.connected ? "CONNECTED" : "UNAVAILABLE"}</GlassBadge>}
    >
      <p className="mb-3 text-xs text-slate-400">
        ProxmoxOS reaches <span className="font-mono">{b?.target || "the Proxmox host"}</span> as root with its own ed25519 key, so Host Shell, container shells, GPU drivers and network
        services work without a second login. Anyone signed in to ProxmoxOS has full root on the host; keep 2FA on.
      </p>
      {b && (
        <Rows
          rows={[
            ["Host", b.hostname ?? "—"],
            ["Host key", b.host_key_pinned ? "Pinned (known_hosts)" : "Not pinned; re-run install.sh"],
            ["Public key", <span className="font-mono text-[10px] break-all whitespace-normal select-all">{b.public_key}</span>],
          ]}
        />
      )}
      {b?.error && (
        <div className="mt-3">
          <Notice error={b.error} />
        </div>
      )}
      <div className="mt-3">
        <GlassButton variant="primary" onClick={() => open("terminal")} disabled={!b?.connected}>
          <SquareTerminal size={13} /> Open Host Shell
        </GlassButton>
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

function UpdateCard() {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [ask, setAsk] = useState(false);
  const [started, setStarted] = useState(false);
  const { busy, error, notice, run, setError } = useRunner();
  const load = useCallback((check = false) => api<UpdateStatus>(`/system/update/status${check ? "?check=true" : ""}`).then((s) => (setSt(s), s)), []);
  // While an update runs, poll; the backend restarts near the end, so failed polls are expected and ignored.
  const poll = useCallback(() => {
    if (started) load().catch(() => {});
  }, [started, load]);
  usePoll(poll, 3000);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load, setError]);
  useEffect(() => {
    if (started && st && !st.running && st.exit_code !== null) setStarted(false);
  }, [started, st]);

  const check = () =>
    run(async () => {
      const s = await load(true);
      if (s.check_error) throw new Error(`Update check failed: ${s.check_error}`);
      if (s.update_available) setAsk(true);
    });
  const apply = () => run(() => api("/system/update/apply", { method: "POST" }).then(() => (setAsk(false), setStarted(true))));
  const short = (c?: string | null) => (c ? c.slice(0, 10) : "unknown");
  const done = st && !st.running && st.exit_code !== null && st.log.length > 0;

  return (
    <Card title="System Update" action={st?.update_available && !st.running && <GlassBadge tone="info">UPDATE AVAILABLE</GlassBadge>}>
      <Rows
        rows={[
          ["ProxmoxOS version", st?.version ? `v${st.version}` : "—"],
          ["Commit", <span className="font-mono">{short(st?.commit)}</span>],
          ["Branch", <span className="font-mono">{st?.branch}</span>],
          ["Source", <span className="font-mono">{st?.remote}</span>],
          ...(st?.remote_commit ? ([["Latest on remote", <span className="font-mono">{short(st.remote_commit)}</span>]] as [string, ReactNode][]) : []),
        ]}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <GlassButton variant="primary" disabled={busy || !!st?.running || started} onClick={check}>
          <CloudDownload size={13} /> {st?.running || started ? "Updating…" : "Check & Install Updates"}
        </GlassButton>
        {st && !st.update_available && st.remote_commit && !st.running && <span className="text-xs text-emerald-300">ProxmoxOS is up to date.</span>}
        {done && st.exit_code === 0 && (
          <GlassButton onClick={() => window.location.reload()}>
            <RefreshCw size={13} /> Reload ProxmoxOS
          </GlassButton>
        )}
      </div>
      {(st?.running || started || done) && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">{st?.log.join("\n") || "Starting…"}</pre>
      )}
      {done && st.exit_code !== 0 && <Notice error={`Update failed (exit code ${st.exit_code}); see the log above.`} />}
      <p className="mt-2 text-[11px] text-slate-500">Pulls the latest code, syncs backend dependencies, rebuilds the frontend and restarts the services. Your settings and data are kept. Host helper changes still need install.sh on the Proxmox host.</p>
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
        confirmLabel="Install now"
        message={`Update ProxmoxOS from ${short(st?.commit)} to ${short(st?.remote_commit)}? The desktop is briefly unavailable while services restart.`}
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
  const { wallpaper, widgets, set } = usePrefs();
  return (
    <div className="space-y-4">
      <Card title="Wallpaper">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {WALLPAPERS.map((w) => (
            <button
              key={w.id}
              onClick={() => set({ wallpaper: w.id })}
              aria-pressed={wallpaper === w.id}
              className={`group overflow-hidden rounded-xl text-left ring-2 transition active:scale-[0.97] ${wallpaper === w.id ? "ring-sky-400" : "ring-transparent hover:ring-white/20"}`}
            >
              <span className="relative block h-16" style={{ background: w.swatch }}>
                <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/35 to-transparent" />
              </span>
              <span className="block bg-black/30 px-2 py-1.5 text-[11px] text-slate-200">{w.name}</span>
            </button>
          ))}
        </div>
      </Card>
      <Card title="Desktop">
        <GlassSwitch checked={widgets} onChange={(v) => set({ widgets: v })} label="Show desktop widgets (system health, GPU, ZFS, compute)" />
        <p className="mt-2 text-[11px] text-slate-500">Appearance settings are stored in this browser.</p>
      </Card>
    </div>
  );
}

function PowerSection({ info }: { info: SystemInfo }) {
  const [ask, setAsk] = useState<"reboot" | "shutdown" | null>(null);
  const { busy, error, notice, run } = useRunner();
  const send = async () => {
    const verb = ask === "reboot" ? "Reboot" : "Shutdown";
    if (await run(() => api("/system/power", { method: "POST", json: { command: ask } }), `${verb} command sent to ${info.node}.`)) setAsk(null);
  };
  return (
    <div className="space-y-4">
      <Card title="Proxmox VE">
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
      <UpdateCard />
      <Card title="Power">
        <p className="mb-3 text-xs text-slate-400">All VMs and containers on the host stop, and ProxmoxOS goes offline until the host is back.</p>
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
        title={ask === "reboot" ? "Reboot Proxmox host" : "Shut down Proxmox host"}
        confirmLabel={ask === "reboot" ? "Reboot now" : "Shut down now"}
        expect={info.node}
        message={
          ask === "shutdown"
            ? "The server powers off and stays off until someone powers it on again."
            : "The server restarts. ProxmoxOS will be unavailable for a few minutes."
        }
      />
    </div>
  );
}

export default function ControlPanelApp() {
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
            <ChevronLeft size={14} /> All settings
          </GlassButton>
        ) : (
          <h2 className="text-sm font-semibold text-white">Control Panel</h2>
        )}
        {current && <span className="text-sm font-medium text-slate-200">{current.title}</span>}
        <GlassButton variant="ghost" size="xs" className="ml-auto" onClick={load} aria-label="Refresh">
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
                  <span className="block text-sm font-semibold text-slate-100">{s.title}</span>
                  <span className="block text-[11px] text-slate-400">{s.desc}</span>
                </span>
              </button>
            ))}
          </div>
        ) : section === "appearance" ? (
          <Appearance />
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
