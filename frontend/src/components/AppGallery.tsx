import { useEffect, useState, type DragEvent, type MouseEvent as RMouseEvent, type ReactNode } from "react";
import { BookOpen, Lock, LogOut, MoreHorizontal, Pin, PinOff, Play, RotateCcw, Search, SlidersHorizontal, User } from "lucide-react";
import { useAuth, useDock, useUsage, useWindows, type AppUsage } from "../lib/stores";
import { useDismiss, useFlip } from "../lib/hooks";
import { APPS, APP_IDS, type AppId } from "../apps/registry";
import { APP_GUIDES } from "../data/wizardGuides";
import { useWizard } from "../store/wizardStore";
import { useAppView, useLayout, useShell, type GallerySort } from "../store/layoutStore";
import { AppIcon } from "./icons/AppIcons";
import { useTranslation, type TKey } from "../i18n";
import { AppListRow, ViewToggle } from "./ViewOptions";
import { GlassButton, GlassSelect } from "./ui/GlassKit";

const CATEGORIES = {
  all: "gallery.cat.all",
  system: "gallery.cat.system",
  storage: "gallery.cat.storage",
  compute: "gallery.cat.compute",
} as const satisfies Record<string, TKey>;
type Category = keyof typeof CATEGORIES;

const CATEGORY_OF: Partial<Record<AppId, Exclude<Category, "all">>> = {
  settings: "system",
  terminal: "system",
  help: "system",
  files: "storage",
  compute: "compute",
  "local-ai": "compute",
  appcenter: "compute",
};

const SORT_LABELS: Record<GallerySort, TKey> = {
  custom: "gallery.sort.custom",
  "most-used": "gallery.sort.mostUsed",
  "alpha-asc": "gallery.sort.alphaAsc",
  "alpha-desc": "gallery.sort.alphaDesc",
  recent: "gallery.sort.recent",
};

/** Every app in display order: the saved custom order first (unknown apps appended), then the chosen sort on top of it. */
export function sortApps(mode: GallerySort, custom: AppId[], usage: Partial<Record<AppId, AppUsage>>, title = (id: AppId) => APPS[id].title): AppId[] {
  const base = [...custom.filter((id) => (APP_IDS as AppId[]).includes(id)), ...APP_IDS.filter((id) => !custom.includes(id))];
  const count = (id: AppId) => usage[id]?.launch_count ?? 0;
  const last = (id: AppId) => Date.parse(usage[id]?.last_opened_at ?? "") || 0;
  const name = (a: AppId, b: AppId) => title(a).localeCompare(title(b));
  // Array.prototype.sort is stable, so ties keep the custom order.
  if (mode === "most-used") return base.sort((a, b) => count(b) - count(a));
  if (mode === "recent") return base.sort((a, b) => last(b) - last(a));
  if (mode === "alpha-asc") return base.sort(name);
  if (mode === "alpha-desc") return base.sort((a, b) => name(b, a));
  return base;
}

