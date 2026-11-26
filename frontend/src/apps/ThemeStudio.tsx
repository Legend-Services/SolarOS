import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Copy, Download, FileJson, ImageUp, Moon, Pencil, Plus, Sun, Trash2, Upload } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/stores";
import { allThemes, useActiveTheme, useTheme } from "../store/themeStore";
import { BUILT_IN_IDS, BUILT_IN_THEMES, WALLPAPER_LIBRARY } from "../theme/builtInThemes";
import { CUSTOM_WALLPAPER, customBackground, themeError, type ColorMode, type Palette, type Theme, type ThemeStyle, type Wallpaper } from "../theme/themeTypes";
import { BrandBadge, ThemePreview, WallpaperThumb } from "../components/ThemeQuickSwitcher";
import { useProduct } from "../store/capabilitiesStore";
import { useTranslation } from "../i18n";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSlider, Notice, Segmented } from "../components/ui/GlassKit";
import { Card } from "./ControlPanelApp";

/* Settings → System → General & Appearance: theme gallery, per-theme wallpaper, theme creator, import and export. */

const WALLPAPER_MAX = 15 * 1024 * 1024;
const THEME_FILE_MAX = 2 * 1024 * 1024;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** A fresh id from the name that no built-in or saved theme uses. */
function uniqueId(name: string, custom: Theme[]) {
  const taken = new Set([...BUILT_IN_IDS, ...custom.map((t) => t.id)]);
  const base = slug(name).padEnd(2, "x");
  for (;;) {
    const id = `${base}-${Math.random().toString(16).slice(2, 6)}`;
    if (!taken.has(id)) return id;
  }
}

/** Only the theme-file fields, so stray keys in an imported file are not stored. */
const pick = ({ id, name, author, description, dark, light, style, wallpapers }: Theme): Theme => structuredClone({ id, name, author, description, dark, light, style, wallpapers });

