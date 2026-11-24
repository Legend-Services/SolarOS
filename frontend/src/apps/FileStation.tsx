import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { api, uploadFiles } from "../lib/api";
import type { FileEntry } from "../lib/types";
import { bytes } from "../lib/format";
import { useIntent } from "../lib/stores";

interface Listing {
  path: string;
  items: FileEntry[];
}

const parentOf = (p: string) => p.replace(/\/[^/]+$/, "") || "/";

/** Lazily-expanded folder tree node. */
function TreeNode({ path, name, depth, current, rev, onOpen }: { path: string; name: string; depth: number; current: string; rev: number; onOpen: (p: string) => void }) {
  const [open, setOpen] = useState(depth === 0 || current.startsWith(path + "/"));
  const [dirs, setDirs] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    if (current.startsWith(path === "/" ? "/" : path + "/")) setOpen(true);
  }, [current, path]);

  useEffect(() => {
    if (!open) return;
    api<Listing>(`/files/list?path=${encodeURIComponent(path)}`)
      .then((l) => setDirs(l.items.filter((i) => i.is_dir)))
      .catch(() => setDirs([]));
    // Re-fetch on navigation/refresh so new or renamed folders appear.
  }, [open, path, current, rev]);

  return (
    <li>
      <button
        onClick={() => {
          onOpen(path);
          setOpen(true);
        }}
        className={`flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-xs ${
          current === path ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5"
        }`}
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        />
        {depth === 0 ? <HardDrive size={13} className="shrink-0 text-emerald-300" /> : <Folder size={13} className="shrink-0 text-amber-300" />}
        <span className="truncate">{name}</span>
      </button>
      {open && dirs && dirs.length > 0 && (
        <ul>
          {dirs.map((d) => (
            <TreeNode key={d.path} path={d.path} name={d.name} depth={depth + 1} current={current} rev={rev} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function FileStation() {
  const [cwd, setCwd] = useState("/");
  const [items, setItems] = useState<FileEntry[] | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [rev, setRev] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const jump = useIntent((s) => s.files);
  const takeIntent = useIntent((s) => s.take);
  useEffect(() => {
    if (jump) (setCwd(jump), takeIntent("files"));
  }, [jump, takeIntent]);

  const load = useCallback(() => {
    api<Listing>(`/files/list?path=${encodeURIComponent(cwd)}`)
      .then((l) => {
        setItems(l.items);
        setError("");
      })
      .catch((e) => {
        setItems([]);
        setError(e.message);
      });
    setSelected(null);
  }, [cwd]);

  useEffect(load, [load, rev]);
  const refresh = () => setRev((r) => r + 1);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newFolder = () => {
    const name = window.prompt("New folder name");
    if (name) act(() => api("/files/mkdir", { method: "POST", json: { path: cwd, name } }));
  };
  const rename = () => {
    if (!selected) return;
    const name = window.prompt("Rename to", selected.name);
    if (name && name !== selected.name) act(() => api("/files/rename", { method: "PATCH", json: { path: selected.path, new_name: name } }));
  };
  const remove = () => {
    if (!selected || !window.confirm(`Delete "${selected.name}"${selected.is_dir ? " and everything inside it" : ""}? This cannot be undone.`)) return;
    act(() => api(`/files/delete?path=${encodeURIComponent(selected.path)}`, { method: "DELETE" }));
  };
  const download = (f: FileEntry) => {
    const a = document.createElement("a");
    a.href = `/api/files/download?path=${encodeURIComponent(f.path)}`;
    a.download = f.name;
    a.click();
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setProgress(0);
    await act(() => uploadFiles(cwd, files, setProgress));
    setProgress(null);
  };
  const openEntry = (f: FileEntry) => (f.is_dir ? setCwd(f.path) : download(f));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    upload(Array.from(e.dataTransfer.files));
  };

  const crumbs = cwd === "/" ? [] : cwd.slice(1).split("/");

  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 overflow-auto border-r border-white/10 bg-black/20 p-2 max-sm:hidden">
        <ul>
          <TreeNode path="/" name="Storage" depth={0} current={cwd} rev={rev} onOpen={setCwd} />
        </ul>
      </aside>

      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={onDrop}
      >
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 p-2">
          <button className="btn" onClick={newFolder}>
            <FolderPlus size={13} /> New Folder
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={progress !== null}>
            <Upload size={13} /> Upload
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              upload(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button className="btn" onClick={() => selected && download(selected)} disabled={!selected || selected.is_dir}>
            <Download size={13} /> Download
          </button>
          <button className="btn" onClick={rename} disabled={!selected}>
            <Pencil size={13} /> Rename
          </button>
          <button className="btn text-rose-300" onClick={remove} disabled={!selected}>
            <Trash2 size={13} /> Delete
          </button>
          <div className="ml-auto flex gap-1">
            <button className="btn" onClick={refresh} aria-label="Refresh">
              <RefreshCw size={13} />
            </button>
            <button className="btn" onClick={() => setView(view === "grid" ? "list" : "grid")} aria-label="Toggle view">
              {view === "grid" ? <List size={13} /> : <LayoutGrid size={13} />}
            </button>
          </div>
        </div>

        {/* Breadcrumbs */}
        <nav className="flex items-center gap-1 overflow-x-auto px-3 py-2 text-xs text-slate-400" aria-label="Breadcrumb">
          <button className="hover:text-white" onClick={() => setCwd("/")}>
            Storage
          </button>
          {crumbs.map((c, i) => {
            const p = "/" + crumbs.slice(0, i + 1).join("/");
            return (
              <span key={p} className="flex items-center gap-1">
                <ChevronRight size={12} />
                <button className={i === crumbs.length - 1 ? "text-white" : "hover:text-white"} onClick={() => setCwd(p)}>
                  {c}
                </button>
              </span>
            );
          })}
        </nav>

        {error && <div className="mx-3 mb-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div>}
        {progress !== null && (
          <div className="mx-3 mb-2">
            <div className="mb-1 text-[11px] text-slate-400">Uploading… {progress}%</div>
            <div className="h-1 overflow-hidden rounded bg-white/10">
              <div className="h-full bg-emerald-400 transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
          {items === null ? (
            <p className="p-4 text-xs text-slate-400">Loading…</p>
          ) : items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
              <Upload size={28} />
              <p className="text-xs">This folder is empty. Drop files here to upload.</p>
            </div>
          ) : view === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
              {cwd !== "/" && (
                <button onDoubleClick={() => setCwd(parentOf(cwd))} className="flex flex-col items-center gap-1 rounded-lg p-2 text-xs text-slate-400 hover:bg-white/5">
                  <Folder size={36} className="text-slate-500" /> ..
                </button>
              )}
              {items.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setSelected(f)}
                  onDoubleClick={() => openEntry(f)}
                  className={`flex flex-col items-center gap-1 rounded-lg p-2 text-xs ${selected?.path === f.path ? "bg-sky-500/20 ring-1 ring-sky-400/50" : "hover:bg-white/5"}`}
                  title={f.name}
                >
                  {f.is_dir ? <Folder size={36} className="text-amber-300" /> : <FileIcon size={36} className="text-slate-300" />}
                  <span className="line-clamp-2 w-full break-all text-slate-200">{f.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1.5 font-medium">Name</th>
                  <th className="px-2 text-right font-medium">Size</th>
                  <th className="px-2 font-medium max-sm:hidden">Modified</th>
                </tr>
              </thead>
              <tbody>
                {cwd !== "/" && (
                  <tr className="cursor-default text-slate-400 hover:bg-white/5" onDoubleClick={() => setCwd(parentOf(cwd))}>
                    <td className="py-1.5" colSpan={3}>
                      ..
                    </td>
                  </tr>
                )}
                {items.map((f) => (
                  <tr
                    key={f.path}
                    onClick={() => setSelected(f)}
                    onDoubleClick={() => openEntry(f)}
                    className={`cursor-default border-t border-white/5 ${selected?.path === f.path ? "bg-sky-500/20" : "hover:bg-white/5"}`}
                  >
                    <td className="py-1.5">
                      <span className="flex items-center gap-2 text-slate-200">
                        {f.is_dir ? <Folder size={14} className="text-amber-300" /> : <FileIcon size={14} className="text-slate-400" />}
                        {f.name}
                      </span>
                    </td>
                    <td className="px-2 text-right tabular-nums text-slate-400">{f.is_dir ? "—" : bytes(f.size)}</td>
                    <td className="px-2 text-slate-400 max-sm:hidden">{new Date(f.mtime * 1000).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-emerald-400/70 bg-emerald-500/10 text-sm text-emerald-200">
            Drop files to upload to {cwd}
          </div>
        )}
      </div>
    </div>
  );
}
