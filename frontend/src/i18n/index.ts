import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppId } from "../apps/registry";
import { en, type Dict, type TKey } from "./en";
import { nl } from "./nl";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";

export type Lang = "en" | "nl" | "de" | "es" | "fr";
export type { TKey };
export const DICTS: Record<Lang, Dict> = { en, nl, de, es, fr };
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "nl", label: "Nederlands" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
];
export const isLang = (v: unknown): v is Lang => typeof v === "string" && v in DICTS;

/** Browser language on first visit, English otherwise. */
const initial = (): Lang => {
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return isLang(nav) ? nav : "en";
};

interface LangState {
  language: Lang;
  setLanguage: (l: Lang) => void;
}

export const useLanguage = create<LangState>()(
  persist((set) => ({ language: initial(), setLanguage: (language) => set({ language }) }), {
    name: "solardeck-language",
    merge: (saved, cur) => ({ ...cur, language: isLang((saved as Partial<LangState>)?.language) ? (saved as LangState).language : cur.language }),
  }),
);

const apply = (l: Lang) => (document.documentElement.lang = l);
apply(useLanguage.getState().language);
useLanguage.subscribe((s) => apply(s.language));

export type Vars = Record<string, string | number>;

/** Translate `key` into `lang`, filling `{name}` placeholders. Missing entries fall back to English. */
export function translate(lang: Lang, key: TKey, vars?: Vars): string {
  const s = DICTS[lang][key] ?? en[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** `t(key, vars)` in the active language; re-renders when the language changes. */
export function useTranslation() {
  const language = useLanguage((s) => s.language);
  const setLanguage = useLanguage((s) => s.setLanguage);
  const t = (key: TKey, vars?: Vars) => translate(language, key, vars);
  return { t, language, setLanguage, appTitle: (id: AppId) => t(`app.${id}`), appDesc: (id: AppId) => t(`appDesc.${id}`) };
}