/** Full-screen frosted-glass App Gallery: search, categories, sort, Grid | List, drag-and-drop order, pin to the bottom bar. */
export default function AppGallery() {
  const { t, appTitle, appDesc } = useTranslation();
  const { gallery: open, pinned, pin, unpin, set } = useDock();
  const openApp = useWindows((s) => s.open);
  const usage = useUsage((s) => s.usage);
  const { gallerySortMode: sort, galleryAppOrder, set: setLayout } = useLayout();
  const [view] = useAppView("gallery");
  const taskbar = useShell() === "taskbar";
  const { username, lock, logout } = useAuth();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [shown, setShown] = useState(false);
  const [menu, setMenu] = useState<AppId | null>(null);
  const [drag, setDrag] = useState<AppId | null>(null);
  const menuRef = useDismiss(!!menu, () => setMenu(null));
  const close = () => set({ gallery: false });

  const ordered = sortApps(sort, galleryAppOrder, usage, appTitle);
  const q = query.trim().toLowerCase();
  const apps = ordered.filter(
    (id) => (category === "all" || CATEGORY_OF[id] === category) && (!q || `${appTitle(id)} ${appDesc(id)} ${APPS[id].title}`.toLowerCase().includes(q)),
  );
  const topUsed = sortApps("most-used", galleryAppOrder, usage).find((id) => (usage[id]?.launch_count ?? 0) > 0);
  const flipRef = useFlip<HTMLDivElement>(apps.join(",") + view);

  useEffect(() => {
    if (!open) return setShown(false);
    setQuery("");
    setMenu(null);
    const r = requestAnimationFrame(() => setShown(true));
    // Escape closes an open "…" menu first (useDismiss), then the gallery.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[data-gallery-menu]") && set({ gallery: false });
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, set]);
  if (!open) return null;

  const launch = (id: AppId) => (openApp(id), close());
  // Reorder within the full list (search / category only hide tiles); dragging always switches to Custom Order.
  const dragOnto = (target: AppId) => {
    if (!drag || drag === target) return;
    const next = ordered.filter((id) => id !== drag);
    next.splice(ordered.indexOf(target), 0, drag);
    setLayout({ galleryAppOrder: next, gallerySortMode: "custom" });
  };
  const tileDrag = (id: AppId) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => (e.dataTransfer.setData("text/plain", id), (e.dataTransfer.effectAllowed = "move"), setDrag(id), setMenu(null)),
    onDragEnd: () => setDrag(null),
    onDragEnter: () => dragOnto(id),
    onDragOver: (e: DragEvent) => drag && e.preventDefault(),
    onDrop: (e: DragEvent) => (e.preventDefault(), setDrag(null)),
    onContextMenu: (e: RMouseEvent) => (e.preventDefault(), e.stopPropagation(), setMenu(id)),
  });
  const count = (id: AppId) => usage[id]?.launch_count ?? 0;
  const badge = (id: AppId) => (id === topUsed && sort === "most-used" ? t("gallery.topUsed") : count(id) ? t("gallery.opens", { n: count(id) }) : "");
  // Shown always under Most Used, otherwise on hover only.
  const badgeEl = (id: AppId) =>
    badge(id) ? (
      <span className={`rounded-full bg-sky-400/15 px-1.5 py-px text-[10px] text-sky-200 ${sort === "most-used" ? "" : "opacity-0 transition-opacity group-hover:opacity-100"}`}>
        {badge(id)}
      </span>
    ) : null;

  const menuEl = (id: AppId) => (
    <div ref={menuRef} data-gallery-menu className="glass absolute top-full left-1/2 z-10 mt-1 w-52 -translate-x-1/2 rounded-xl p-1 text-left text-xs text-slate-100" role="menu" onClick={(e) => e.stopPropagation()}>
      <MenuItem icon={<Play size={13} />} onClick={() => launch(id)}>{t("common.open")}</MenuItem>
      {pinned.includes(id) ? (
        <MenuItem icon={<PinOff size={13} />} onClick={() => (unpin(id), setMenu(null))}>{t("gallery.unpin")}</MenuItem>
      ) : (
        <MenuItem icon={<Pin size={13} />} onClick={() => (pin(id), setMenu(null))}>{t("gallery.pin")}</MenuItem>
      )}
      {APP_GUIDES[id] && <MenuItem icon={<BookOpen size={13} />} onClick={() => (useWizard.getState().show(id), close())}>{t("gallery.guide")}</MenuItem>}
    </div>
  );
  const moreEl = (id: AppId) => (
    <span
      role="button"
      tabIndex={0}
      aria-label={t("gallery.more", { app: appTitle(id) })}
      onClick={(e) => (e.stopPropagation(), setMenu(menu === id ? null : id))}
      onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), setMenu(id))}
      className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-slate-200 opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:bg-slate-700"
    >
      <MoreHorizontal size={12} />
    </span>
  );

  return (
    <div
      className={`fixed inset-0 z-[8900] flex flex-col items-center bg-slate-950/40 px-4 pt-12 backdrop-blur-3xl backdrop-saturate-150 transition-all duration-300 ${taskbar ? "pb-16" : "pb-32"} ${shown ? "opacity-100" : "scale-105 opacity-0"}`}
      onClick={close}
      role="dialog"
      aria-label={t("gallery.title")}
    >
      <div className="mb-6 flex w-full max-w-4xl flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-48 flex-1">
            <Search size={14} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              className="glass-field w-full rounded-xl py-2 pl-9 text-sm"
              placeholder={t("gallery.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apps[0] && launch(apps[0])}
              aria-label={t("gallery.search")}
            />
          </label>
          <GlassSelect value={sort} onChange={(e) => setLayout({ gallerySortMode: e.target.value as GallerySort })} aria-label={t("gallery.sort")}>
            {(Object.keys(SORT_LABELS) as GallerySort[]).map((s) => (
              <option key={s} value={s}>
                {t(SORT_LABELS[s])}
              </option>
            ))}
          </GlassSelect>
          <ViewToggle app="gallery" />
          {sort === "custom" && galleryAppOrder.length > 0 && (
            <GlassButton variant="ghost" size="xs" onClick={() => setLayout({ galleryAppOrder: [] })} title={t("gallery.resetOrderHint")}>
              <RotateCcw size={12} /> {t("gallery.resetOrder")}
            </GlassButton>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t("gallery.categories")}>
          {(Object.keys(CATEGORIES) as Category[]).map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={category === c}
              onClick={() => setCategory(c)}
              className={`rounded-full px-3 py-1 text-xs transition ${category === c ? "bg-sky-400/25 text-white ring-1 ring-sky-300/50" : "bg-white/5 text-slate-300 hover:bg-white/10"}`}
            >
              {t(CATEGORIES[c])}
            </button>
          ))}
        </div>
      </div>

      <div ref={flipRef} className={`w-full overflow-auto ${view === "list" ? "grid max-w-3xl content-start gap-2 sm:grid-cols-2" : "grid max-w-4xl grid-cols-3 content-start gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-6"}`}>
        {apps.map((id) =>
          view === "list" ? (
            <div key={id} data-flip={id} className={`group relative rounded-xl ${drag === id ? "opacity-40 outline-1 outline-sky-300/70 outline-dashed" : ""}`} {...tileDrag(id)}>
              <AppListRow id={id} iconSize={40} onClick={(e) => (e.stopPropagation(), launch(id))} className="pr-16" />
              <span className="pointer-events-none absolute top-1/2 right-10 -translate-y-1/2">
                {badgeEl(id)}
              </span>
              {moreEl(id)}
              {menu === id && menuEl(id)}
            </div>
          ) : (
            <div key={id} data-flip={id} className={`group relative rounded-2xl ${drag === id ? "opacity-40 outline-1 outline-sky-300/70 outline-dashed" : ""}`} {...tileDrag(id)}>
              <button
                onClick={(e) => (e.stopPropagation(), launch(id))}
                className="flex w-full flex-col items-center gap-1.5 rounded-2xl p-2 text-center text-xs text-slate-100 transition hover:bg-white/10 active:scale-95"
                title={appDesc(id)}
              >
                <span className="relative">
                  <AppIcon id={id} size={72} />
                  {pinned.includes(id) && <Pin size={11} className="absolute -right-1 -bottom-1 rounded-full bg-slate-900/80 p-0.5 text-sky-300" aria-label={t("gallery.onBar")} />}
                </span>
                <span style={{ textShadow: "0 1px 2px var(--sd-label-shadow)" }}>{appTitle(id)}</span>
                <span className="h-4">
                  {badgeEl(id)}
                </span>
              </button>
              {moreEl(id)}
              {menu === id && menuEl(id)}
            </div>
          ),
        )}
        {apps.length === 0 && <p className="col-span-full text-center text-sm text-slate-300">{t("gallery.noMatch")}</p>}
      </div>

      {/* The taskbar has no top bar: the account actions live here (they were in the old Start menu). */}
      {taskbar && (
        <div className="glass-soft mt-4 flex w-full max-w-4xl items-center gap-1 rounded-2xl px-4 py-2 text-xs" onClick={(e) => e.stopPropagation()}>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-slate-200">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10">
              <User size={14} />
            </span>
            <span className="truncate">{username}</span>
          </span>
          <GlassButton variant="ghost" size="xs" onClick={() => launch("settings")} aria-label={t("top.controlPanel")} title={t("top.controlPanel")}>
            <SlidersHorizontal size={15} />
          </GlassButton>
          <GlassButton variant="ghost" size="xs" onClick={() => (close(), lock())} aria-label={t("top.lock")} title={t("top.lock")}>
            <Lock size={15} />
          </GlassButton>
          <GlassButton variant="ghost" size="xs" onClick={() => (close(), logout())} aria-label={t("top.logout")} title={t("top.logout")}>
            <LogOut size={15} className="text-rose-300" />
          </GlassButton>
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, icon }: { children: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-white/10">
      {icon}
      {children}
    </button>
  );
}
