import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, Loader2, Server, ShieldCheck } from "lucide-react";
import { useAuth } from "../lib/stores";
import { useClock } from "../lib/hooks";
import { edition } from "@edition";
import { useTranslation } from "../i18n";
import LanguagePill from "./LanguagePill";
import ProductLogo from "./ProductLogo";

export default function LockScreen({ visible, checking }: { visible: boolean; checking: boolean }) {
  const { t, language } = useTranslation();
  const now = useClock();
  const login = useAuth((s) => s.login);
  const login2fa = useAuth((s) => s.login2fa);
  const lockedUser = useAuth((s) => s.username);
  const [node, setNode] = useState<string>("");
  const [username, setUsername] = useState(lockedUser ?? "admin");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  // Set after the password checked out on an account with 2FA: the second step uses this challenge token.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // First-run setup: no administrator yet (null = not known yet).
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    fetch("/api/auth/setup")
      .then((r) => r.json())
      .then((d) => {
        setSetupNeeded(!!d.required);
        if (d.required) setUsername("");
      })
      .catch(() => setSetupNeeded(false));
  }, []);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setNode(d.node))
      .catch(() => setNode("offline"));
  }, []);

  useEffect(() => {
    if (visible) (setPassword(""), setOtp(""), setChallenge(null), setUseRecovery(false));
    if (lockedUser) setUsername(lockedUser);
  }, [visible, lockedUser]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (challenge) await login2fa(challenge, otp);
      else setChallenge(await login(username, password));
    } catch (err) {
      const msg = (err as Error).message;
      if (challenge && /expired/i.test(msg)) (setChallenge(null), setPassword(""));
      setError(msg);
      setOtp("");
    } finally {
      setBusy(false);
    }
  };

  const createAdmin = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(t("setup.mismatch"));
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, username, password }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail || r.statusText);
      setSetupNeeded(false);
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`absolute inset-0 z-[10000] flex flex-col items-center justify-center gap-10 px-4 transition-all duration-700 ${
        visible ? "opacity-100" : "pointer-events-none -translate-y-8 opacity-0"
      }`}
      aria-hidden={!visible}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-md" />
      <LanguagePill className="glass-soft absolute top-4 right-4 px-3 py-1" />
      <div className="relative text-center select-none">
        <div className="text-7xl font-extralight tracking-tight text-white tabular-nums sm:text-8xl">
          {now.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="mt-2 text-lg text-slate-300">
          {now.toLocaleDateString(language, { weekday: "long", month: "long", day: "numeric" })}
        </div>
        <div className="glass-soft mx-auto mt-4 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs text-slate-300">
          <Server size={12} /> {node || "…"}
        </div>
      </div>

      {setupNeeded && !checking ? (
        <form onSubmit={createAdmin} className="glass relative w-full max-w-sm space-y-3 rounded-2xl p-6 shadow-2xl">
          <div className="mb-2 flex flex-col items-center gap-2 text-center">
            <ProductLogo className="h-14 max-w-full" />
            <div className="text-sm font-medium text-white">{t("setup.title")}</div>
            <p className="text-xs text-slate-400">{t("setup.intro")}</p>
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs text-slate-400" htmlFor="setup-code">
              <KeyRound size={12} /> {t("setup.code")}
            </label>
            <input id="setup-code" className="input w-full font-mono tracking-widest uppercase" placeholder="XXXX-XXXX" maxLength={12}
              value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoFocus required />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400" htmlFor="setup-user">{t("setup.username")}</label>
            <input id="setup-user" className="input w-full" value={username} pattern="[a-z_][a-z0-9_-]{0,31}" placeholder="e.g. alex"
              onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" required />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400" htmlFor="setup-pw">{t("setup.password")}</label>
            <input id="setup-pw" type="password" className="input w-full" minLength={10} maxLength={128}
              value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-400" htmlFor="setup-pw2">{t("setup.confirm")}</label>
            <input id="setup-pw2" type="password" className="input w-full" minLength={10} maxLength={128}
              value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </div>
          <p className="text-[11px] text-slate-500">{t("setup.linux")}</p>
          {error && (
            <p role="alert" className="text-sm text-rose-400">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || !code || !username || password.length < 10 || !confirm}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 py-2 text-sm font-medium text-white transition hover:bg-sky-400 disabled:opacity-40">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} {t("setup.create")}
          </button>
        </form>
      ) : (
      <form onSubmit={submit} className="glass relative w-full max-w-sm rounded-2xl p-6 shadow-2xl">
        {checking || setupNeeded === null ? (
          <div className="flex justify-center py-6 text-slate-400">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <>
            <div className="mb-5 flex flex-col items-center gap-2 text-center">
              <ProductLogo className="h-14 max-w-full" />
              <div className="text-xs text-slate-400">{t("login.subtitle")}</div>
            </div>
            {challenge ? (
              <div key="otp">
                <label className="mb-1 flex items-center gap-1.5 text-xs text-slate-400" htmlFor="otp">
                  <ShieldCheck size={12} /> {useRecovery ? t("login.recoveryCode") : t("login.twoFactor")}
                </label>
                <div className="flex gap-2">
                  <input
                    id="otp"
                    className={`input w-full font-mono ${useRecovery ? "tracking-widest uppercase" : "tracking-[0.4em]"}`}
                    inputMode={useRecovery ? "text" : "numeric"}
                    autoComplete="one-time-code"
                    maxLength={useRecovery ? 11 : 6}
                    placeholder={useRecovery ? "XXXXX-XXXXX" : "000000"}
                    value={otp}
                    onChange={(e) => setOtp(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={busy || (useRecovery ? otp.replace(/[^a-z0-9]/gi, "").length !== 10 : otp.length !== 6)}
                    className="flex w-11 shrink-0 items-center justify-center rounded-lg bg-sky-500 text-white transition hover:bg-sky-400 disabled:opacity-40"
                    aria-label={t("login.verify")}
                  >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-slate-400">{useRecovery ? t("login.recoveryHint") : t("login.twoFactorHint")}</p>
                <div className="mt-2 flex justify-between text-[11px]">
                  <button type="button" className="text-sky-300 hover:underline" onClick={() => (setUseRecovery(!useRecovery), setOtp(""), setError(""))}>
                    {useRecovery ? t("login.useAuthenticator") : t("login.useRecovery")}
                  </button>
                  <button type="button" className="text-slate-400 hover:underline" onClick={() => (setChallenge(null), setOtp(""), setPassword(""), setError(""))}>
                    {t("login.back")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="mb-1 block text-xs text-slate-400" htmlFor="u">
                  {t("login.username")}
                </label>
                <input id="u" className="input mb-3 w-full" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
                <label className="mb-1 block text-xs text-slate-400" htmlFor="p">
                  {t("login.password")}
                </label>
                <div className="flex gap-2">
                  <input
                    id="p"
                    type="password"
                    className="input w-full"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={busy || !password}
                    className="flex w-11 shrink-0 items-center justify-center rounded-lg bg-sky-500 text-white transition hover:bg-sky-400 disabled:opacity-40"
                    aria-label={t("login.signIn")}
                  >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  </button>
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-rose-400">
                {error}
              </p>
            )}
          </>
        )}
      </form>
      )}
      {edition.trademarkNotice && (
        <p className="absolute inset-x-0 bottom-3 mx-auto max-w-2xl px-4 text-center text-[10px] leading-snug text-slate-400/70 select-none">
          {edition.trademarkNotice}
        </p>
      )}
    </div>
  );
}
