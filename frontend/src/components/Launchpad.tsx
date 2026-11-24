import { useEffect, useState } from "react";
import { Pin, Search } from "lucide-react";
import { useDock, useWindows } from "../lib/stores";
import { APPS, APP_IDS } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";
import { useLayout } from "../store/layoutStore";
import { AppListRow } from "./ViewOptions";

/** Full-screen frosted-glass grid of every app, so apps removed from the Dock stay one click away. */
export default function Launchpad() {
  const { launchpad: open, pinned, set } = useDock();
  const openApp = useWindows((s) => s.open);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(false);
  const list = useLayout((s) => s.desktopView === "list");

  useEffect(() => {
    if (!open) return setShown(false);
    setQuery("");
    const r = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ launchpad: false });
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, set]);
  if (!open) return null;

  const q = query.trim().toLowerCase();
  const apps = APP_IDS.filter((id) => !q || APPS[id].title.toLowerCase().includes(q));
  const launch = (id: (typeof APP_IDS)[number]) => {
    openApp(id);
    set({ launchpad: false });
  };

  return (
    <div
      className={`fixed inset-0 z-[8900] flex flex-col items-center bg-slate-950/40 px-4 pt-16 pb-32 backdrop-blur-3xl backdrop-saturate-150 transition-all duration-300 ${shown ? "opacity-100" : "scale-105 opacity-0"}`}
      onClick={() => set({ launchpad: false })}
      role="dialog"
      aria-label="Launchpad"
    >
      <label className="relative mb-10 w-full max-w-xs" onClick={(e) => e.stopPropagation()}>
        <Search size={14} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus
          className="glass-field w-full rounded-xl py-2 pl-9 text-sm"
          placeholder="Search apps"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apps[0] && launch(apps[0])}
          aria-label="Search apps"
        />
      </label>
      {list ? (
        <div className="grid w-full max-w-3xl gap-2 overflow-auto sm:grid-cols-2">
          {apps.map((id) => (
            <AppListRow key={id} id={id} iconSize={40} onClick={(e) => (e.stopPropagation(), launch(id))} />
          ))}
          {apps.length === 0 && <p className="col-span-full text-center text-sm text-slate-300">No apps match “{query}”.</p>}
        </div>
      ) : (
      <div className="grid w-full max-w-4xl grid-cols-3 gap-x-4 gap-y-8 overflow-auto sm:grid-cols-4 md:grid-cols-6">
        {apps.map((id) => (
          <button
            key={id}
            onClick={(e) => (e.stopPropagation(), launch(id))}
            className="group flex flex-col items-center gap-2 rounded-2xl p-2 text-center text-xs text-slate-100 transition hover:bg-white/10 active:scale-95"
          >
            <span className="relative">
              <AppIcon id={id} size={72} />
              {pinned.includes(id) && <Pin size={11} className="absolute -right-1 -bottom-1 rounded-full bg-slate-900/80 p-0.5 text-sky-300" aria-label="In Dock" />}
            </span>
            <span style={{ textShadow: "0 1px 2px var(--sd-label-shadow)" }}>{APPS[id].title}</span>
          </button>
        ))}
        {apps.length === 0 && <p className="col-span-full text-center text-sm text-slate-300">No apps match “{query}”.</p>}
      </div>
      )}
    </div>
  );
}
