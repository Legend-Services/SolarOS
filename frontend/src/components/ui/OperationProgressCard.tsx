import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import { api } from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import type { JobProgress } from "../../lib/types";
import { useTranslation, type TKey } from "../../i18n";
import { en } from "../../i18n/en";
import { GlassBadge, GlassButton } from "./GlassKit";

const TONE = { running: "info", completed: "success", failed: "danger" } as const;
const BAR = { running: "from-sky-400 to-blue-500", completed: "from-emerald-400 to-emerald-500", failed: "from-rose-400 to-rose-600" };

/** `progress.<key>` in the active language if it exists, else `fallback` (the backend's English label). */
export function useProgressText() {
  const { t } = useTranslation();
  return (key: string, fallback: string) => (`progress.${key}` in en ? t(`progress.${key}` as TKey) : fallback);
}

/**
 * Liquid Glass progress card for any long-running job (GPU drivers, App Center installs, OS updates, model pulls):
 * title + status badge, animated 0–100 % bar, current step and step counter, a 4-line log tail that expands to the
 * full log, and Retry / Dismiss on failure. `compact` shows only the bar and step (App Center cards, Task Center rows).
 */
export function OperationProgressCard({
  title,
  progress,
  onRetry,
  onDismiss,
  compact = false,
  className = "",
}: {
  title: string;
  progress: JobProgress;
  onRetry?: () => void;
  onDismiss?: () => void;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const text = useProgressText();
  const [open, setOpen] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const { status } = progress;
  const pct = Math.round(Math.max(0, Math.min(100, progress.progress_percent)));
  const stage = text(progress.stage_key, progress.current_stage);
  const total = Math.max(1, progress.stages.length - 1); // the last stage is "done", not a step
  const step = Math.min(progress.stage_index + 1, total);
  const logs = progress.logs.filter((l) => l.trim());
  // Braces matter: newer Chrome returns a Promise from scroll methods, and React would call it as a cleanup.
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [open, logs.length]);
  return (
    <section className={`glass-soft rounded-xl ${compact ? "p-2" : "p-3"} ${className}`} aria-label={title}>
      <div className="flex items-center gap-2">
        <h4 className={`min-w-0 flex-1 truncate font-semibold text-slate-100 ${compact ? "text-[11px]" : "text-xs"}`} title={title}>
          {title}
        </h4>
        <GlassBadge tone={TONE[status]}>{t(`progress.status.${status}`)}</GlassBadge>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-black/30 shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct}% · ${stage}`}
          aria-label={title}
        >
          <div className={`h-full rounded-full bg-gradient-to-r ${BAR[status]} transition-[width] duration-700 ease-out`} style={{ width: `${pct}%` }} />
        </div>
        <span className={`text-right font-bold text-white tabular-nums ${compact ? "w-9 text-xs" : "w-11 text-sm"}`}>{pct}%</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px]">
        <span className="min-w-0 flex-1 truncate text-slate-300" title={stage}>
          {stage}
        </span>
        <span className="shrink-0 text-slate-500 tabular-nums">{t("progress.step", { step, total })}</span>
      </div>
      {status === "failed" && progress.error_message && <p className="mt-2 text-[11px] break-words text-rose-300">{progress.error_message}</p>}
      {!compact && logs.length > 0 && (
        <>
          <pre ref={pre} className={`mt-2 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-slate-400 ${open ? "max-h-64" : ""}`}>
            {(open ? logs : logs.slice(-4)).join("\n")}
          </pre>
          {logs.length > 4 && (
            <button onClick={() => setOpen((v) => !v)} className="mt-1 flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200" aria-expanded={open}>
              {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {open ? t("progress.hideLog") : t("progress.showLog", { count: logs.length })}
            </button>
          )}
        </>
      )}
      {status === "failed" && (onRetry || onDismiss) && (
        <div className="mt-2 flex justify-end gap-2">
          {onDismiss && (
            <GlassButton size="xs" variant="ghost" onClick={onDismiss}>
              <X size={12} /> {t("progress.dismiss")}
            </GlassButton>
          )}
          {onRetry && (
            <GlassButton size="xs" variant="primary" onClick={onRetry}>
              <RotateCcw size={12} /> {t("progress.retry")}
            </GlassButton>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Polls a progress endpoint that returns JobProgress (or null when the job never ran): loads once on mount, so a run
 * started earlier still shows, then every 2 s while `active` or while the job runs. Calls `onDone(ok)` once when a job
 * finishes while `active`.
 */
export function useJobProgress(url: string, active: boolean, onDone?: (ok: boolean) => void): JobProgress | null {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const last = useRef<JobProgress | null | undefined>(undefined);
  const reported = useRef(false);
  const poll = useCallback(() => {
    const j = last.current;
    if (active || j === undefined || j?.status === "running")
      api<JobProgress | null>(url).then(
        (r) => {
          last.current = r;
          setProgress(r);
        },
        () => {
          last.current ??= null;
        },
      );
  }, [active, url]);
  usePoll(poll, 2000);
  useEffect(() => {
    if (active) reported.current = false;
  }, [active]);
  useEffect(() => {
    if (progress && progress.status !== "running" && active && !reported.current) {
      reported.current = true;
      onDone?.(progress.status === "completed");
    }
  }, [progress, active, onDone]);
  return progress;
}
