import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { GlassBadge } from "./ui/GlassKit";

export interface HostJob {
  name: string;
  running: boolean;
  exit_code: number | null;
  log: string[];
}

/**
 * Live log of a detached host job (`/api/host/jobs/{name}`: GPU drivers, package installs, …).
 * Polls every 2 s while `active` or while the job runs; calls `onDone(ok)` once when it finishes.
 */
export function JobLog({ name, active, onDone, className = "" }: { name: string; active: boolean; onDone?: (ok: boolean) => void; className?: string }) {
  const [job, setJob] = useState<HostJob | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const reported = useRef(false);
  const last = useRef<HostJob | null>(null);
  const poll = useCallback(() => {
    // Load once on mount (shows a run started earlier), then keep polling only while something runs.
    const j = last.current;
    if (active || j === null || j.running)
      api<HostJob>(`/host/jobs/${name}`).then((r) => {
        last.current = r;
        setJob(r);
      }, () => {});
  }, [active, name]);
  usePoll(poll, 2000);
  useEffect(() => {
    if (active) reported.current = false;
  }, [active]);
  useEffect(() => {
    if (job && !job.running && job.exit_code !== null && active && !reported.current) {
      reported.current = true;
      onDone?.(job.exit_code === 0);
    }
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, [job, active, onDone]);
  if (!job || (!job.log.length && !job.running)) return null;
  const state = job.running ? "RUNNING" : job.exit_code === 0 ? "SUCCEEDED" : job.exit_code === null ? "STOPPED" : `FAILED (${job.exit_code})`;
  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
        <span className="font-mono">{name}</span>
        <GlassBadge tone={job.running ? "info" : job.exit_code === 0 ? "success" : "danger"}>{state}</GlassBadge>
      </div>
      <pre ref={pre} className="max-h-56 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">
        {job.log.join("\n") || "Starting…"}
      </pre>
    </div>
  );
}
