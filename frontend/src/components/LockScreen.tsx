import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Loader2, Server, ShieldCheck } from "lucide-react";
import { useAuth } from "../lib/stores";
import { useClock } from "../lib/hooks";
import { TRADEMARK_NOTICE } from "../lib/brand";
import { useTranslation } from "../i18n";
import LanguagePill from "./LanguagePill";
import ProductLogo from "./ProductLogo";

export default function LockScreen({ visible, checking }: { visible: boolean; checking: boolean }) {
  const { t, language } = useTranslation();
  const now = useClock();
  const login = useAuth((s) => s.login);
  const lockedUser = useAuth((s) => s.username);
  const [node, setNode] = useState<string>("");
  const [username, setUsername] = useState(lockedUser ?? "admin");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needOtp, setNeedOtp] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setNode(d.node))
      .catch(() => setNode("offline"));
  }, []);

  useEffect(() => {
    if (visible) (setPassword(""), setOtp(""), setNeedOtp(false));
    if (lockedUser) setUsername(lockedUser);
  }, [visible, lockedUser]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password, needOtp ? otp : undefined);
    } catch (err) {
      const msg = (err as Error).message;
      // The backend asks for the TOTP code only after the password checked out.
      if (msg === "Two-factor code required") {
        setNeedOtp(true);
        setError("");
      } else setError(msg);
      if (needOtp) setOtp("");
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

      <form onSubmit={submit} className="glass relative w-full max-w-sm rounded-2xl p-6 shadow-2xl">
        {checking ? (
          <div className="flex justify-center py-6 text-slate-400">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <>
            <div className="mb-5 flex flex-col items-center gap-2 text-center">
              <ProductLogo className="h-14 max-w-full" />
              <div className="text-xs text-slate-400">{t("login.subtitle")}</div>
            </div>
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
                disabled={busy || !password || (needOtp && otp.length !== 6)}
                className="flex w-11 shrink-0 items-center justify-center rounded-lg bg-sky-500 text-white transition hover:bg-sky-400 disabled:opacity-40"
                aria-label={t("login.signIn")}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              </button>
            </div>
            {needOtp && (
              <div className="mt-3">
                <label className="mb-1 flex items-center gap-1.5 text-xs text-slate-400" htmlFor="otp">
                  <ShieldCheck size={12} /> {t("login.twoFactor")}
                </label>
                <input
                  id="otp"
                  className="input w-full font-mono tracking-[0.4em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  autoFocus
                />
              </div>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-rose-400">
                {error}
              </p>
            )}
          </>
        )}
      </form>
      <p className="absolute inset-x-0 bottom-3 mx-auto max-w-2xl px-4 text-center text-[10px] leading-snug text-slate-400/70 select-none">
        {TRADEMARK_NOTICE}
      </p>
    </div>
  );
}