function exportTheme(t: Theme) {
  const blob = new Blob([JSON.stringify({ format: "solardeck-theme", version: 1, ...pick(t) }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(t.name) || t.id}.solardeck-theme.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const COLOR_INPUT = "h-7 w-9 shrink-0 cursor-pointer rounded-md border border-white/15 bg-transparent p-0.5";

export default function ThemeStudio() {
  const s = useTheme();
  const active = useActiveTheme();
  const username = useAuth((st) => st.username) || "Me";
  const [editing, setEditing] = useState<{ theme: Theme; isNew: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<Theme | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const create = () =>
    setEditing({ isNew: true, theme: { ...pick(BUILT_IN_THEMES[0]), id: uniqueId("my-theme", s.customThemes), name: "My Theme", author: username, description: "" } });
  const clone = (t: Theme) =>
    setEditing({ isNew: true, theme: { ...pick(t), id: uniqueId(t.name, s.customThemes), name: `${t.name} Copy`.slice(0, 60), author: username } });
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await s.deleteTheme(removing.id);
      setNotice(`Deleted "${removing.name}".`);
      setRemoving(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title="Theme Gallery"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={s.colorMode}
              onChange={s.setMode}
              options={[
                { id: "dark", label: <span className="flex items-center gap-1"><Moon size={11} /> Dark</span> },
                { id: "light", label: <span className="flex items-center gap-1"><Sun size={11} /> Light</span> },
              ]}
            />
            <GlassButton onClick={() => setImporting(true)}>
              <Upload size={13} /> Import
            </GlassButton>
            <GlassButton variant="primary" onClick={create}>
              <Plus size={13} /> Create Theme
            </GlassButton>
          </div>
        }
      >
        <div className="mb-3 space-y-2">
          <Notice error={error} notice={notice} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {allThemes(s.customThemes).map((t) => {
            const on = t.id === active.id;
            const custom = !BUILT_IN_IDS.has(t.id);
            return (
              <div key={t.id} className={`glass-soft overflow-hidden rounded-xl ring-2 transition-[background-color,border-color,box-shadow,transform,scale,opacity] ${on ? "ring-sky-400" : "ring-transparent hover:ring-white/20"}`}>
                <button onClick={() => s.setTheme(t.id)} className="grid w-full grid-cols-2 active:scale-[0.99]" aria-label={`Use ${t.name}`} aria-pressed={on}>
                  <ThemePreview theme={t} mode="dark" className="h-20" />
                  <ThemePreview theme={t} mode="light" className="h-20" />
                </button>
                <div className="p-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">{t.name}</span>
                    {custom && <GlassBadge>Custom</GlassBadge>}
                    {on && <GlassBadge tone="info">Active</GlassBadge>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 min-h-[2.4em] text-[11px] text-slate-400">{t.description || `By ${t.author}`}</p>
                  <div className="mt-2 flex items-center gap-1">
                    {[t.dark.accent, t.dark.accent2, t.light.accent, t.light.accent2].map((c, i) => (
                      <span key={i} className="h-3 w-3 rounded-full ring-1 ring-white/20" style={{ background: c }} title={`${i < 2 ? "Dark" : "Light"} accent ${c}`} />
                    ))}
                    <span className="flex-1" />
                    <GlassButton variant="ghost" size="xs" onClick={() => exportTheme(t)} aria-label={`Export ${t.name}`} title="Export theme file">
                      <Download size={13} />
                    </GlassButton>
                    <GlassButton variant="ghost" size="xs" onClick={() => clone(t)} aria-label={`Clone ${t.name}`} title="Clone into a new theme">
                      <Copy size={13} />
                    </GlassButton>
                    {custom && (
                      <>
                        <GlassButton variant="ghost" size="xs" onClick={() => setEditing({ theme: pick(t), isNew: false })} aria-label={`Edit ${t.name}`} title="Edit">
                          <Pencil size={13} />
                        </GlassButton>
                        <GlassButton variant="ghost" size="xs" onClick={() => setRemoving(t)} aria-label={`Delete ${t.name}`} title="Delete">
                          <Trash2 size={13} />
                        </GlassButton>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <WallpaperCard />
      <WallpaperStudioCard />
      {editing && (
        <ThemeEditor
          initial={editing.theme}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSaved={(t) => (s.setTheme(t.id), setEditing(null), setNotice(`Saved "${t.name}".`), setError(""))}
        />
      )}
      <ImportModal open={importing} onClose={() => setImporting(false)} onImported={(t) => (setImporting(false), setNotice(`Imported "${t.name}".`), setError(""))} />
      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        busy={busy}
        title="Delete theme"
        confirmLabel="Delete"
        message={<>Delete the custom theme <b>{removing?.name}</b>? Export it first if you may want it back.</>}
      />
    </>
  );
}

/* ---------------- Wallpaper customizer (per theme) ---------------- */

function WallpaperCard() {
  const s = useTheme();
  const t = useActiveTheme();
  const [url, setUrl] = useState("");
  const [g1, setG1] = useState(t[s.colorMode].accent);
  const [g2, setG2] = useState(t[s.colorMode].bg);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const gradient = `linear-gradient(135deg, ${g1}, ${g2})`;

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    if (f.size > WALLPAPER_MAX) return setError("Wallpapers can be at most 15 MB.");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", f, f.name);
      const r = await api<{ url: string }>("/system/themes/wallpapers/upload", { method: "POST", body: form });
      s.setCustomWallpaper(r.url);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const applyUrl = () => {
    const v = url.trim();
    if (!v.startsWith("https://") || !CUSTOM_WALLPAPER.test(v)) return setError("Enter an image address that starts with https://.");
    setError("");
    s.setCustomWallpaper(v);
  };

  return (
    <Card title={`Wallpaper — ${t.name}`}>
      <p className="-mt-1 mb-3 text-[11px] text-slate-400">Each theme remembers its own wallpaper. Built-in wallpapers follow Light and Dark Mode.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {t.wallpapers.map((w, i) => (
          <div key={i}>
            <WallpaperThumb className="h-20" background={w[s.colorMode]} label={w.name} active={!s.customWallpaperUrl && s.selectedWallpaperIndex === i} onClick={() => s.setWallpaper(i)} />
            <span className="mt-1 block truncate text-[11px] text-slate-300">{w.name}</span>
          </div>
        ))}
      </div>
      {s.customWallpaperUrl && (
        <div className="mt-3 flex items-center gap-3 rounded-xl bg-white/5 p-2">
          <span className="h-10 w-16 shrink-0 rounded-md ring-2 ring-sky-400" style={{ background: customBackground(s.customWallpaperUrl) }} />
          <span className="min-w-0 flex-1 text-xs text-slate-200">Custom wallpaper in use for {t.name}</span>
          <GlassButton size="xs" onClick={() => s.setCustomWallpaper(null)}>
            Use built-in
          </GlassButton>
        </div>
      )}
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <Field label="Upload an image" hint="PNG, JPG, WebP or SVG, up to 15 MB">
          <GlassButton onClick={() => file.current?.click()} disabled={busy} className="w-full">
            <ImageUp size={13} /> {busy ? "Uploading…" : "Upload Wallpaper"}
          </GlassButton>
          <input ref={file} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => upload(e.target.files?.[0])} />
        </Field>
        <Field label="Paste an image URL">
          <div className="flex gap-1.5">
            <GlassInput className="min-w-0 flex-1" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyUrl()} />
            <GlassButton onClick={applyUrl}>Use</GlassButton>
          </div>
        </Field>
        <Field label="Color gradient">
          <div className="flex items-center gap-1.5">
            <input type="color" className={COLOR_INPUT} value={g1} onChange={(e) => setG1(e.target.value)} aria-label="Gradient start color" />
            <input type="color" className={COLOR_INPUT} value={g2} onChange={(e) => setG2(e.target.value)} aria-label="Gradient end color" />
            <span className="h-7 min-w-0 flex-1 rounded-lg ring-1 ring-white/15" style={{ background: gradient }} />
            <GlassButton onClick={() => s.setCustomWallpaper(gradient)}>Use</GlassButton>
          </div>
        </Field>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <GlassSlider label="Wallpaper Blur" value={s.wallpaperBlurPx} min={0} max={24} onChange={(v) => s.set({ wallpaperBlurPx: v })} />
        <GlassSlider label="Background Dimming" value={s.wallpaperDimPct} min={0} max={60} unit="%" onChange={(v) => s.set({ wallpaperDimPct: v })} />
      </div>
      {error && (
        <div className="mt-3">
          <Notice error={error} />
        </div>
      )}
    </Card>
  );
}

/* ---------------- Wallpaper Studio: brand watermark ---------------- */

function WallpaperStudioCard() {
  const s = useTheme();
  const t = useActiveTheme();
  const product = useProduct();
  const { t: tr } = useTranslation();
  const [error, setError] = useState("");
  const background = s.customWallpaperUrl ? customBackground(s.customWallpaperUrl) : t.wallpapers[s.selectedWallpaperIndex][s.colorMode];

  // Server-side export: the same wallpaper family in the theme's colors with the badge drawn in (vector, 1920×1080).
  const download = async () => {
    setError("");
    const json = { theme_id: t.id, wallpaper_index: s.selectedWallpaperIndex, color_mode: s.colorMode, show_overlay: s.brandOverlay, position: s.brandPosition,
      opacity: s.brandOpacityPct / 100, size: s.brandSizePct / 100, blur: s.wallpaperBlurPx };
    const r = await fetch("/api/system/themes/wallpapers/generate", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }).catch(() => null);
    if (!r?.ok) return setError(tr("wps.downloadFailed"));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `${t.id}-${s.selectedWallpaperIndex + 1}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card title={tr("wps.title")}>
      <p className="-mt-1 mb-3 text-[11px] text-slate-400">{tr("wps.intro", { product: product.short })}</p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div>
          <div className="relative aspect-video overflow-hidden rounded-xl ring-1 ring-white/15" style={{ background }} aria-label={tr("wps.preview")} role="img">
            <BrandBadge overlay={s.brandOverlay} position={s.brandPosition} opacityPct={s.brandOpacityPct} sizePct={s.brandSizePct} scale={0.4} />
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {t.wallpapers.map((w, i) => (
              <WallpaperThumb key={i} className="h-10" background={w[s.colorMode]} label={w.name} active={!s.customWallpaperUrl && s.selectedWallpaperIndex === i} onClick={() => s.setWallpaper(i)} />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Field label={tr("wps.theme")}>
            <GlassSelect className="w-full" value={t.id} onChange={(e) => s.setTheme(e.target.value)}>
              {allThemes(s.customThemes).map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </GlassSelect>
          </Field>
          <Field label={tr("wps.overlay")}>
            <Segmented
              value={s.brandOverlay}
              onChange={(v) => s.set({ brandOverlay: v })}
              options={[
                { id: "none", label: tr("wps.overlay.none") },
                { id: "brand_only", label: tr("wps.overlay.brand", { product: product.short }) },
                { id: "full_personalized", label: tr("wps.overlay.full") },
              ]}
            />
          </Field>
          <Field label={tr("wps.position")}>
            <Segmented
              value={s.brandPosition}
              onChange={(v) => s.set({ brandPosition: v })}
              options={[
                { id: "center", label: tr("wps.pos.center") },
                { id: "bottom-right", label: tr("wps.pos.bottomRight") },
                { id: "bottom-center", label: tr("wps.pos.bottomCenter") },
              ]}
            />
          </Field>
          <GlassSlider label={tr("wps.opacity")} value={s.brandOpacityPct} min={10} max={100} unit="%" disabled={s.brandOverlay === "none"} onChange={(v) => s.set({ brandOpacityPct: v })} />
          <GlassSlider label={tr("wps.size")} value={s.brandSizePct} min={50} max={200} unit="%" disabled={s.brandOverlay === "none"} onChange={(v) => s.set({ brandSizePct: v })} />
          <GlassButton onClick={download} className="self-start">
            <Download size={13} /> {tr("wps.download")}
          </GlassButton>
          {error && <Notice error={error} />}
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Create / Edit Theme ---------------- */

const GRADIENT = /^linear-gradient\(135deg, (#[0-9a-fA-F]{6}), (#[0-9a-fA-F]{6})\)$/;

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5 text-[11px] text-slate-300">
      <input type="color" className={COLOR_INPUT} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-[10px] text-slate-500">{value}</span>
    </label>
  );
}

function WallpaperSlot({ index, w, onChange }: { index: number; w: Wallpaper; onChange: (w: Wallpaper) => void }) {
  const lib = WALLPAPER_LIBRARY.find((l) => l.dark === w.dark && l.light === w.light);
  const grad = GRADIENT.exec(w.dark);
  const value = lib?.key ?? (grad && w.dark === w.light ? "gradient" : "current");
  const pickSource = (key: string) => {
    if (key === "gradient") return onChange({ ...w, dark: "linear-gradient(135deg, #38bdf8, #0b1020)", light: "linear-gradient(135deg, #bae6fd, #f8fafc)" });
    const l = WALLPAPER_LIBRARY.find((x) => x.key === key);
    if (l) onChange({ name: l.name, dark: l.dark, light: l.light });
  };
  const groups = BUILT_IN_THEMES.map((t) => ({ theme: t.name, items: WALLPAPER_LIBRARY.filter((l) => l.theme === t.name) }));
  return (
    <div className="glass-soft space-y-2 rounded-xl p-2.5">
      <div className="grid grid-cols-2 gap-1">
        <span className="h-12 rounded-md" style={{ background: w.dark }} title="Dark Mode" />
        <span className="h-12 rounded-md" style={{ background: w.light }} title="Light Mode" />
      </div>
      <GlassInput className="w-full" value={w.name} maxLength={60} onChange={(e) => onChange({ ...w, name: e.target.value })} aria-label={`Wallpaper ${index + 1} name`} />
      <GlassSelect className="w-full" value={value} onChange={(e) => pickSource(e.target.value)} aria-label={`Wallpaper ${index + 1} artwork`}>
        {value === "current" && <option value="current">Imported / custom artwork</option>}
        <option value="gradient">Color gradient</option>
        {groups.map((g) => (
          <optgroup key={g.theme} label={g.theme}>
            {g.items.map((l) => (
              <option key={l.key} value={l.key}>
                {l.name}
              </option>
            ))}
          </optgroup>
        ))}
      </GlassSelect>
      {value === "gradient" && grad && (
        <div className="flex items-center gap-1.5">
          {(["dark", "light"] as const).map((m) => {
            const [, a, b] = GRADIENT.exec(w[m]) ?? [, "#000000", "#000000"];
            const set = (x: string, y: string) => onChange({ ...w, [m]: `linear-gradient(135deg, ${x}, ${y})` });
            return (
              <span key={m} className="flex items-center gap-1 text-[10px] text-slate-400">
                {m === "dark" ? <Moon size={11} /> : <Sun size={11} />}
                <input type="color" className={COLOR_INPUT} value={a} onChange={(e) => set(e.target.value, b!)} aria-label={`${m} gradient start`} />
                <input type="color" className={COLOR_INPUT} value={b} onChange={(e) => set(a!, e.target.value)} aria-label={`${m} gradient end`} />
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ThemeEditor({ initial, isNew, onClose, onSaved }: { initial: Theme; isNew: boolean; onClose: () => void; onSaved: (t: Theme) => void }) {
  const saveTheme = useTheme((s) => s.saveTheme);
  const [t, setT] = useState<Theme>(initial);
  const [mode, setMode] = useState<ColorMode>("dark");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const p = t[mode];
  const setP = (patch: Partial<Palette>) => setT((x) => ({ ...x, [mode]: { ...x[mode], ...patch } }));
  const setStyle = (patch: Partial<ThemeStyle>) => setT((x) => ({ ...x, style: { ...x.style, ...patch } }));
  const setSlot = (i: number, w: Wallpaper) => setT((x) => ({ ...x, wallpapers: x.wallpapers.map((y, j) => (j === i ? w : y)) as Theme["wallpapers"] }));

  const save = async () => {
    const e = themeError(t);
    if (e) return setError(e);
    setBusy(true);
    setError("");
    try {
      await saveTheme(t, isNew);
      onSaved(t);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassModal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={isNew ? "Create Theme" : `Edit Theme — ${initial.name}`}
      footer={
        <>
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton variant="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save Theme"}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-3">
          <Section title="Dark Mode preview">
            <ThemePreview theme={t} mode="dark" className="h-28 rounded-xl" />
          </Section>
          <Section title="Light Mode preview">
            <ThemePreview theme={t} mode="light" className="h-28 rounded-xl" />
          </Section>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <GlassInput className="w-full" value={t.name} maxLength={60} onChange={(e) => setT({ ...t, name: e.target.value })} />
          </Field>
          <Field label="Author">
            <GlassInput className="w-full" value={t.author} maxLength={60} onChange={(e) => setT({ ...t, author: e.target.value })} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <GlassInput className="w-full" value={t.description} maxLength={300} onChange={(e) => setT({ ...t, description: e.target.value })} />
          </Field>
        </div>

        <Section
          title="Colors"
          action={
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { id: "dark", label: <span className="flex items-center gap-1"><Moon size={11} /> Dark Mode</span> },
                { id: "light", label: <span className="flex items-center gap-1"><Sun size={11} /> Light Mode</span> },
              ]}
            />
          }
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <ColorField label="Background" value={p.bg} onChange={(bg) => setP({ bg })} />
            <ColorField label="Glass Surface" value={p.surface} onChange={(surface) => setP({ surface })} />
            <ColorField label="Text Color" value={p.text} onChange={(text) => setP({ text })} />
            <ColorField label="Primary Accent" value={p.accent} onChange={(accent) => setP({ accent })} />
            <ColorField label="Secondary Accent" value={p.accent2} onChange={(accent2) => setP({ accent2 })} />
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <GlassSlider label="Glass Opacity" value={Math.round(p.opacity * 100)} min={20} max={100} unit="%" onChange={(v) => setP({ opacity: v / 100 })} />
            <GlassSlider label="Blur" value={p.blur} min={0} max={48} onChange={(blur) => setP({ blur })} />
          </div>
        </Section>

        <Section title="Style">
          <div className="grid gap-3 sm:grid-cols-3">
            <GlassSlider
              label="Window Corner Radius"
              value={t.style.radiusWindow}
              min={0}
              max={28}
              onChange={(r) => setStyle({ radiusWindow: r, radiusCard: Math.round(r * 0.75), radiusButton: Math.min(16, Math.round(r / 2)) })}
            />
            <Field label="Window Button Style">
              <GlassSelect className="w-full" value={t.style.windowChrome} onChange={(e) => setStyle({ windowChrome: e.target.value as ThemeStyle["windowChrome"] })}>
                <option value="standard">Standard</option>
                <option value="traffic-dots">Traffic Dots</option>
                <option value="angular-hud">Angular HUD</option>
              </GlassSelect>
            </Field>
            <Field label="Font Style">
              <GlassSelect className="w-full" value={t.style.font} onChange={(e) => setStyle({ font: e.target.value as ThemeStyle["font"] })}>
                <option value="sans">Modern Sans</option>
                <option value="geometric">Geometric</option>
                <option value="mono">Monospace</option>
              </GlassSelect>
            </Field>
          </div>
        </Section>

        <Section title="Wallpapers">
          <div className="grid gap-2 sm:grid-cols-2">
            {t.wallpapers.map((w, i) => (
              <WallpaperSlot key={i} index={i} w={w} onChange={(x) => setSlot(i, x)} />
            ))}
          </div>
        </Section>
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h4 className="flex-1 text-[11px] font-semibold tracking-wide text-slate-300 uppercase">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ---------------- Import ---------------- */

function ImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (t: Theme) => void }) {
  const s = useTheme();
  const [theme, setTheme] = useState<Theme | null>(null);
  const [renamed, setRenamed] = useState(false);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) (setTheme(null), setError(""), setRenamed(false));
  }, [open]);

  const read = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setTheme(null);
    if (f.size > THEME_FILE_MAX) return setError("Theme files can be at most 2 MB.");
    let data: unknown;
    try {
      data = JSON.parse(await f.text());
    } catch {
      return setError("This file is not valid JSON.");
    }
    const e = themeError(data);
    if (e) return setError(`Not a valid SolarDeck theme: ${e}.`);
    const t = pick(data as Theme);
    const clash = BUILT_IN_IDS.has(t.id) || s.customThemes.some((x) => x.id === t.id);
    if (clash) t.id = uniqueId(t.name, s.customThemes);
    setRenamed(clash);
    setTheme(t);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    read(e.dataTransfer.files[0]);
  };
  const add = async () => {
    if (!theme) return;
    setBusy(true);
    try {
      await s.saveTheme(theme, true);
      s.setTheme(theme.id);
      onImported(theme);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      width="max-w-xl"
      title="Import Theme"
      footer={
        <>
          <GlassButton onClick={onClose}>Cancel</GlassButton>
          <GlassButton variant="primary" onClick={add} disabled={!theme || busy}>
            {busy ? "Adding…" : "Add Theme"}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <button
          type="button"
          onClick={() => file.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className={`flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-slate-300 transition ${drag ? "border-sky-400 bg-sky-400/10" : "border-white/15 hover:border-white/30"}`}
        >
          <FileJson size={26} className="text-sky-300" />
          <span className="font-medium">Drop a .solardeck-theme.json file here, or click to choose one</span>
          <span className="text-[11px] text-slate-500">The file is checked before anything is saved.</span>
        </button>
        <input ref={file} type="file" hidden accept=".json,application/json" onChange={(e) => (read(e.target.files?.[0]), (e.target.value = ""))} />
        <Notice error={error} />
        {theme && (
          <div className="glass-soft space-y-2 rounded-xl p-3">
            <div>
              <p className="text-sm font-semibold text-slate-100">{theme.name}</p>
              <p className="text-[11px] text-slate-400">
                By {theme.author}
                {theme.description && ` — ${theme.description}`}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ThemePreview theme={theme} mode="dark" className="h-24 rounded-lg" />
              <ThemePreview theme={theme} mode="light" className="h-24 rounded-lg" />
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {theme.wallpapers.map((w, i) => (
                <span key={i} className="h-10 rounded-md" style={{ background: w[s.colorMode] }} title={w.name} />
              ))}
            </div>
            {renamed && <p className="text-[11px] text-amber-300">A theme with this id already exists, so the import gets a new id.</p>}
          </div>
        )}
      </div>
    </GlassModal>
  );
}
