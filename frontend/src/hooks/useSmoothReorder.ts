import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as RPointerEvent } from "react";

/**
 * Pointer-based reorder engine for the Dock, taskbar, tray, App Gallery, desktop shortcuts and Settings lists.
 *
 * - A press only becomes a drag after the pointer moves THRESHOLD px, so clicks launch apps instantly.
 * - The dragged item follows the pointer via a GPU transform (written straight to the DOM, no React render per move).
 * - Siblings glide to their new slots with a transform transition; the DOM order never changes mid-drag (no reflow).
 * - The target index changes only when the dragged center crosses a sibling's static midpoint, at most once per COOLDOWN ms.
 * - The new order is committed once, on release.
 */
export const THRESHOLD = 6;
export const COOLDOWN = 75;
export type ReorderAxis = "x" | "y" | "xy";

type Slot = { x: number; y: number; w: number; h: number };
type Delta = { x: number; y: number };

interface Gesture<K> {
  key: K;
  from: number;
  pointerId: number;
  x0: number;
  y0: number;
  el: HTMLElement;
  dragging: boolean;
  slots: Slot[] | null;
  target: number;
  d: Delta;
  lockedUntil: number;
  retry?: ReturnType<typeof setTimeout>;
}

export const arrayMove = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = list.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};

/** Write a reordered visible subset back into the full list; hidden / filtered-out entries keep their positions. */
export const mergeVisible = <T,>(full: readonly T[], visible: readonly T[], next: readonly T[]): T[] => {
  let i = 0;
  return full.map((x) => (visible.includes(x) ? next[i++] : x));
};

const center = (s: Slot) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });

/** Index the dragged item would take: count siblings whose static midpoint it has passed (1D), or the nearest slot (grid). */
export function targetIndex(slots: Slot[], from: number, d: Delta, axis: ReorderAxis): number {
  const c = center(slots[from]);
  const p = { x: c.x + d.x, y: c.y + d.y };
  if (axis === "xy") {
    let best = from;
    let dist = Infinity;
    slots.forEach((s, i) => {
      const m = center(s);
      const v = (m.x - p.x) ** 2 + (m.y - p.y) ** 2;
      if (v < dist) (dist = v), (best = i);
    });
    return best;
  }
  const k = axis === "x" ? "x" : "y";
  return slots.filter((s, i) => i !== from && center(s)[k] < p[k]).length;
}

/** Where every non-dragged item must shift so the list looks reordered: slot swap on a grid, packed along one axis. */
export function siblingOffsets(slots: Slot[], from: number, to: number, axis: ReorderAxis): Delta[] {
  const idx = arrayMove(slots.map((_, i) => i), from, to); // new position -> old index
  const out: Delta[] = slots.map(() => ({ x: 0, y: 0 }));
  if (axis === "xy") {
    idx.forEach((old, pos) => (out[old] = { x: slots[pos].x - slots[old].x, y: slots[pos].y - slots[old].y }));
    return out;
  }
  const [p, size] = axis === "x" ? (["x", "w"] as const) : (["y", "h"] as const);
  const gap = slots.length > 1 ? slots[1][p] - (slots[0][p] + slots[0][size]) : 0;
  let cursor = slots[0][p];
  for (const old of idx) {
    out[old] = axis === "x" ? { x: cursor - slots[old].x, y: 0 } : { x: 0, y: cursor - slots[old].y };
    cursor += slots[old][size] + gap;
  }
  return out;
}

/** Presses inside popovers / menus (positioned descendants) and form controls never start a drag. */
function blocked(target: EventTarget | null, root: Element) {
  for (let el = target as Element | null; el && el !== root; el = el.parentElement)
    if (el.matches("input, textarea, select, [data-no-drag]") || /^(absolute|fixed)$/.test(getComputedStyle(el).position)) return true;
  return false;
}

