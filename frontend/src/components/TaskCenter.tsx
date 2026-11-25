import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { usePoll } from "../lib/hooks";
import type { HostTask, JobProgress, TaskState } from "../lib/types";
import { useTranslation } from "../i18n";
import { OperationProgressCard } from "./ui/OperationProgressCard";

export const TASK_BADGE: Record<TaskState, { label: string; tone: string }> = {
  running: { label: "Running", tone: "bg-sky-400/15 text-sky-300" },
  ok: { label: "OK", tone: "bg-emerald-400/15 text-emerald-300" },
  error: { label: "Error", tone: "bg-rose-500/15 text-rose-300" },
};

const LABELS: Record<string, string> = {
  vzcreate: "Create container",
  vzstart: "Start container",
  vzstop: "Stop container",
  vzshutdown: "Shut down container",
  vzreboot: "Reboot container",
  vzdestroy: "Destroy container",
  qmstart: "Start VM",
  qmstop: "Stop VM",
  qmshutdown: "Shut down VM",
  qmreboot: "Reboot VM",
  qmsnapshot: "VM snapshot",
  vncproxy: "Console",
  vncshell: "Shell",
  aptupdate: "Update package lists",
  download: "Download",
  qmcreate: "Create VM",
  qmrestore: "Restore VM",
  vzrestore: "Restore container",
  vzdump: "Backup",
  imgdel: "Delete volume",
};

/** Live host task log; polls while the task runs. */
export function TaskLog({ upid, onDone, className = "h-48" }: { upid: string; onDone?: (s: TaskState) => void; className?: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState("");
  const pre = useRef<HTMLPreElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = encodeURIComponent(upid);
    const tick = async () => {
      try {
        const [s, l] = await Promise.all([
          api<{ state: TaskState }>(`/v1/tasks/${id}/status`),
          api<{ lines: string[] }>(`/v1/tasks/${id}/log`),
        ]);
        if (stop) return;
        setLines(l.lines);
        if (s.state === "running") timer = setTimeout(tick, 2000);
        else done.current?.(s.state);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [upid]);

  useEffect(() => {
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, [lines]);

  return (
    <pre ref={pre} className={`overflow-auto rounded-lg bg-black/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-slate-300 ${className}`}>
      {lines.join("\n") || "Waiting for output…"}
      {error && `\n${error}`}
    </pre>
  );
}

/** Progress of a running backup task, read from the `INFO:  45% (…)` lines its log prints (when it prints them). */
function BackupPercent({ upid }: { upid: string }) {
  const [pct, setPct] = useState<number | null>(null);
  const poll = useCallback(() => {
    api<{ lines: string[] }>(`/v1/tasks/${encodeURIComponent(upid)}/log`).then((l) => {
      const m = l.lines.map((x) => /^INFO:\s+(\d{1,3})% \(/.exec(x)).filter(Boolean).pop();
      if (m) setPct(Math.min(100, +m[1]));
    }, () => {});
  }, [upid]);
  usePoll(poll, 3000);
  if (pct === null) return null;
  return (
    <span className="flex items-center gap-2 px-2 pb-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/30">
        <span className="block h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-500 transition-[width] duration-700" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-8 text-right text-[10px] font-bold text-white tabular-nums">{pct}%</span>
    </span>
  );
}

/**
 * Task Center tab of the notifications popover: live progress cards for GPU, App Center, OS update and AI model jobs
 * (GET /api/system/tasks), then recent host tasks, each expandable into its live log (backups with their percentage).
 */
export function TaskCenterPanel({ tasks, jobs, reload }: { tasks: HostTask[]; jobs: JobProgress[]; reload: () => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <ul className="max-h-[60vh] space-y-1 overflow-auto">
      {jobs.map((j) => (
        <li key={j.job_id}>
          <OperationProgressCard compact title={j.subject ? `${t(`progress.kind.${j.kind}`)} · ${j.subject}` : t(`progress.kind.${j.kind}`)} progress={j} />
        </li>
      ))}
      {tasks.length === 0 && jobs.length === 0 && <li className="px-2 py-4 text-center text-slate-400">{t("notif.noTasks")}</li>}
      {tasks.map((task) => {
        const b = TASK_BADGE[task.state];
        const isOpen = expanded === task.upid;
        return (
          <li key={task.upid} className="rounded-lg bg-white/5">
            <button onClick={() => setExpanded(isOpen ? null : task.upid)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/5" aria-expanded={isOpen}>
              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-slate-100">
                  {LABELS[task.type] ?? task.type}
                  {task.id && <span className="text-slate-400"> · {task.id}</span>}
                </span>
                <span className="block truncate text-[10px] text-slate-500">
                  {new Date(task.starttime * 1000).toLocaleString()} · {task.user}
                </span>
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${b.tone}`} title={task.status}>
                {b.label}
              </span>
            </button>
            {task.type === "vzdump" && task.state === "running" && <BackupPercent upid={task.upid} />}
            {isOpen && (
              <div className="px-2 pb-2">
                <p className="mb-1 truncate font-mono text-[10px] text-slate-500" title={task.upid}>
                  {task.upid}
                </p>
                <TaskLog upid={task.upid} onDone={reload} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
