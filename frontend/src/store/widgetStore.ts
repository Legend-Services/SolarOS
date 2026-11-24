import { create } from "zustand";
import { persist } from "zustand/middleware";

export const WIDGET_IDS = ["health", "storage", "compute", "gpu", "network", "ai", "actions"] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];
export type WidgetSlot = "left" | "right" | "grid";
export type WidgetSize = "compact" | "expanded";
export interface WidgetCfg {
  id: WidgetId;
  enabled: boolean;
  slot: WidgetSlot;
  size: WidgetSize;
}

const SLOTS: WidgetSlot[] = ["left", "right", "grid"];
const ON_BY_DEFAULT: WidgetId[] = ["health", "gpu", "storage", "compute"]; // the Phase 16 desktop
export const NOTES_MAX = 4000;
export const defaultWidgets = (): WidgetCfg[] =>
  (["health", "gpu", "storage", "compute", "network", "ai", "actions"] as WidgetId[]).map((id) => ({ id, enabled: ON_BY_DEFAULT.includes(id), slot: "right", size: "expanded" }));

/** Validate a saved layout (localStorage or server JSON): known ids once each, missing widgets appended (off). */
export function sanitizeWidgets(v: unknown): WidgetCfg[] {
  const seen = new Set<WidgetId>();
  const out: WidgetCfg[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const id = x?.id as WidgetId;
    if (!WIDGET_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, enabled: x.enabled === true, slot: SLOTS.includes(x.slot) ? x.slot : "right", size: x.size === "compact" ? "compact" : "expanded" });
  }
  if (!out.length) return defaultWidgets();
  return [...out, ...defaultWidgets().filter((d) => !seen.has(d.id)).map((d) => ({ ...d, enabled: false }))];
}

interface WidgetState {
  items: WidgetCfg[];
  notes: string;
  /** Edit Widgets mode + Widget Studio drawer (not persisted). */
  editing: boolean;
  setEditing: (v: boolean) => void;
  update: (id: WidgetId, patch: Partial<Omit<WidgetCfg, "id">>) => void;
  /** Move a widget into `slot`, before `before` (or to the end of that slot). */
  move: (id: WidgetId, slot: WidgetSlot, before?: WidgetId | null) => void;
  /** Swap with the previous (-1) or next (+1) widget in the same slot. */
  nudge: (id: WidgetId, dir: -1 | 1) => void;
  setNotes: (v: string) => void;
  reset: () => void;
}

export const useWidgets = create<WidgetState>()(
  persist(
    (set) => ({
      items: defaultWidgets(),
      notes: "",
      editing: false,
      setEditing: (editing) => set({ editing }),
      update: (id, patch) => set((s) => ({ items: s.items.map((w) => (w.id === id ? { ...w, ...patch } : w)) })),
      move: (id, slot, before) =>
        set((s) => {
          const w = s.items.find((x) => x.id === id);
          if (!w || before === id) return s;
          const rest = s.items.filter((x) => x.id !== id);
          const at = before ? rest.findIndex((x) => x.id === before) : -1;
          rest.splice(at < 0 ? rest.length : at, 0, { ...w, slot, enabled: true });
          return { items: rest };
        }),
      nudge: (id, dir) =>
        set((s) => {
          const w = s.items.find((x) => x.id === id);
          if (!w) return s;
          const same = s.items.filter((x) => x.slot === w.slot);
          const other = same[same.indexOf(w) + dir];
          if (!other) return s;
          const items = [...s.items];
          const a = items.indexOf(w);
          const b = items.indexOf(other);
          [items[a], items[b]] = [items[b], items[a]];
          return { items };
        }),
      setNotes: (v) => set({ notes: v.slice(0, NOTES_MAX) }),
      reset: () => set({ items: defaultWidgets() }),
    }),
    {
      name: "solardeck-widgets",
      partialize: ({ items, notes }) => ({ items, notes }),
      merge: (saved, cur) => {
        const p = (saved ?? {}) as Partial<WidgetState>;
        return { ...cur, items: p.items ? sanitizeWidgets(p.items) : cur.items, notes: typeof p.notes === "string" ? p.notes.slice(0, NOTES_MAX) : "" };
      },
    },
  ),
);
