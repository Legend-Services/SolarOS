import { ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import { usePrefs } from "../lib/stores";
import { useTranslation } from "../i18n";
import { useWidgets, type WidgetSize, type WidgetSlot } from "../store/widgetStore";
import { WIDGET_META } from "./DesktopWidgets";
import { GlassButton, GlassSwitch, Segmented } from "./ui/GlassKit";

/** Side drawer of Edit Widgets mode: on/off, slot, size and order for every widget (keyboard alternative to dragging). */
export default function WidgetStudioDrawer() {
  const { t } = useTranslation();
  const { items, editing, setEditing, update, move, nudge, reset } = useWidgets();
  const { widgets: master, set: setPrefs } = usePrefs();
  if (!editing) return null;
  const slots = (["left", "right", "grid"] as WidgetSlot[]).map((id) => ({ id, label: t(`studio.slot.${id}`) }));
  const sizes = (["compact", "expanded"] as WidgetSize[]).map((id) => ({ id, label: t(`studio.${id}`) }));
  return (
    <aside
      className="glass-panel fixed top-12 right-3 bottom-20 z-[9300] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col rounded-2xl text-xs shadow-2xl shadow-black/40"
      role="dialog"
      aria-label={t("studio.title")}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <h3 className="flex-1 text-sm font-semibold text-white">{t("studio.title")}</h3>
        <GlassButton variant="primary" size="xs" onClick={() => setEditing(false)}>
          {t("common.done")}
        </GlassButton>
        <GlassButton variant="ghost" size="xs" onClick={() => setEditing(false)} aria-label={t("common.close")}>
          <X size={14} />
        </GlassButton>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <p className="text-[11px] text-slate-400">{t("studio.hint")}</p>
        {!master && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-400/10 px-3 py-2 text-amber-200">
            {t("studio.masterOff")}
            <GlassButton size="xs" onClick={() => setPrefs({ widgets: true })}>
              {t("studio.turnOn")}
            </GlassButton>
          </div>
        )}
        {items.map((w) => (
          <div key={w.id} className={`glass-soft space-y-2 rounded-xl p-3 ${w.enabled ? "" : "opacity-60"}`}>
            <div className="flex items-center gap-2">
              <span className="text-slate-300">{WIDGET_META[w.id].icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-100">{t(WIDGET_META[w.id].title)}</span>
                <span className="block truncate text-[10px] text-slate-400">{t(WIDGET_META[w.id].desc)}</span>
              </span>
              <GlassSwitch checked={w.enabled} onChange={(v) => update(w.id, { enabled: v })} label={undefined} />
            </div>
            {w.enabled && (
              <div className="flex flex-wrap items-center gap-2">
                <Segmented value={w.slot} onChange={(slot) => move(w.id, slot, null)} options={slots} />
                <Segmented value={w.size} onChange={(size) => update(w.id, { size })} options={sizes} />
                <span className="ml-auto flex">
                  <GlassButton variant="ghost" size="xs" onClick={() => nudge(w.id, -1)} aria-label={t("common.moveUp")} title={t("common.moveUp")}>
                    <ChevronUp size={13} />
                  </GlassButton>
                  <GlassButton variant="ghost" size="xs" onClick={() => nudge(w.id, 1)} aria-label={t("common.moveDown")} title={t("common.moveDown")}>
                    <ChevronDown size={13} />
                  </GlassButton>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
      <footer className="flex justify-end border-t border-white/10 px-4 py-3">
        <GlassButton onClick={reset}>
          <RotateCcw size={12} /> {t("studio.resetLayout")}
        </GlassButton>
      </footer>
    </aside>
  );
}
