import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useSpotlight } from "../lib/stores";
import { useShell } from "../store/layoutStore";
import { useTranslation } from "../i18n";
import { SearchFooter, SearchResults, useListKeys, useSearchItems } from "./search/GlobalSearchBar";

/** True while the user types in a field, so "/" stays a normal character there. */
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * Global search shortcuts (⌘K / Ctrl+K toggle, "/" opens) for both layouts. With the TopBar the inline
 * GlobalSearchBar shows the results; the taskbar layout has no TopBar, so this centered overlay does.
 */
export default function SpotlightSearch() {
  const { t } = useTranslation();
  const { open, set } = useSpotlight();
  const overlay = useShell() === "taskbar";
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = useMemo(() => () => set(false), [set]);
  const items = useSearchItems(q, open && overlay, close);
  const { sel, setSel, onKey } = useListKeys(items, close);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set(!useSpotlight.getState().open);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) {
        e.preventDefault();
        set(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  useEffect(() => {
    if (!open || !overlay) return;
    setQ("");
    setSel(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open, overlay, setSel]);

  if (!open || !overlay) return null;
  return (
    <div className="fixed inset-0 z-[9500] flex items-start justify-center px-4 pt-[14vh]" onKeyDown={onKey}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[3px]" onClick={close} />
      <div role="dialog" aria-modal="true" aria-label={t("search.label")} className="glass-panel relative w-full max-w-xl overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Search size={18} className="text-slate-400" />
          <input
            ref={input}
            value={q}
            onChange={(e) => (setQ(e.target.value), setSel(0))}
            placeholder={t("search.placeholder")}
            className="min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-slate-500 focus:outline-none"
            aria-label={t("search.label")}
            aria-activedescendant={items[sel] ? `spotlight-list-${sel}` : undefined}
            role="combobox"
            aria-expanded
            aria-controls="spotlight-list"
          />
          <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-400">ESC</kbd>
        </div>
        <SearchResults items={items} q={q} sel={sel} setSel={setSel} listRef={list} id="spotlight-list" />
        <SearchFooter />
      </div>
    </div>
  );
}
