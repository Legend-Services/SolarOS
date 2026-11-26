import { useEffect, useLayoutEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "../../i18n";
import { useOnboarding } from "../../store/onboardingStore";
import { GlassButton } from "../ui/GlassKit";

/** Desktop elements the balloons point at (`data-tour` attributes in TopBar, Taskbar, Dock and Desktop). */
const STEPS = ["search", "tray", "widgets", "dock", "settings"] as const;
const W = 320; // balloon width
const GAP = 14;

type Place = { top: number; left: number; side: "top" | "bottom" | "left" | "right" | "none"; arrow: number };

/** Where the balloon goes for a target rect: below it, else above, else beside it; centered when there is no target. */
export function place(r: DOMRect | null, vw: number, vh: number, h: number): Place {
  if (!r || !r.width) return { top: vh / 2 - h / 2, left: vw / 2 - W / 2, side: "none", arrow: 0 };
  const clampX = (x: number) => Math.max(8, Math.min(vw - W - 8, x));
  const cx = r.left + r.width / 2;
  if (r.bottom + GAP + h < vh && r.height < vh / 2) {
    const left = clampX(cx - W / 2);
    return { top: r.bottom + GAP, left, side: "top", arrow: cx - left };
  }
  if (r.top - GAP - h > 0 && r.height < vh / 2) {
    const left = clampX(cx - W / 2);
    return { top: r.top - GAP - h, left, side: "bottom", arrow: cx - left };
  }
  const top = Math.max(8, Math.min(vh - h - 8, r.top + r.height / 2 - h / 2));
  const arrow = r.top + r.height / 2 - top;
  return r.left > W + GAP ? { top, left: r.left - GAP - W, side: "right", arrow } : { top, left: r.right + GAP, side: "left", arrow };
}

/** Non-blocking Liquid Glass speech balloons over the live desktop; Skip Guide ends it at any step. */
export default function DesktopGuidedTour() {
  const { t } = useTranslation();
  const { tour, endTour } = useOnboarding();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [h, setH] = useState(150);
  const id = STEPS[i];

  useEffect(() => {
    if (tour) setI(0);
  }, [tour]);
  useLayoutEffect(() => {
    if (!tour) return;
    const measure = () => setRect(document.querySelector(`[data-tour="${id}"]`)?.getBoundingClientRect() ?? null);
    measure();
    const onResize = measure;
    window.addEventListener("resize", onResize);
    const timer = setInterval(measure, 500); // the dock auto-hides and windows move: keep the arrow on target
    return () => (window.removeEventListener("resize", onResize), clearInterval(timer));
  }, [tour, id]);
  useEffect(() => {
    if (!tour) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && endTour();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [tour, endTour]);

  if (!tour) return null;
  const p = place(rect, window.innerWidth, window.innerHeight, h);
  const last = i === STEPS.length - 1;
  const n = i + 1;
  const arrowPos =
    p.side === "top" || p.side === "bottom"
      ? { left: Math.max(16, Math.min(W - 16, p.arrow)) - 7, [p.side]: -7 }
      : p.side === "none"
        ? null
        : { top: Math.max(16, Math.min(h - 16, p.arrow)) - 7, [p.side]: -7 };

  return (
    <>
      {rect && rect.width > 0 && (
        <div
          className="pointer-events-none fixed z-[9650] rounded-xl ring-2 ring-cyan-300/80 shadow-[0_0_0_4px_rgba(34,211,238,0.15),0_0_30px_rgba(34,211,238,0.35)] transition-all duration-300"
          style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
          aria-hidden
        />
      )}
      <div
        ref={(el) => {
          if (el && el.offsetHeight !== h) setH(el.offsetHeight);
        }}
        role="dialog"
        aria-live="polite"
        aria-label={t(`tour.s${n}.title` as never)}
        className="glass fixed z-[9660] rounded-2xl border border-cyan-300/30 p-4 shadow-[0_10px_40px_rgba(0,0,0,0.5)] transition-[top,left] duration-300"
        style={{ top: p.top, left: p.left, width: W }}
      >
        {arrowPos && <span className="absolute h-3.5 w-3.5 rotate-45 border border-cyan-300/30 bg-slate-800/95" style={arrowPos} aria-hidden />}
        <div className="flex items-start gap-2">
          <span className="text-[10px] font-semibold tracking-wide text-cyan-300 uppercase">{t("tour.step", { n, total: STEPS.length })}</span>
          <button onClick={endTour} className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-white/10 hover:text-white" aria-label={t("tour.skip")}>
            {t("tour.skip")} <X size={12} />
          </button>
        </div>
        <h3 className="mt-1 text-sm font-semibold text-white">{t(`tour.s${n}.title` as never)}</h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-300">{t(`tour.s${n}.body` as never)}</p>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden>
            {STEPS.map((s, k) => <span key={s} className={`h-1.5 rounded-full transition-all ${k === i ? "w-4 bg-cyan-300" : "w-1.5 bg-white/25"}`} />)}
          </div>
          {i > 0 && (
            <GlassButton size="xs" className="ml-auto" onClick={() => setI(i - 1)}>
              <ChevronLeft size={12} /> {t("tour.back")}
            </GlassButton>
          )}
          <GlassButton size="xs" variant="primary" className={i > 0 ? "" : "ml-auto"} onClick={() => (last ? endTour() : setI(i + 1))}>
            {last ? t("tour.finish") : t("tour.next")} {!last && <ChevronRight size={12} />}
          </GlassButton>
        </div>
      </div>
    </>
  );
}
