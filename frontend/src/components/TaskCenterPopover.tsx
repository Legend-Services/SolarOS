import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListChecks, LoaderCircle } from "lucide-react";
import { api } from "../lib/api";
import type { PveTask, TaskState } from "../lib/types";
import { useDismiss, usePoll } from "../lib/hooks";

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

/** Live PVE task log; polls while the task runs. */
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

export default function TaskCenterPopover({ up = false }: { up?: boolean }) {
  const [tasks, setTasks] = useState<PveTask[]>([]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const load = useCallback(() => {
    api<PveTask[]>("/v1/tasks").then(setTasks).catch(() => {});
  }, []);
  usePoll(load, open ? 3000 : 8000);

  const running = tasks.filter((t) => t.state === "running").length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center rounded-md p-1 text-slate-200 hover:bg-white/10"
        aria-expanded={open}
        aria-label={running ? `${running} background task(s) running` : "Background tasks"}
        title="Background tasks"
      >
        {running ? <LoaderCircle size={15} className="animate-spin text-sky-300" /> : <ListChecks size={15} />}
        {running > 0 && <span className="absolute -top-0.5 -right-0.5 rounded-full bg-sky-500 px-1 text-[9px] leading-tight text-white">{running}</span>}
      </button>
      {open && (
        <div className={`glass absolute ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"} right-0 w-[min(26rem,calc(100vw-1rem))] rounded-xl p-2 shadow-2xl`}>
          <div className="flex items-center justify-between px-2 pb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            <span>Task Center</span>
            <span>{running ? `${running} running` : "Idle"}</span>
          </div>
          <ul className="max-h-[60vh] space-y-1 overflow-auto">
            {tasks.length === 0 && <li className="px-2 py-4 text-center text-slate-400">No recent tasks.</li>}
            {tasks.map((t) => {
              const b = TASK_BADGE[t.state];
              const isOpen = expanded === t.upid;
              return (
                <li key={t.upid} className="rounded-lg bg-white/5">
                  <button
                    onClick={() => setExpanded(isOpen ? null : t.upid)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/5"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-slate-100">
                        {LABELS[t.type] ?? t.type}
                        {t.id && <span className="text-slate-400"> · {t.id}</span>}
                      </span>
                      <span className="block truncate text-[10px] text-slate-500">
                        {new Date(t.starttime * 1000).toLocaleString()} · {t.user}
                      </span>
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${b.tone}`} title={t.status}>
                      {b.label}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-2 pb-2">
                      <p className="mb-1 truncate font-mono text-[10px] text-slate-500" title={t.upid}>
                        {t.upid}
                      </p>
                      <TaskLog upid={t.upid} onDone={load} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
