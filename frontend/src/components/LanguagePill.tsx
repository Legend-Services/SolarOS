import { Languages } from "lucide-react";
import { LANGS, isLang, useTranslation } from "../i18n";

/** Compact language selector pill (login screen, top bar, taskbar, Settings). A native select keeps it keyboard and screen-reader friendly. */
export default function LanguagePill({ className = "" }: { className?: string }) {
  const { t, language, setLanguage } = useTranslation();
  return (
    <label className={`relative inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-slate-200 hover:bg-white/10 ${className}`} title={t("common.language")}>
      <Languages size={12} aria-hidden />
      <span className="text-[11px] font-medium uppercase">{language}</span>
      <select
        aria-label={t("common.language")}
        value={language}
        onChange={(e) => isLang(e.target.value) && setLanguage(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {LANGS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
