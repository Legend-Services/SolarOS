import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Container, CornerDownLeft, Database, Folder, Monitor, Plus, Search, Settings2, Share2, Store } from "lucide-react";
import { api } from "../lib/api";
import type { SearchKind, SearchResult } from "../lib/types";
import { useIntent, useSpotlight, useWindows, type Intents } from "../lib/stores";
import { APPS, APP_IDS } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";

interface Item {
  key: string;
  group: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  run: () => void;
}

const GROUPS: Record<SearchKind, string> = {
  qemu: "Virtual Machines",
  lxc: "Containers",
  pool: "ZFS Pools",
  dataset: "Datasets",
  share: "SMB Shares",
  app: "App Center",
  section: "Control Panel",
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

export default function SpotlightSearch() {
  const { open, set } = useSpotlight();
  const openWindow = useWindows((s) => s.open);
  const go = useIntent((s) => s.go);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<SearchResult[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Global shortcut: Cmd+K / Ctrl+K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set(!useSpotlight.getState().open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setRemote([]);
    setSel(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  // Debounced server search; stale responses are dropped.
  useEffect(() => {
    const term = q.trim();
    if (!open || !term) return setRemote([]);
    let live = true;
    const t = setTimeout(() => {
      api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}`).then((r) => live && setRemote(r.results), () => live && setRemote([]));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, open]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const close = (fn: () => void) => () => (set(false), fn());
    const intent = <K extends keyof Intents>(app: K & keyof typeof APPS, v: Intents[K]) => close(() => go(app, v));
    const actions: Item[] = [
      { key: "a:vm", group: "Actions", title: "New Virtual Machine", subtitle: "Create VM wizard", icon: <Plus size={16} className="text-sky-300" />, run: intent("compute", "vm") },
      { key: "a:ct", group: "Actions", title: "New Container", subtitle: "Create LXC wizard", icon: <Plus size={16} className="text-violet-300" />, run: intent("compute", "lxc") },
      { key: "a:iso", group: "Actions", title: "Download ISO", subtitle: "ISO & Templates library", icon: <Plus size={16} className="text-emerald-300" />, run: intent("compute", "iso") },
      { key: "a:pool", group: "Actions", title: "Create ZFS Pool", subtitle: "Storage & ZFS", icon: <Plus size={16} className="text-amber-300" />, run: intent("storage", "pool") },
    ].filter((a) => !term || a.title.toLowerCase().includes(term));
    const apps: Item[] = APP_IDS.filter((id) => !term || APPS[id].title.toLowerCase().includes(term)).map((id) => ({
      key: `app:${id}`,
      group: "Applications",
      title: APPS[id].title,
      subtitle: "Open application",
      icon: <AppIcon id={id} size={22} />,
      run: close(() => openWindow(id)),
    }));
    const found: Item[] = remote.map((r, i) => {
      const t = r.target;
      const run =
        r.kind === "qemu" || r.kind === "lxc"
          ? t.status === "running"
            ? () => openWindow("console", { type: r.kind as "qemu" | "lxc", vmid: t.vmid!, name: t.name || r.title, mode: r.kind === "qemu" ? "vnc" : "shell" })
            : () => openWindow("compute")
          : r.kind === "dataset" || r.kind === "share"
            ? () => go("files", t.path)
            : r.kind === "pool"
              ? () => openWindow("storage")
              : r.kind === "app"
                ? () => openWindow("appcenter")
                : () => go("controlpanel", t.section as Intents["controlpanel"]);
      const sub = (r.kind === "qemu" || r.kind === "lxc") && t.status !== "running" ? `${r.subtitle} · open Compute Manager` : r.subtitle;
      return { key: `r:${r.kind}:${i}`, group: GROUPS[r.kind], title: r.title, subtitle: sub, icon: KIND_ICON[r.kind], run: close(run) };
    });
    return term ? [...apps, ...found, ...actions] : [...actions, ...apps];
  }, [q, remote, set, go, openWindow]);

  useEffect(() => setSel((s) => Math.min(s, Math.max(0, items.length - 1))), [items.length]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => (s + 1) % Math.max(1, items.length)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => (s - 1 + items.length) % Math.max(1, items.length)));
    else if (e.key === "Enter") (e.preventDefault(), items[sel]?.run());
    else if (e.key === "Escape") (e.preventDefault(), set(false));
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[9500] flex items-start justify-center px-4 pt-[14vh]" onKeyDown={onKey}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[3px]" onClick={() => set(false)} />
      <div role="dialog" aria-modal="true" aria-label="Spotlight search" className="glass-panel relative w-full max-w-xl overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Search size={18} className="text-slate-400" />
          <input
            ref={input}
            value={q}
            onChange={(e) => (setQ(e.target.value), setSel(0))}
            placeholder="Search apps, VMs, containers, pools, shares, settings…"
            className="min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-slate-500 focus:outline-none"
            aria-label="Search"
            aria-activedescendant={items[sel] ? `spot-${sel}` : undefined}
            role="combobox"
            aria-expanded
            aria-controls="spotlight-list"
          />
          <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-400">ESC</kbd>
        </div>
        <ul ref={list} id="spotlight-list" role="listbox" className="max-h-[50vh] overflow-auto p-2">
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-400">No results for “{q}”</li>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? ((lastGroup = it.group), it.group) : null;
            return (
              <li key={it.key}>
                {header && <div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">{header}</div>}
                <button
                  id={`spot-${i}`}
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
                    <span className="block truncate text-[11px] text-slate-400">{it.subtitle}</span>
                  </span>
                  {i === sel && <CornerDownLeft size={14} className="text-slate-400" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-4 border-t border-white/10 px-4 py-2 text-[10px] text-slate-500">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>⌘K / Ctrl+K toggle</span>
        </div>
      </div>
    </div>
  );
}
