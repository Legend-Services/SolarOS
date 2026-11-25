import { useEffect, useState } from "react";
import { edition } from "@edition";
import { Bug, ChevronDown, Copy, ExternalLink, Send } from "lucide-react";
import { api } from "../lib/api";
import { useRunner } from "../lib/hooks";
import { useBugReport } from "../lib/stores";
import { Field, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice } from "./ui/GlassKit";

const CATEGORIES = ["UI & Desktop", "Storage & ZFS", "VMs & Containers", "Network & VPN", "Hardware & GPU", "Installer & Updates"] as const;

interface Diagnostics {
  solardeck_version: string | null;
  solardeck_tag: string | null;
  commit: string | null;
  platform_version: string | null;
  kernel: string;
  cpu: string;
  memory_gb: number | null;
  logs: string[];
}

interface SubmitResult {
  submitted: boolean;
  issue_url: string | null;
  error: string | null;
  pre_filled_url: string | null;
  markdown_body: string;
}

const EMPTY = { category: CATEGORIES[0] as string, title: "", description: "", steps_to_reproduce: "", include_diagnostics: true, github_token: "" };
const area = "glass-field w-full resize-y py-2 leading-relaxed";

export default function BugReportModal() {
  const { open, set } = useBugReport();
  const [f, setF] = useState(EMPTY);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [preview, setPreview] = useState(false);
  const [sent, setSent] = useState("");
  const { busy, error, notice, run, setError } = useRunner();

  useEffect(() => {
    if (open && !diag) api<Diagnostics>("/system/bug-report/diagnostics").then(setDiag, () => {});
  }, [open, diag]);

  const close = () => (set(false), setError(""), setSent(""));
  const payload = () => ({ ...f, github_token: f.github_token || null, user_agent: navigator.userAgent });
  const valid = f.title.trim().length >= 3 && f.description.trim().length > 0;

  const copy = () =>
    run(async () => {
      const r = await api<SubmitResult>("/system/bug-report", { method: "POST", json: { ...payload(), github_token: null } });
      await navigator.clipboard.writeText(`# [${f.category}] ${f.title}\n\n${r.markdown_body}`);
    }, "Report copied to the clipboard as Markdown.");

  const submit = () => {
    setSent("");
    // Open the tab synchronously, before the request, so the browser's popup blocker allows it.
    const tab = f.github_token ? null : window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    return run(async () => {
      try {
        const r = await api<SubmitResult>("/system/bug-report", { method: "POST", json: payload() });
        if (r.submitted && r.issue_url) {
          setF(EMPTY);
          return setSent(`Issue created: ${r.issue_url}`);
        }
        if (!r.pre_filled_url) throw new Error(r.error || "The update source is not a GitHub repository; use Copy Report Markdown.");
        if (tab) tab.location.href = r.pre_filled_url;
        else window.open(r.pre_filled_url, "_blank", "noopener");
        setSent(`${r.error ? `${r.error} ` : ""}GitHub opened in a new tab with your report filled in. Review it and click "Submit new issue".`);
      } catch (e) {
        tab?.close();
        throw e;
      }
    });
  };

  return (
    <GlassModal
      open={open}
      onClose={close}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          <Bug size={16} /> Report a Bug
        </span>
      }
      footer={
        <>
          <GlassButton variant="ghost" onClick={close}>
            Cancel
          </GlassButton>
          <GlassButton disabled={busy || !valid} onClick={copy}>
            <Copy size={13} /> Copy Report Markdown
          </GlassButton>
          <GlassButton variant="primary" disabled={busy || !valid} onClick={submit}>
            {f.github_token ? <Send size={13} /> : <ExternalLink size={13} />} Submit to GitHub
          </GlassButton>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
          <Field label="Category">
            <GlassSelect className="w-full" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </GlassSelect>
          </Field>
          <Field label="Title">
            <GlassInput className="w-full" maxLength={200} placeholder="Short summary, e.g. Dock icons overlap after resizing" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </Field>
        </div>
        <Field label="What happened?" hint="What you expected, and what you saw instead.">
          <textarea className={area} rows={4} maxLength={10000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Steps to reproduce" hint="Optional. Numbered steps help us find the bug fast.">
          <textarea className={area} rows={3} maxLength={10000} placeholder={"1. Open Storage Manager\n2. Click …"} value={f.steps_to_reproduce} onChange={(e) => setF({ ...f, steps_to_reproduce: e.target.value })} />
        </Field>
        <div className="glass-soft rounded-xl p-3">
          <div className="flex items-center gap-2">
            <GlassSwitch checked={f.include_diagnostics} onChange={(v) => setF({ ...f, include_diagnostics: v })} label="Attach anonymized system diagnostics" />
            <button type="button" className="ml-auto flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200" onClick={() => setPreview((v) => !v)} aria-expanded={preview}>
              Preview <ChevronDown size={12} className={preview ? "rotate-180" : ""} />
            </button>
          </div>
          {preview && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">
              {diag
                ? [
                    `SolarDeck ${diag.solardeck_version ?? "?"} (${diag.solardeck_tag ?? "untagged"}, ${diag.commit ?? "?"})`,
                    `${edition.platformLabel} ${diag.platform_version ?? "?"} · kernel ${diag.kernel}`,
                    `${diag.cpu} · ${diag.memory_gb ?? "?"} GB RAM`,
                    `Browser: ${navigator.userAgent}`,
                    "",
                    ...diag.logs,
                  ].join("\n")
                : "Loading…"}
            </pre>
          )}
          <p className="mt-2 text-[11px] text-slate-500">IP addresses, passwords, tokens, JWTs and SSH keys are removed before anything leaves this server.</p>
        </div>
        <Field label="GitHub token (optional)" hint="Posts the issue directly. Leave empty to open a pre-filled issue in your browser instead. Not stored.">
          <GlassInput type="password" className="w-full font-mono" autoComplete="off" value={f.github_token} onChange={(e) => setF({ ...f, github_token: e.target.value })} />
        </Field>
        <Notice error={error} notice={notice || sent} />
      </div>
    </GlassModal>
  );
}