/** Swallow the click that follows a drag release, so dropping on an icon never launches it. */
function swallowNextClick() {
  const stop = (e: Event) => (e.stopPropagation(), e.preventDefault());
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

export function useSmoothReorder<K extends string>(
  items: readonly K[],
  onCommit: (next: K[]) => void,
  { axis = "x", disabled = false }: { axis?: ReorderAxis; disabled?: boolean } = {},
) {
  const els = useRef(new Map<K, HTMLElement>());
  const g = useRef<Gesture<K> | null>(null);
  const latest = useRef({ items, onCommit, axis });
  latest.current = { items, onCommit, axis };
  const [active, setActive] = useState<{ key: K; target: number; slots: Slot[] | null } | null>(null);
  // The committed order, shown for the one frame between release and the store update reaching `items`.
  const [settled, setSettled] = useState<K[] | null>(null);

  // Stable handlers (created once): window listeners must be removed with the same function identities.
  const [h] = useState(() => {
    const place = (s: Gesture<K>) => (s.el.style.transform = `translate3d(${s.d.x}px, ${s.d.y}px, 0) scale(1.06)`);

    const evaluate = () => {
      const s = g.current;
      if (!s?.slots) return;
      const t = targetIndex(s.slots, s.from, s.d, latest.current.axis);
      if (t === s.target) return;
      const wait = s.lockedUntil - performance.now();
      if (wait > 0) {
        // Anti-jitter lock: re-check once it expires, so a crossing made during the lock is not lost.
        if (!s.retry) s.retry = setTimeout(() => ((s.retry = undefined), evaluate()), wait);
        return;
      }
      s.target = t;
      s.lockedUntil = performance.now() + COOLDOWN;
      setActive((a) => a && { ...a, target: t });
    };

    const onMove = (e: PointerEvent) => {
      const s = g.current;
      if (!s || e.pointerId !== s.pointerId) return;
      s.d = { x: latest.current.axis === "y" ? 0 : e.clientX - s.x0, y: latest.current.axis === "x" ? 0 : e.clientY - s.y0 };
      if (!s.dragging) {
        if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < THRESHOLD) return;
        s.dragging = true;
        try {
          s.el.setPointerCapture(e.pointerId);
        } catch {
          /* the element may already be gone */
        }
        document.body.style.userSelect = "none";
        setActive({ key: s.key, target: s.from, slots: null }); // slots are measured after this render (see below)
        return;
      }
      if (!s.slots) return;
      place(s);
      evaluate();
    };

    const end = (commit: boolean) => {
      const s = g.current;
      if (!s) return;
      g.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      clearTimeout(s.retry);
      if (!s.dragging) return; // a plain click: let it through untouched
      document.body.style.userSelect = "";
      s.el.style.transform = "";
      if (s.el.hasPointerCapture?.(s.pointerId)) s.el.releasePointerCapture(s.pointerId);
      swallowNextClick();
      setActive(null);
      if (commit && s.slots) {
        s.target = targetIndex(s.slots, s.from, s.d, latest.current.axis); // the final position wins over the cooldown
        if (s.target !== s.from) {
          const next = arrayMove(latest.current.items, s.from, s.target);
          setSettled(next);
          latest.current.onCommit(next);
          requestAnimationFrame(() => setSettled(null));
        }
      }
    };
    const onUp = (e: PointerEvent) => e.pointerId === g.current?.pointerId && end(true);
    const onCancel = (e: PointerEvent) => e.pointerId === g.current?.pointerId && end(false);
    return { place, end, onMove, onUp, onCancel };
  });

  // Measure the static slots once the drag render is on screen-to-be (Dock magnification already switched off).
  useLayoutEffect(() => {
    const s = g.current;
    if (!active || active.slots || !s) return;
    const slots = latest.current.items.map((k) => {
      const r = els.current.get(k)?.getBoundingClientRect();
      return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
    });
    s.slots = slots;
    h.place(s);
    setActive({ ...active, slots });
  }, [active, h]);

  useLayoutEffect(() => () => h.end(false), [h]); // unmount mid-drag: drop listeners, keep the old order

  const offsets = active?.slots ? siblingOffsets(active.slots, items.indexOf(active.key), active.target, axis) : null;

  const style = (key: K): CSSProperties | undefined => {
    if (!active) return undefined;
    if (key === active.key) return { position: "relative", zIndex: 50, pointerEvents: "none", transition: "none", willChange: "transform" };
    const o = offsets?.[items.indexOf(key)];
    return o ? { transform: `translate3d(${o.x}px, ${o.y}px, 0)`, transition: "transform 150ms ease-out" } : undefined;
  };

  const bind = (key: K) => ({
    ref: (el: HTMLElement | null) => {
      if (el) els.current.set(key, el);
      else els.current.delete(key);
    },
    onPointerDown: (e: RPointerEvent<HTMLElement>) => {
      if (disabled || e.button !== 0 || g.current || blocked(e.target, e.currentTarget)) return;
      const from = latest.current.items.indexOf(key);
      if (from < 0) return;
      g.current = { key, from, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, el: e.currentTarget, dragging: false, slots: null, target: from, d: { x: 0, y: 0 }, lockedUntil: 0 };
      window.addEventListener("pointermove", h.onMove);
      window.addEventListener("pointerup", h.onUp);
      window.addEventListener("pointercancel", h.onCancel);
    },
    // Images and links inside an item would otherwise start a native drag (ghost image) and cancel the pointer stream.
    onDragStart: (e: DragEvent) => e.preventDefault(),
    style: style(key),
  });

  return { order: (settled ?? items) as K[], dragging: active?.key ?? null, settling: settled !== null, bind };
}
