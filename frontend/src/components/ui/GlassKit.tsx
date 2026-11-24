import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { X } from "lucide-react";

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
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <span className={`inline-flex items-center gap-2 ${disabled ? "opacity-40" : ""} ${className}`}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === "string" ? label : undefined}
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

/** Range slider with a label and the current value (or `display`) on the right. */
export function GlassSlider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  display,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label: ReactNode;
  display?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`block text-[11px] text-slate-400 ${disabled ? "opacity-40" : ""}`}>
      <span className="mb-1 flex justify-between gap-2">
        <span>{label}</span>
        <span className="text-slate-100 tabular-nums">{display ?? value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer accent-sky-400 disabled:cursor-not-allowed"
        aria-label={typeof label === "string" ? label : undefined}
      />
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
        className={`glass-panel relative flex max-h-full w-full flex-col overflow-hidden transition-all duration-300 ${width} ${
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
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton variant="danger" disabled={!ok || busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
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
