import { useState } from "react";
import { ChevronDown, ChevronRight, GraduationCap, Layers, Lightbulb, Radio } from "lucide-react";
import { OSI_COMPONENTS, OSI_LAYERS, type OsiKind, type OsiLayer, type OsiValues } from "../../data/osiModelRegistry";
import { useTranslation } from "../../i18n";
import { GlassButton, GlassModal } from "../ui/GlassKit";

/** What the OSI views inspect: a component kind, its display name and its live per-layer values. */
export interface OsiTarget {
  kind: OsiKind;
  name: string;
  values?: OsiValues;
}

const roleOf = (kind: OsiKind, n: OsiLayer) => (OSI_COMPONENTS[kind].primary.includes(n) ? "primary" : OSI_COMPONENTS[kind].encap.includes(n) ? "encap" : null);
const Chip = ({ text }: { text: string }) => (
  <span className="rounded-md border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-input)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--sd-text-primary)]">{text}</span>
);

/** The 7-layer stack (L7 on top) with a Junior IT learning card for the clicked layer and the data-flow walkthrough. */
export function OsiArchitecturePanel({ kind, name, values = {}, initialLayer }: OsiTarget & { initialLayer?: OsiLayer }) {
  const { t } = useTranslation();
  const c = OSI_COMPONENTS[kind];
  const [open, setOpen] = useState<OsiLayer | null>(initialLayer ?? c.primary[0] ?? null);
  const flow = OSI_LAYERS.filter((l) => c.roles[l.n]).reverse();
  return (
    <div className="space-y-3 text-xs text-[var(--sd-text-secondary)]">
      <div className="flex items-start gap-2">
        <Layers size={16} className="mt-0.5 shrink-0 text-[var(--sd-accent-primary)]" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--sd-text-primary)]">
            {name} <span className="font-normal text-[var(--sd-text-muted)]">· {t(c.name)}</span>
          </div>
          <p className="text-[11px]">{t(c.summary)}</p>
          <p className="mt-1 text-[11px] text-[var(--sd-text-muted)]">{t("osi.intro")}</p>
        </div>
      </div>
      <ol className="space-y-1.5" aria-label={t("osi.title")}>
        {OSI_LAYERS.map((l) => {
          const role = roleOf(kind, l.n);
          const live = values[l.n] ?? [];
          const isOpen = open === l.n;
          return (
            <li key={l.n}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : l.n)}
                className={`flex w-full flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-left transition ${
                  role === "primary"
                    ? "border-[var(--sd-accent-primary)] bg-[var(--sd-surface-card)] shadow-[0_0_12px_var(--sd-accent-glow)]"
                    : role === "encap"
                      ? "border-dashed border-[var(--sd-accent-border,var(--sd-border-hairline))] bg-[var(--sd-surface-card)]"
                      : "border-[var(--sd-border-hairline)] opacity-60 hover:opacity-90"
                }`}
              >
                {isOpen ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
                <span className={`w-7 shrink-0 font-mono text-[11px] font-bold ${role ? "text-[var(--sd-accent-primary)]" : ""}`}>L{l.n}</span>
                <span className="min-w-24 font-semibold text-[var(--sd-text-primary)]">{t(l.name)}</span>
                <span className="text-[10px] text-[var(--sd-text-muted)]">{t("osi.pdu", { pdu: t(l.pdu) })}</span>
                {role && (
                  <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold tracking-wide uppercase ring-1 ring-inset ${role === "primary" ? "bg-[var(--sd-accent-glow)] text-[var(--sd-text-primary)] ring-[var(--sd-accent-primary)]" : "text-[var(--sd-text-secondary)] ring-[var(--sd-border-hairline)]"}`}>
                    {t(role === "primary" ? "osi.primary" : "osi.encap")}
                  </span>
                )}
                <span className="ml-auto flex flex-wrap justify-end gap-1">
                  {live.map((v) => (
                    <Chip key={v} text={v} />
                  ))}
                </span>
              </button>
              {isOpen && (
                <div className="mt-1.5 ml-4 grid gap-3 rounded-xl border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-panel)] p-3 md:grid-cols-3" role="region" aria-label={`L${l.n} ${t(l.name)}`}>
                  <section className="space-y-1">
                    <h5 className="flex items-center gap-1 font-semibold text-[var(--sd-text-primary)]">
                      <GraduationCap size={13} /> {t("osi.card.general")}
                    </h5>
                    <p>{t(l.what)}</p>
                    <p className="text-[10px] text-[var(--sd-text-muted)]">
                      {t("osi.protocols")}: <span className="font-mono">{l.protocols}</span>
                    </p>
                  </section>
                  <section className="space-y-1">
                    <h5 className="flex items-center gap-1 font-semibold text-[var(--sd-text-primary)]">
                      <Radio size={13} /> {t("osi.card.here", { name })}
                    </h5>
                    <p>{c.roles[l.n] ? t(c.roles[l.n]!) : t("osi.card.notHere", { name })}</p>
                    {live.length > 0 && (
                      <p className="flex flex-wrap items-center gap-1 text-[10px]">
                        {t("osi.card.live")}:{" "}
                        {live.map((v) => (
                          <Chip key={v} text={v} />
                        ))}
                      </p>
                    )}
                  </section>
                  <section className="space-y-1">
                    <h5 className="flex items-center gap-1 font-semibold text-[var(--sd-text-primary)]">
                      <Lightbulb size={13} /> {t("osi.card.tip")}
                    </h5>
                    <p>{t(l.tip)}</p>
                  </section>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <section className="rounded-xl border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-card)] p-3">
        <h5 className="mb-1 font-semibold text-[var(--sd-text-primary)]">{t("osi.flow")}</h5>
        <p className="mb-2 text-[11px] text-[var(--sd-text-muted)]">{t("osi.flowHint")}</p>
        <ol className="space-y-1">
          {flow.map((l, i) => (
            <li key={l.n} className="flex gap-2">
              <span className="w-5 shrink-0 text-right font-mono text-[var(--sd-text-muted)]">{i + 1}.</span>
              <span className="w-7 shrink-0 font-mono font-bold text-[var(--sd-accent-primary)]">L{l.n}</span>
              <span>{t(c.roles[l.n]!)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** Compact inline pills (L1 … L7) of a component's active layers; clicking one opens its OSI breakdown. */
export function OsiLayerBadgeStrip({ kind, onClick }: { kind: OsiKind; onClick?: (layer: OsiLayer) => void }) {
  const { t } = useTranslation();
  const c = OSI_COMPONENTS[kind];
  const layers = OSI_LAYERS.filter((l) => roleOf(kind, l.n)).reverse();
  return (
    <span className="inline-flex flex-wrap items-center gap-1" aria-label={t("osi.strip", { layers: layers.map((l) => `L${l.n}`).join(", ") })}>
      {layers.map((l) => {
        const cls = `rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold ring-1 ring-inset ${c.primary.includes(l.n) ? "bg-[var(--sd-accent-glow)] text-[var(--sd-text-primary)] ring-[var(--sd-accent-primary)]" : "text-[var(--sd-text-secondary)] ring-[var(--sd-border-hairline)]"}`;
        return onClick ? (
          <button key={l.n} type="button" className={`${cls} hover:brightness-125`} title={`L${l.n} ${t(l.name)}`} aria-label={`${t("osi.open")}: L${l.n} ${t(l.name)}`} onClick={() => onClick(l.n)}>
            L{l.n}
          </button>
        ) : (
          <span key={l.n} className={cls} title={`L${l.n} ${t(l.name)}`}>
            L{l.n}
          </span>
        );
      })}
    </span>
  );
}

/** The OSI breakdown in a dialog. */
export function OsiModal({ target, layer, onClose }: { target: OsiTarget | null; layer?: OsiLayer; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <GlassModal open={!!target} onClose={onClose} width="max-w-4xl" title={target ? t("osi.openFor", { name: target.name }) : ""}>
      {target && <OsiArchitecturePanel key={`${target.kind}${target.name}${layer ?? ""}`} {...target} initialLayer={layer} />}
    </GlassModal>
  );
}

/** "OSI Architecture" button with its badge strip; opens the breakdown in a dialog. */
export function OsiButton({ size = "xs", strip = false, ...target }: OsiTarget & { size?: "xs" | "sm"; strip?: boolean }) {
  const { t } = useTranslation();
  const [layer, setLayer] = useState<OsiLayer | null | undefined>(undefined);
  return (
    <>
      <GlassButton size={size} onClick={() => setLayer(null)} aria-label={t("osi.openFor", { name: target.name })}>
        <Layers size={12} /> {t("osi.open")}
      </GlassButton>
      {strip && <OsiLayerBadgeStrip kind={target.kind} onClick={setLayer} />}
      <OsiModal target={layer === undefined ? null : target} layer={layer ?? undefined} onClose={() => setLayer(undefined)} />
    </>
  );
}

/** An expandable inline "OSI Architecture" section for inspectors and settings tabs. */
export function OsiDisclosure(target: OsiTarget) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--sd-border-hairline)] bg-[var(--sd-surface-card)]">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--sd-text-primary)]">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Layers size={13} className="text-[var(--sd-accent-primary)]" />
        {open ? t("osi.hide") : t("osi.show")}
        <span className="ml-auto">
          <OsiLayerBadgeStrip kind={target.kind} />
        </span>
      </button>
      {open && <div className="border-t border-[var(--sd-border-hairline)] p-3">{<OsiArchitecturePanel {...target} />}</div>}
    </div>
  );
}
