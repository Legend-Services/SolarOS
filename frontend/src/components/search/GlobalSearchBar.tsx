import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { BookOpen, Container, CornerDownLeft, Database, FileText, Folder, Heading, Monitor, Plus, Search, Settings2, Share2, Store, X } from "lucide-react";
import { api } from "../../lib/api";
import type { SearchKind, SearchResult } from "../../lib/types";
import { navigate, useIntent, useSpotlight, useWindows, type Intents } from "../../lib/stores";
import { AppIcon } from "../icons/AppIcons";
import { CATEGORY_META, MODULES } from "../../apps/settings/modules";
import { searchKnowledge, type Hit, type Tier } from "../../data/knowledgeRegistry";
import { useTranslation, type TKey } from "../../i18n";
import { useCapabilities } from "../../store/capabilitiesStore";
import { useLayout } from "../../store/layoutStore";
import { GlassButton, GlassCheckbox } from "../ui/GlassKit";

export interface Item {
  key: string;
  group: string;
  count: number;
  title: string;
  subtitle: string;
  mark?: [number, number];
  icon: ReactNode;
  run: () => void;
}

const TIER_LABEL: Record<Tier, TKey> = {
  apps: "search.tier.apps",
  categories: "search.tier.categories",
  modules: "search.tier.modules",
  controls: "search.tier.controls",
  articles: "search.tier.articles",
  subtitles: "search.tier.subtitles",
  body: "search.tier.body",
};

const KIND_ICON: Record<SearchKind, ReactNode> = {
  qemu: <Monitor size={16} className="text-sky-300" />,
  lxc: <Container size={16} className="text-violet-300" />,
  pool: <Database size={16} className="text-amber-300" />,
  dataset: <Folder size={16} className="text-emerald-300" />,
  share: <Share2 size={16} className="text-cyan-300" />,
  app: <Store size={16} className="text-rose-300" />,
  section: <Settings2 size={16} className="text-indigo-300" />,
};

function hitIcon(h: Hit): ReactNode {
  if (h.appId) return <AppIcon id={h.appId} size={22} />;
  const Icon = h.moduleId ? MODULES[h.moduleId].icon : h.categoryId ? CATEGORY_META[h.categoryId].icon : h.tier === "articles" ? BookOpen : h.tier === "subtitles" ? Heading : FileText;
  return <Icon size={16} className={h.tier === "articles" || h.tier === "subtitles" || h.tier === "body" ? "text-emerald-300" : "text-indigo-300"} />;
}

/**
 * Results for `q`: the seven knowledge tiers in their fixed order (apps, Settings categories, sub-modules,
 * sub-sub-modules & controls, support titles, subtitles, help text), then live guests, pools and shares from the server.
 */
