import { useEffect, useId, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../i18n";

/* Liquid Glass primitives. Surfaces, rims and press physics live in index.css (.glass-btn, .glass-field, …). */

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "glass-btn glass-btn-primary text-white",
  secondary: "glass-btn text-slate-100",
  danger: "glass-btn glass-btn-danger text-white",
  ghost: "border border-transparent text-slate-300 hover:bg-white/10 hover:text-white",
};

export function GlassButton({
  variant = "secondary",
  size = "sm",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "xs" | "sm" | "md" }) {
  const pad = size === "xs" ? "px-2 py-1 text-[11px]" : size === "md" ? "px-4 py-2 text-sm" : "px-3 py-1.5 text-xs";
  return (
    <button
      type={type}
      className={`relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[transform,background-color,box-shadow,filter] duration-150 select-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 ${pad} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

export function GlassSwitch({
  checked,
  onChange,
  label,
  disabled,
  className = "",
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
}) {
  const id = useId();
  return (
    <span className={`inline-flex items-center gap-2 ${disabled ? "opacity-40" : ""} ${className}`}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`glass-switch ${checked ? "is-on" : ""}`}
      >
        <span className="glass-switch-thumb" />
      </button>
      {label && (
        <label htmlFor={id} className="cursor-pointer text-xs text-slate-200 select-none">
          {label}
        </label>
      )}
    </span>
  );
}

/** Liquid Glass checkbox: a native input (keyboard + screen readers) styled as a small frosted square. */
export function GlassCheckbox({ checked, onChange, label, className = "" }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; className?: string }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-300 select-none ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer appearance-none rounded border border-white/25 bg-white/10 transition checked:border-sky-300/70 checked:bg-sky-400/80 checked:bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2016%2016%22%3E%3Cpath%20d=%22M4%208.5l2.5%202.5L12%205.5%22%20fill=%22none%22%20stroke=%22white%22%20stroke-width=%222%22/%3E%3C/svg%3E')] focus-visible:ring-2 focus-visible:ring-sky-300/60 focus-visible:outline-none"
      />
      {label}
    </label>
  );
}

export function GlassInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`glass-field ${className}`} {...rest} />;
}

export function GlassSelect({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`glass-field pr-7 ${className}`} {...rest}>
      {children}
    </select>
  );
}

/** Liquid Glass range slider with a live numeric readout; the filled part of the track follows the value. */
export function GlassSlider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "px",
  onChange,
  display,
  disabled,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  /** Readout text instead of `value + unit` (e.g. a slider over named steps); also hides the min/max row. */
  display?: ReactNode;
  disabled?: boolean;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <label className={`block select-none ${disabled ? "opacity-40" : ""}`}>
      <span className="mb-1.5 flex items-center justify-between text-[11px] text-slate-300">
        <span>{label}</span>
        <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-medium text-white tabular-nums ring-1 ring-white/10 ring-inset">
          {display ?? `${value}${unit}`}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="glass-slider w-full disabled:cursor-not-allowed"
        style={{ "--fill": fill } as CSSProperties}
        aria-valuetext={typeof display === "string" ? display : `${value}${unit}`}
      />
      {display === undefined && (
      <span className="mt-0.5 flex justify-between text-[10px] text-slate-500 tabular-nums">
        <span>
          {min}
          {unit}
        </span>
        <span>
          {max}
          {unit}
        </span>
      </span>
      )}
    </label>
  );
}

/** Labeled form field wrapper. */
export function Field({ label, hint, children, className = "" }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-[11px] text-slate-400 ${className}`}>
      <span className="mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-slate-500">{hint}</span>}
    </label>
  );
}

type Tone = "success" | "warning" | "danger" | "info" | "neutral";
const TONES: Record<Tone, string> = {
  success: "text-emerald-200 bg-emerald-400/15 ring-emerald-300/25",
  warning: "text-amber-200 bg-amber-400/15 ring-amber-300/25",
  danger: "text-rose-200 bg-rose-500/15 ring-rose-300/25",
  info: "text-sky-200 bg-sky-400/15 ring-sky-300/25",
  neutral: "text-slate-300 bg-white/[0.06] ring-white/10",
};

export const healthTone = (h?: string): Tone =>
  !h ? "neutral" : /ONLINE|PASSED|OK/i.test(h) ? "success" : /DEGRADED|UNKNOWN/i.test(h) ? "warning" : "danger";

export function GlassBadge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ring-1 ring-inset ${TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

/**
 * Modal scoped to its window: windows always carry a CSS transform, so `fixed` resolves against the window frame.
 * `side` renders a right-hand drawer instead of a centered dialog.
 */
export function GlassModal({
  open,
  onClose,
  title,
  children,
  footer,
  side = false,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  side?: boolean;
  width?: string;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!open) return setShown(false);
    const r = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`fixed inset-0 z-50 flex ${side ? "justify-end" : "items-center justify-center p-4"}`}>
      <div className={`absolute inset-0 bg-black/45 backdrop-blur-[2px] transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={`glass-panel relative flex max-h-full w-full flex-col overflow-hidden transition-[opacity,translate,scale] duration-300 ${width} ${
          side ? `h-full rounded-none rounded-l-2xl ${shown ? "translate-x-0" : "translate-x-8 opacity-0"}` : `rounded-2xl ${shown ? "scale-100 opacity-100" : "scale-95 opacity-0"}`
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)" }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-3">
          <h3 className="flex-1 truncate text-sm font-semibold text-white">{title}</h3>
          <GlassButton variant="ghost" size="xs" onClick={onClose} aria-label="Close dialog">
            <X size={14} />
          </GlassButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <footer className="flex shrink-0 justify-end gap-2 border-t border-white/10 px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Destructive-action dialog; with `expect`, the user must type that exact text (device path, pool name, …). */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  expect,
  confirmLabel = "Confirm",
  busy,
  error,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  expect?: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [open]);
  const ok = !expect || typed === expect;
  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="danger" disabled={!ok || busy} onClick={onConfirm}>
            {busy ? t("common.working") : confirmLabel}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3 text-xs text-slate-300">
        <div>{message}</div>
        {children}
        {expect && (
          <Field label={<>Type <span className="font-mono text-rose-200">{expect}</span> to confirm</>}>
            <GlassInput className="w-full font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
          </Field>
        )}
        {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-rose-300">{error}</p>}
      </div>
    </GlassModal>
  );
}

/** Segmented control (tabs / topology pickers). */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode }[] }) {
  return (
    <div className="glass-field inline-flex gap-0.5 p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${value === o.id ? "bg-white/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]" : "text-slate-400 hover:text-slate-200"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-rose-400/20 ring-inset">{error}</p>;
  if (notice) return <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 ring-1 ring-emerald-400/20 ring-inset">{notice}</p>;
  return null;
}
