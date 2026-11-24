import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * FLIP reorder animation: children of the returned ref marked `data-flip="<key>"` spring from their old spot
 * to the new one whenever `order` changes (drag-and-drop reordering in the Dock, Taskbar and App Gallery).
 */
export function useFlip<T extends HTMLElement>(order: string) {
  const ref = useRef<T>(null);
  const last = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const els = ref.current ? [...ref.current.querySelectorAll<HTMLElement>("[data-flip]")] : [];
    const next = new Map(els.map((el) => [el.dataset.flip!, el.getBoundingClientRect()]));
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
      for (const el of els) {
        const a = last.current.get(el.dataset.flip!);
        const b = next.get(el.dataset.flip!)!;
        if (a && (a.left !== b.left || a.top !== b.top))
          el.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: "none" }], {
            duration: 280,
            easing: "cubic-bezier(.2, .9, .3, 1.15)", // slight overshoot: a spring feel without a physics library
          });
      }
    last.current = next;
  }, [order]);
  return ref;
}

/** Busy / error / success-notice state around async actions. `run` resolves to true on success. */
export function useRunner(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const run = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await fn();
        if (ok) setNotice(ok);
        onDone?.();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );
  return { busy, error, notice, run, setError };
}

export function useClock(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useIsMobile() {
  const query = "(max-width: 767px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setMobile(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return mobile;
}

/** Run `fn` now and every `ms` while mounted. */
export function usePoll(fn: () => void, ms: number) {
  useEffect(() => {
    fn();
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}

/** Close a popover on outside pointer-down or Escape. Attach the returned ref to its container. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}
