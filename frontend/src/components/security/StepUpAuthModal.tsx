import { useState, type FormEvent } from "react";
import { create } from "zustand";
import { KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { api, rememberStepUp, setStepUpHandler } from "../../lib/api";
import { useTranslation } from "../../i18n";
import { GlassButton, GlassInput, GlassModal, Notice } from "../ui/GlassKit";

/* Global step-up re-authentication. lib/api.ts calls the handler when a destructive request answers 403
   "step_up_required" (and ConsoleApp before opening a host shell); the request is retried once confirmed. */
interface StepUpState {
  resolve: ((token: string | null) => void) | null;
}
const useStepUp = create<StepUpState>(() => ({ resolve: null }));
let pending: Promise<string | null> | null = null;

setStepUpHandler(() => {
  // Parallel requests share one prompt.
  pending ??= new Promise<string | null>((resolve) => useStepUp.setState({ resolve })).finally(() => (pending = null));
  return pending;
});

export default function StepUpAuthModal() {
  const { t } = useTranslation();
  const resolve = useStepUp((s) => s.resolve);
  const [mode, setMode] = useState<"password" | "code">("password");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const finish = (token: string | null) => {
    resolve?.(token);
    useStepUp.setState({ resolve: null });
    setValue("");
    setError("");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ step_up_token: string; expires_in: number }>("/auth/step-up", {
        method: "POST",
        json: mode === "password" ? { password: value } : { code: value },
      });
      rememberStepUp(r.step_up_token, r.expires_in);
      finish(r.step_up_token);
    } catch (err) {
      setError((err as Error).message);
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative z-[9500]">
      <GlassModal
        open={!!resolve}
        onClose={() => finish(null)}
        width="max-w-sm"
        title={
          <span className="flex items-center gap-2">
            <ShieldAlert size={15} className="text-amber-300" /> {t("stepup.title")}
          </span>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-slate-300">{t("stepup.body")}</p>
          <GlassInput
            type={mode === "password" ? "password" : "text"}
            className={`w-full ${mode === "code" ? "font-mono tracking-widest" : ""}`}
            inputMode={mode === "code" ? "numeric" : undefined}
            autoComplete={mode === "password" ? "current-password" : "one-time-code"}
            placeholder={mode === "password" ? t("login.password") : "000000"}
            maxLength={mode === "password" ? 256 : 11}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            aria-label={mode === "password" ? t("login.password") : t("login.twoFactor")}
          />
          <Notice error={error} />
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-[11px] text-sky-300 hover:underline" onClick={() => (setMode(mode === "password" ? "code" : "password"), setValue(""))}>
              {mode === "password" ? t("stepup.useCode") : t("stepup.usePassword")}
            </button>
            <div className="flex gap-2">
              <GlassButton variant="ghost" onClick={() => finish(null)}>
                {t("common.cancel")}
              </GlassButton>
              <GlassButton type="submit" variant="primary" disabled={busy || !value}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {t("stepup.confirm")}
              </GlassButton>
            </div>
          </div>
          <p className="text-[10px] text-slate-500">{t("stepup.validity")}</p>
        </form>
      </GlassModal>
    </div>
  );
}