export function useSearchItems(q: string, active: boolean, close: () => void): Item[] {
  const { t } = useTranslation();
  const caps = useCapabilities((s) => s.capabilities);
  const openWindow = useWindows((s) => s.open);
  const go = useIntent((s) => s.go);
  const [remote, setRemote] = useState<SearchResult[]>([]);

  // Debounced server search; stale responses are dropped.
  useEffect(() => {
    const term = q.trim();
    if (!active || !term) return setRemote([]);
    let live = true;
    const timer = setTimeout(() => {
      api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}`).then((r) => live && setRemote(r.results.filter((x) => x.kind !== "section")), () => live && setRemote([]));
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, active]);

  return useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const done = (fn: () => void) => () => (close(), fn());
    const tiers: Item[] = searchKnowledge(q, t, caps).flatMap((g) =>
      g.hits.map((h) => ({ key: h.key, group: t(TIER_LABEL[g.tier]), count: g.total, title: h.title, subtitle: h.subtitle, mark: h.mark, icon: hitIcon(h), run: done(() => navigate(h.target)) })),
    );
    const intent = <K extends keyof Intents>(app: K & Parameters<typeof go>[0], v: Intents[K]) => done(() => go(app, v));
    const actions = (
      [
        ["a:vm", "search.act.vm", <Plus size={16} className="text-sky-300" />, intent("compute", "vm")],
        ["a:ct", "search.act.ct", <Plus size={16} className="text-violet-300" />, intent("compute", "lxc")],
        ["a:iso", "search.act.iso", <Plus size={16} className="text-emerald-300" />, intent("compute", "iso")],
        ["a:pool", "search.act.pool", <Plus size={16} className="text-amber-300" />, intent("storage", "pool")],
      ] as [string, TKey, ReactNode, () => void][]
    ).filter(([, k]) => t(k).toLowerCase().includes(term));
    const found: Omit<Item, "group" | "count">[] = [
      ...actions.map(([key, k, icon, run]) => ({ key, title: t(k), subtitle: t("search.action"), icon, run })),
      ...remote.map((r, i) => {
        const x = r.target;
        const run =
          r.kind === "qemu" || r.kind === "lxc"
            ? x.status === "running"
              ? () => openWindow("console", { type: r.kind as "qemu" | "lxc", vmid: x.vmid!, name: x.name || r.title, mode: r.kind === "qemu" ? "vnc" : "shell" })
              : () => openWindow("compute")
            : r.kind === "dataset" || r.kind === "share"
              ? () => go("files", x.path)
              : r.kind === "pool"
                ? () => go("settings", "storage-zfs")
                : () => openWindow("appcenter");
        return { key: `r:${r.kind}:${i}`, title: r.title, subtitle: r.subtitle, icon: KIND_ICON[r.kind], run: done(run) };
      }),
    ];
    return [...tiers, ...found.map((f) => ({ ...f, group: t("search.tier.resources"), count: found.length }))];
  }, [q, remote, t, caps, close, go, openWindow]);
}

/** Up/Down/Enter/Escape over `items`; returns the selection and the key handler. */
export function useListKeys(items: Item[], onEscape: () => void) {
  const [sel, setSel] = useState(0);
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, items.length - 1))), [items.length]);
  const onKey = (e: ReactKeyboardEvent) => {
    const n = Math.max(1, items.length);
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => (s + 1) % n));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => (s - 1 + n) % n));
    else if (e.key === "Enter") (e.preventDefault(), items[sel]?.run());
    else if (e.key === "Escape") (e.preventDefault(), onEscape());
  };
  return { sel, setSel, onKey };
}

function Marked({ text, mark }: { text: string; mark?: [number, number] }) {
  if (!mark) return <>{text}</>;
  return (
    <>
      {text.slice(0, mark[0])}
      <mark className="search-mark">{text.slice(mark[0], mark[1])}</mark>
      {text.slice(mark[1])}
    </>
  );
}

/** The grouped result list shared by the TopBar search bar and the taskbar overlay. */
export function SearchResults({ items, q, sel, setSel, listRef, id }: { items: Item[]; q: string; sel: number; setSel: (i: number) => void; listRef: RefObject<HTMLUListElement | null>; id: string }) {
  const { t } = useTranslation();
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, listRef]);
  let last = "";
  return (
    <ul ref={listRef} id={id} role="listbox" className="max-h-[60vh] overflow-auto p-2">
      {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-400">{q.trim() ? t("search.noResults", { q }) : t("search.hint")}</li>}
      {items.map((it, i) => {
        const header = it.group !== last ? ((last = it.group), it) : null;
        return (
          <li key={it.key}>
            {header && (
              <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">
                <span className="flex-1">{header.group}</span>
                <span className="rounded-full bg-white/8 px-1.5 tabular-nums">{header.count}</span>
              </div>
            )}
            <button
              id={`${id}-${i}`}
              data-idx={i}
              role="option"
              aria-selected={i === sel}
              onMouseMove={() => setSel(i)}
              onClick={it.run}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${i === sel ? "bg-sky-400/20 ring-1 ring-sky-300/25 ring-inset" : "hover:bg-white/5"}`}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">{it.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-100">{it.title}</span>
                <span className="block truncate text-[11px] text-slate-400">
                  <Marked text={it.subtitle} mark={it.mark} />
                </span>
              </span>
              {i === sel && <CornerDownLeft size={14} className="text-slate-400" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SearchFooter() {
  const { t } = useTranslation();
  return (
    <div className="flex gap-4 border-t border-white/10 px-4 py-2 text-[10px] text-slate-500">
      <span>↑↓ {t("search.navigate")}</span>
      <span>↵ {t("search.open")}</span>
      <span>esc {t("search.close")}</span>
      <span className="ml-auto">⌘K / Ctrl+K · /</span>
    </div>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * "Type to begin" balloon under the search field until it is focused or dismissed. "Don't show me again" persists
 * hideSearchIntroBalloon (localStorage + /api/system/preferences via the layout store).
 */
function SearchTip() {
  const { t } = useTranslation();
  const set = useLayout((s) => s.set);
  const [never, setNever] = useState(false);
  const dismiss = () => set({ searchTipDismissed: true, ...(never ? { hideSearchIntroBalloon: true } : {}) });
  return (
    <div
      role="note"
      className="glass-panel absolute top-9 left-1/2 z-10 w-72 -translate-x-1/2 rounded-2xl p-3 text-xs shadow-2xl shadow-black/40"
      style={{ animation: "sd-search-in 220ms ease-out" }}
    >
      <span className="glass-panel absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[3px] border-r-0 border-b-0" aria-hidden />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">{t("search.tipTitle")}</p>
          <p className="mt-0.5 text-[11px] text-slate-300">{t("search.tipBody", { key: isMac ? "⌘K" : "Ctrl+K" })}</p>
        </div>
        <GlassButton variant="ghost" size="xs" onClick={dismiss} aria-label={t("search.tipClose")}>
          <X size={12} />
        </GlassButton>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <GlassCheckbox checked={never} onChange={setNever} label={t("search.tipDontShow")} />
        <GlassButton size="xs" variant="primary" onClick={dismiss}>
          {t("search.tipGotIt")}
        </GlassButton>
      </div>
    </div>
  );
}

/** TopBar search: an inline Liquid Glass field that expands into the grouped results panel. Opened by ⌘K / Ctrl+K or "/". */
export default function GlobalSearchBar() {
  const { t } = useTranslation();
  const open = useSpotlight((s) => s.open);
  const setOpen = useSpotlight((s) => s.set);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => (setOpen(false), setQ(""), input.current?.blur()), [setOpen]);
  const items = useSearchItems(q, open, close);
  const { sel, setSel, onKey } = useListKeys(items, close);
  const tip = useLayout((s) => !s.hideSearchIntroBalloon && !s.searchTipDismissed);
  const setLayout = useLayout((s) => s.set);

  useEffect(() => {
    if (open) (input.current?.focus(), setLayout({ searchTipDismissed: true }));
    else (input.current?.blur(), setQ(""));
  }, [open, setLayout]);
  // Click outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [open, setOpen]);

  return (
    <div ref={box} className="relative mx-auto max-w-2xl min-w-0 flex-1 sm:min-w-[300px] md:min-w-[380px] lg:min-w-[460px]" onKeyDown={onKey}>
      <div
        className={`flex h-6.5 items-center gap-2 rounded-full border px-3 transition-all duration-200 ${open ? "border-white/25 bg-white/15 shadow-lg shadow-black/30" : "border-white/10 bg-white/7 hover:bg-white/12"}`}
      >
        <Search size={13} className="shrink-0 text-slate-400" />
        <input
          ref={input}
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => (setQ(e.target.value), setSel(0), setOpen(true))}
          placeholder={t("search.placeholder")}
          className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-slate-400 focus:outline-none"
          aria-label={t("search.label")}
          role="combobox"
          aria-expanded={open}
          aria-controls="global-search-list"
          aria-activedescendant={open && items[sel] ? `global-search-list-${sel}` : undefined}
        />
        <kbd className="hidden shrink-0 rounded bg-white/10 px-1.5 text-[10px] text-slate-400 sm:inline">{isMac ? "⌘K" : "Ctrl+K"}</kbd>
      </div>
      {tip && !open && <SearchTip />}
      {open && (
        <div className="glass-panel absolute top-8 left-1/2 w-[min(640px,calc(100vw-1rem))] -translate-x-1/2 overflow-hidden rounded-2xl shadow-2xl shadow-black/50" style={{ animation: "sd-search-in 160ms ease-out" }}>
          <SearchResults items={items} q={q} sel={sel} setSel={setSel} listRef={list} id="global-search-list" />
          <SearchFooter />
        </div>
      )}
    </div>
  );
}
