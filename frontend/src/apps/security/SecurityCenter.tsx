import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, FileJson, FileSpreadsheet, Laptop, Link2, Loader2, LogOut, RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Wand2 } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { openLink } from "../../lib/stores";
import { JobLog } from "../../components/JobLog";
import { useTranslation } from "../../i18n";
import { Field, GlassBadge, GlassButton, GlassInput, GlassSelect, Notice } from "../../components/ui/GlassKit";
import { Card } from "../ControlPanelApp";

/* Settings → Privilege & Security → Security & 2FA: posture score, 2FA enrollment, signed-in sessions and the audit log. */

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const when = (v: string | number) => new Date(typeof v === "number" ? v * 1000 : v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/* ---------------- Security posture ---------------- */

interface PostureItem {
  id: string;
  title: string;
  weight: number;
  status: "pass" | "warn" | "unknown";
  detail: string;
  fix: string | null;
  link: string | null;
}
interface Posture {
  score: number;
  items: PostureItem[];
  host_reachable: boolean;
}

function Gauge({ score }: { score: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const color = score >= 80 ? "#34d399" : score >= 50 ? "#fbbf24" : "#fb7185";
  return (
    <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0" role="img" aria-label={`Security score ${score} of 100`}>
      <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="9" className="text-white/10" />
      <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`}
        transform="rotate(-90 50 50)" style={{ transition: "stroke-dasharray .8s cubic-bezier(.22,1,.36,1)" }} />
      <text x="50" y="49" textAnchor="middle" className="fill-white text-[26px] font-semibold">{score}</text>
      <text x="50" y="66" textAnchor="middle" className="fill-slate-400 text-[10px]">/ 100</text>
    </svg>
  );
}

function PostureCard() {
  const { t } = useTranslation();
  const [p, setP] = useState<Posture | null>(null);
  const [job, setJob] = useState(false);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<Posture>("/security/posture").then(setP), []);
  useEffect(() => {
    run(load);
  }, [load, run]);
  const fixable = p?.items.filter((i) => i.status === "warn" && i.fix).map((i) => i.fix!) ?? [];
  const harden = (parts: string[]) => run(() => api("/security/harden", { method: "POST", json: { parts } }).then(() => setJob(true)));
  const follow = (link: string) =>
    link === "password" || link === "twofa" ? openLink("settings", "security-2fa") : link === "certs" ? openLink("netservices", "certs") : openLink("datacenter");

  return (
    <Card
      title={t("sec.postureTitle")}
      action={
        <GlassButton variant="ghost" size="xs" onClick={() => run(load)} aria-label={t("common.refresh")}>
          <RefreshCw size={13} className={busy && !job ? "animate-spin" : ""} />
        </GlassButton>
      }
    >
      {!p ? (
        <p className="text-xs text-slate-400">{busy ? t("sec.checking") : ""}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-4">
            <Gauge score={p.score} />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-xs text-slate-300">{t("sec.postureIntro")}</p>
              {!p.host_reachable && <p className="text-[11px] text-amber-300">{t("sec.hostUnreachable")}</p>}
              <GlassButton variant="primary" disabled={busy || job || !fixable.length} onClick={() => harden(fixable)}>
                <Wand2 size={13} /> {t("sec.applyAll")}
              </GlassButton>
            </div>
          </div>
          <ul className="divide-y divide-white/5">
            {p.items.map((i) => (
              <li key={i.id} className="flex items-start gap-3 py-2">
                {i.status === "pass" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" /> : <ShieldAlert size={16} className={`mt-0.5 shrink-0 ${i.status === "warn" ? "text-amber-300" : "text-slate-500"}`} />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-100">
                    {i.title}
                    <GlassBadge tone={i.status === "pass" ? "success" : i.status === "warn" ? "warning" : "neutral"}>
                      {i.status === "pass" ? t("sec.pass") : i.status === "warn" ? t("sec.action") : t("sec.unknown")}
                    </GlassBadge>
                    <span className="text-[10px] text-slate-500">{i.weight} pts</span>
                  </div>
                  <p className="text-[11px] text-slate-400">{i.detail}</p>
                </div>
                {i.status === "warn" && i.fix && (
                  <GlassButton size="xs" disabled={busy || job} onClick={() => harden([i.fix!])}>
                    <Wand2 size={12} /> {t("sec.apply")}
                  </GlassButton>
                )}
                {i.status === "warn" && i.link && (
                  <GlassButton size="xs" variant="ghost" onClick={() => follow(i.link!)}>
                    <Link2 size={12} /> {t("sec.open")}
                  </GlassButton>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {job && <JobLog name="hardening" active={job} className="mt-3" onDone={(ok) => (setJob(false), run(load, ok ? t("sec.hardened") : undefined))} />}
      <div className="mt-2">
        <Notice error={error} notice={notice} />
      </div>
    </Card>
  );
}

/* ---------------- Two-factor authentication ---------------- */

interface Setup {
  secret: string;
  qr_svg: string;
  otpauth_uri: string;
  recovery_codes: string[];
}

function TwoFactorCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ enabled: boolean; recovery_codes_left: number } | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null); // shown once, right after enabling
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<{ enabled: boolean; recovery_codes_left: number }>("/auth/2fa/status").then(setStatus), []);
  useEffect(() => {
    load().catch(() => setStatus({ enabled: false, recovery_codes_left: 0 }));
  }, [load]);
  const begin = () => run(() => api<Setup>("/auth/2fa/setup", { method: "POST" }).then((s) => (setSetup(s), setCodes(null))));
  const enable = () =>
    run(
      () => api("/auth/2fa/verify-setup", { method: "POST", json: { code } }).then(() => (setCodes(setup!.recovery_codes), setSetup(null), setCode(""), load())),
      t("sec.2faOn"),
    );
  const disable = () =>
    run(() => api("/auth/2fa/disable", { method: "POST", json: { code, password } }).then(() => (setCode(""), setPassword(""), setCodes(null), load())), t("sec.2faOff"));
  const saveCodes = (list: string[]) =>
    download("solardeck-recovery-codes.txt", `SolarDeck two-factor recovery codes (each works once)\n\n${list.join("\n")}\n`, "text/plain");

  return (
    <div id="sec-2fa">
      <Card
        title={t("sec.2faTitle")}
        action={status && <GlassBadge tone={status.enabled ? "success" : "neutral"}>{status.enabled ? t("sec.enabled") : t("sec.disabled")}</GlassBadge>}
      >
        <p className="mb-3 text-xs text-slate-400">{t("sec.2faIntro")}</p>
        {codes && (
          <div className="mb-3 rounded-xl bg-amber-400/10 p-3 ring-1 ring-amber-300/30">
            <p className="mb-2 text-xs font-medium text-amber-100">{t("sec.codesSave")}</p>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs text-slate-100 select-all sm:grid-cols-4">
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <GlassButton size="xs" className="mt-2" onClick={() => saveCodes(codes)}>
              <Download size={12} /> {t("sec.codesDownload")}
            </GlassButton>
          </div>
        )}
        {status?.enabled ? (
          <>
            <p className="mb-2 text-[11px] text-slate-400">{t("sec.codesLeft").replace("{n}", String(status.recovery_codes_left))}</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t("login.password")}>
                <GlassInput type="password" className="w-44" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
              <Field label={t("sec.codeOrRecovery")}>
                <GlassInput className="w-36 font-mono tracking-widest" maxLength={11} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
              </Field>
              <GlassButton variant="danger" disabled={busy || !password || code.length < 6} onClick={disable}>
                {t("sec.disable2fa")}
              </GlassButton>
            </div>
          </>
        ) : setup ? (
          <div className="flex flex-wrap gap-4">
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} alt={t("sec.qrAlt")} className="h-40 w-40 rounded-xl bg-white p-2" />
            <div className="min-w-0 flex-1 space-y-3">
              <p className="text-xs text-slate-300">{t("sec.step1")}</p>
              <code className="block rounded-lg bg-black/30 px-3 py-2 font-mono text-xs break-all text-sky-200 select-all">{setup.secret}</code>
              <p className="text-xs text-slate-300">{t("sec.step2")}</p>
              <div className="flex flex-wrap gap-2">
                <GlassInput className="w-32 font-mono tracking-widest" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                <GlassButton variant="primary" disabled={busy || code.length !== 6} onClick={enable}>
                  {t("sec.verifyEnable")}
                </GlassButton>
                <GlassButton variant="ghost" onClick={() => (setSetup(null), setCode(""))}>
                  {t("common.cancel")}
                </GlassButton>
              </div>
            </div>
          </div>
        ) : (
          <GlassButton variant="primary" disabled={busy || status === null} onClick={begin}>
            <Smartphone size={13} /> {t("sec.setup2fa")}
          </GlassButton>
        )}
        <div className="mt-3">
          <Notice error={error} notice={notice} />
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Sessions ---------------- */

interface Session {
  id: string;
  user: string;
  ip: string;
  device: string;
  issued: number;
  last_seen: number;
  current: boolean;
}

function SessionsCard() {
  const { t } = useTranslation();
  const [list, setList] = useState<Session[]>([]);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<Session[]>("/auth/sessions").then(setList), []);
  useEffect(() => {
    run(load);
  }, [load, run]);
  const revoke = (id: string) => run(() => api(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).then(load));
  const revokeAll = () =>
    run(() => api<{ revoked: number }>("/auth/sessions/revoke-all", { method: "POST" }).then((r) => (load(), r)), t("sec.othersSignedOut"));
  return (
    <Card
      title={t("sec.sessionsTitle")}
      action={
        <GlassButton size="xs" variant="danger" disabled={busy || list.length < 2} onClick={revokeAll}>
          <LogOut size={12} /> {t("sec.revokeOthers")}
        </GlassButton>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] tracking-wide text-slate-400 uppercase">
            <tr>
              <th className="py-1 pr-3 font-medium">{t("sec.device")}</th>
              <th className="py-1 pr-3 font-medium">{t("sec.address")}</th>
              <th className="py-1 pr-3 font-medium">{t("sec.signedIn")}</th>
              <th className="py-1 pr-3 font-medium">{t("sec.lastSeen")}</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-slate-200">
            {list.map((s) => (
              <tr key={s.id}>
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-1.5">
                    <Laptop size={12} className="text-slate-400" /> {s.device}
                    {s.current && <GlassBadge tone="success">{t("sec.thisDevice")}</GlassBadge>}
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono">{s.ip}</td>
                <td className="py-1.5 pr-3">{when(s.issued)}</td>
                <td className="py-1.5 pr-3">{when(s.last_seen)}</td>
                <td className="py-1.5 text-right">
                  {!s.current && (
                    <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => revoke(s.id)}>
                      {t("sec.revoke")}
                    </GlassButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2">
        <Notice error={error} notice={notice} />
      </div>
    </Card>
  );
}

/* ---------------- Audit log ---------------- */

interface AuditEntry {
  ts: string;
  event: string;
  user: string | null;
  ip: string | null;
  ok: boolean;
  details: Record<string, unknown>;
  entry_hash: string;
}
const CATEGORIES = ["", "login", "2fa", "session", "stepup", "host", "guest", "zfs", "disk", "firewall", "update", "gpu", "password"];
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function AuditLogCard() {
  const { t } = useTranslation();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [chain, setChain] = useState<{ ok: boolean; entries: number; first_bad_line: number | null; reason: string | null } | null>(null);
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const { busy, error, run } = useRunner();
  const load = useCallback(() => api<AuditEntry[]>("/security/audit-log?limit=1000").then(setItems), []);
  const verify = useCallback(() => api<typeof chain>("/security/audit-log/verify").then(setChain), []);
  useEffect(() => {
    run(() => Promise.all([load(), verify()]));
  }, [load, verify, run]);
  const shown = useMemo(
    () => items.filter((e) => (!cat || e.event.startsWith(cat)) && (!q || `${e.user} ${e.ip} ${e.event} ${JSON.stringify(e.details)}`.toLowerCase().includes(q.toLowerCase()))),
    [items, cat, q],
  );
  const exportCsv = () =>
    download(
      "solardeck-audit-log.csv",
      ["time,event,user,ip,result,details,entry_hash", ...shown.map((e) => [e.ts, e.event, e.user, e.ip, e.ok ? "ok" : "failed", JSON.stringify(e.details), e.entry_hash].map(csvCell).join(","))].join("\n"),
      "text/csv",
    );

  return (
    <Card
      title={t("sec.auditTitle")}
      action={
        chain && (
          <GlassBadge tone={chain.ok ? "success" : "danger"}>
            {chain.ok ? t("sec.chainOk").replace("{n}", String(chain.entries)) : t("sec.chainBroken").replace("{n}", String(chain.first_bad_line))}
          </GlassBadge>
        )
      }
    >
      {chain && !chain.ok && <p className="mb-2 text-[11px] text-rose-300">{chain.reason}</p>}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <GlassSelect value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("sec.filter")}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c || t("sec.allEvents")}
            </option>
          ))}
        </GlassSelect>
        <GlassInput className="w-44" placeholder={t("sec.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <GlassButton size="xs" disabled={busy} onClick={() => run(() => Promise.all([load(), verify()]))}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} {t("sec.verifyChain")}
        </GlassButton>
        <span className="flex-1" />
        <GlassButton size="xs" variant="ghost" onClick={() => download("solardeck-audit-log.json", JSON.stringify(shown, null, 2), "application/json")}>
          <FileJson size={12} /> JSON
        </GlassButton>
        <GlassButton size="xs" variant="ghost" onClick={exportCsv}>
          <FileSpreadsheet size={12} /> CSV
        </GlassButton>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-900/80 text-[10px] tracking-wide text-slate-400 uppercase backdrop-blur">
            <tr>
              <th className="py-1 pr-3 font-medium">{t("sec.time")}</th>
              <th className="py-1 pr-3 font-medium">{t("sec.event")}</th>
              <th className="py-1 pr-3 font-medium">{t("sec.user")}</th>
              <th className="py-1 pr-3 font-medium">{t("sec.address")}</th>
              <th className="py-1 font-medium">{t("sec.result")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-slate-200">
            {shown.map((e) => (
              <tr key={e.entry_hash} title={JSON.stringify(e.details)}>
                <td className="py-1 pr-3 whitespace-nowrap">{when(e.ts)}</td>
                <td className="py-1 pr-3 font-mono">{e.event}</td>
                <td className="py-1 pr-3">{e.user ?? "—"}</td>
                <td className="py-1 pr-3 font-mono">{e.ip ?? "—"}</td>
                <td className="py-1">
                  <GlassBadge tone={e.ok ? "success" : "danger"}>{e.ok ? "OK" : t("sec.failed")}</GlassBadge>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={5} className="py-3 text-center text-slate-500">
                  {t("sec.noEvents")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Notice error={error} />
    </Card>
  );
}

export { AuditLogCard, PostureCard, SessionsCard, TwoFactorCard };
