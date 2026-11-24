import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Disc3, Download, Package, RefreshCw, Trash2, Upload } from "lucide-react";
import { api, uploadIso } from "../lib/api";
import { useDriver } from "../store/capabilitiesStore";
import type { StorageVolume } from "../lib/types";
import { bytes } from "../lib/format";
import { useRunner } from "../lib/hooks";
import { useTelemetry } from "../lib/stores";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassSelect, Notice, Segmented } from "../components/ui/GlassKit";
import { TaskLog } from "../components/TaskCenterPopover";

type Content = "iso" | "vztmpl";

/** ISO images and container templates across all active storages, with download-from-URL. */
export default function IsoLibrary() {
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const [content, setContent] = useState<Content>("iso");
  const [items, setItems] = useState<StorageVolume[] | null>(null);
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [store, setStore] = useState("");
  const [task, setTask] = useState<string | null>(null);
  const [del, setDel] = useState<StorageVolume | null>(null);
  const { busy, error, notice, run } = useRunner();
  const [progress, setProgress] = useState<number | null>(null);
  // Only the native driver streams uploads into its own storage; other platforms upload through their own tools.
  const canUpload = useDriver() === "native_ubuntu" && content === "iso";
  const stores = targets.filter((t) => t.active && t.content.split(",").includes(content)).map((t) => t.storage);
  const storeKey = stores.join(",");

  const load = useCallback(() => {
    if (!storeKey) return setItems([]);
    Promise.all(storeKey.split(",").map((s) => api<StorageVolume[]>(`/v1/storage/${s}/content?content=${content}`).catch(() => [])))
      .then((l) => setItems(l.flat().sort((a, b) => b.ctime - a.ctime)));
  }, [content, storeKey]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!stores.includes(store)) setStore(stores[0] ?? "");
  }, [storeKey, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ upid: string }>(`/v1/storage/${store}/download-url`, { method: "POST", json: { url, content, filename: filename || undefined } });
      setTask(r.upid);
      setUrl("");
      setFilename("");
    });
  };
  const upload = (file: File | undefined) =>
    file &&
    run(async () => {
      setProgress(0);
      try {
        await uploadIso(store, file, setProgress);
      } finally {
        setProgress(null);
      }
      load();
    }, `${file.name} uploaded.`);
  const remove = () =>
    del &&
    run(() => api(`/v1/storage/${del.storage}/content?volume=${encodeURIComponent(del.volid)}`, { method: "DELETE" }).then(() => (setDel(null), setTimeout(load, 1500))), "Volume deleted.");

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Segmented
          value={content}
          onChange={setContent}
          options={[
            { id: "iso", label: "ISO images" },
            { id: "vztmpl", label: "Container templates" },
          ]}
        />
        <GlassButton variant="ghost" size="xs" className="ml-auto" onClick={load} aria-label="Refresh">
          <RefreshCw size={13} />
        </GlassButton>
      </div>

      <form onSubmit={download} className="glass-soft grid gap-2 rounded-2xl p-3 sm:grid-cols-[1fr_180px_140px_auto] sm:items-end">
        <Field label={`Download ${content === "iso" ? "an ISO" : "a template"} from URL`}>
          <GlassInput className="w-full" type="url" required placeholder="https://releases.ubuntu.com/24.04/ubuntu-24.04-live-server-amd64.iso" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="File name (optional)">
          <GlassInput className="w-full" placeholder="from URL" value={filename} onChange={(e) => setFilename(e.target.value)} />
        </Field>
        <Field label="Target storage">
          <GlassSelect className="w-full" value={store} onChange={(e) => setStore(e.target.value)}>
            {!stores.length && <option value="">None</option>}
            {stores.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </GlassSelect>
        </Field>
        <GlassButton type="submit" variant="primary" disabled={busy || !store || !url}>
          <Download size={13} /> Download
        </GlassButton>
      </form>
      {canUpload && (
        <div className="glass-soft flex flex-wrap items-center gap-3 rounded-2xl p-3">
          <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-sky-500/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 ${busy || !store ? "pointer-events-none opacity-50" : ""}`}>
            <Upload size={13} /> Upload ISO from this computer
            <input type="file" accept=".iso,.img" className="sr-only" disabled={busy || !store} onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ""))} />
          </label>
          <span className="text-[11px] text-slate-400">For installers you cannot download by URL, such as Windows. The file goes to {store || "local"}.</span>
          {progress !== null && (
            <div className="flex w-full items-center gap-2" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-sky-400 transition-[width]" style={{ width: `${progress}%` }} />
              </div>
              <span className="w-10 text-right text-[11px] text-slate-300">{progress}%</span>
            </div>
          )}
        </div>
      )}
      {task && <TaskLog upid={task} className="h-28" onDone={(s) => s !== "running" && load()} />}
      <Notice error={error} notice={notice} />

      <table className="w-full text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="py-1.5 font-medium">Name</th>
            <th className="px-2 font-medium">Storage</th>
            <th className="px-2 font-medium">Size</th>
            <th className="px-2 font-medium">Added</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items === null && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-slate-400">
                Loading…
              </td>
            </tr>
          )}
          {items?.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-slate-400">
                No {content === "iso" ? "ISO images" : "templates"} on {stores.join(", ") || "any active storage"}.
              </td>
            </tr>
          )}
          {items?.map((v) => (
            <tr key={v.volid} className="border-t border-white/5">
              <td className="py-2">
                <span className="flex items-center gap-2 text-slate-100">
                  {content === "iso" ? <Disc3 size={14} className="text-sky-300" /> : <Package size={14} className="text-violet-300" />}
                  <span className="truncate">{v.volid.split("/").pop()}</span>
                  {v.protected && <GlassBadge>PROTECTED</GlassBadge>}
                </span>
              </td>
              <td className="px-2 text-slate-300">{v.storage}</td>
              <td className="px-2 text-slate-300 tabular-nums">{bytes(v.size)}</td>
              <td className="px-2 text-slate-400">{v.ctime ? new Date(v.ctime * 1000).toLocaleDateString() : "—"}</td>
              <td className="text-right">
                <GlassButton variant="ghost" size="xs" onClick={() => setDel(v)} aria-label={`Delete ${v.volid}`}>
                  <Trash2 size={13} className="text-rose-300" />
                </GlassButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={remove}
        busy={busy}
        error={error}
        title="Delete volume"
        confirmLabel="Delete"
        message={<>Permanently delete <span className="font-mono text-slate-100">{del?.volid}</span>?</>}
      />
    </div>
  );
}
