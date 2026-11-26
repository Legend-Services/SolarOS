import { useEffect, useState } from "react";
import { Wand2 } from "lucide-react";
import { api } from "../../lib/api";
import type { StorageVolume } from "../../lib/types";
import { useRunner } from "../../lib/hooks";
import { useTelemetry } from "../../lib/stores";
import { useTranslation } from "../../i18n";
import { Field, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../ui/GlassKit";
import { JobCard } from "../cluster/ClusterDialogs";

interface SwitchState {
  bridges: { name: string }[];
  vlans: { vlan_id: number; name: string; bridge: string }[];
}

const INITIAL = {
  image: "", vmid: 0, name: "", cores: 2, memory: 2048, disk: 20, storage: "", bridge: "", vlan: "", user: "admin", password: "",
  keys: "", dhcp: true, cidr: "", gateway: "", dns: "1.1.1.1", agent: true, start: true,
};

/**
 * Zero-Touch Create: a VM from a cloud image with an injected cloud-init seed (host name, admin login, network,
 * guest agent). `imageMatch` (a file name or pattern from the catalog) preselects that image when it is downloaded.
 */
export default function ZeroTouchWizard({ open, onClose, imageMatch, onCreated }: { open: boolean; onClose: () => void; imageMatch?: string; onCreated?: () => void }) {
  const { t } = useTranslation();
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const isoStores = targets.filter((x) => x.active && x.content.split(",").includes("iso")).map((x) => x.storage);
  const diskStores = targets.filter((x) => x.active && x.content.split(",").includes("images")).map((x) => x.storage);
  const [f, setF] = useState(INITIAL);
  const [images, setImages] = useState<string[]>([]);
  const [sw, setSw] = useState<SwitchState | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const { busy, error, run, setError } = useRunner();
  const set = <K extends keyof typeof INITIAL>(k: K, v: (typeof INITIAL)[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setJob(null);
    setError("");
    setF({ ...INITIAL, storage: diskStores.find((s) => s !== "local") ?? diskStores[0] ?? "" });
    api<{ vmid: number }>("/v1/nextid").then((r) => set("vmid", r.vmid), (e) => setError(e.message));
    api<SwitchState>("/network/switch/state").then((s) => (setSw(s), set("bridge", s.bridges[0]?.name ?? "")), () => setSw(null));
    Promise.all(isoStores.map((s) => api<StorageVolume[]>(`/v1/storage/${s}/content?content=iso`).catch(() => []))).then((l) => {
      const imgs = l.flat().map((v) => v.volid).filter((v) => v.endsWith(".img"));
      const re = imageMatch ? new RegExp(`^(?:${imageMatch})$`) : null;
      setImages(imgs);
      set("image", imgs.find((v) => re?.test(v.split("/").pop() ?? "")) ?? (re ? "" : imgs[0] ?? ""));
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () =>
    run(async () => {
      const body = {
        image_volume: f.image, vmid: f.vmid, name: f.name, cores: f.cores, memory: f.memory, disk_gb: f.disk, storage: f.storage,
        bridge: f.bridge || undefined, vlan_tag: f.vlan ? Number(f.vlan) : null, admin_user: f.user, password: f.password || null,
        ssh_keys: f.keys.split("\n").map((k) => k.trim()).filter(Boolean),
        network: f.dhcp ? "dhcp" : { cidr: f.cidr, gateway: f.gateway, dns: f.dns.split(/[\s,]+/).filter(Boolean) },
        guest_agent: f.agent, start: f.start,
      };
      setJob((await api<{ job_id: string }>("/compute/zero-touch", { method: "POST", json: body })).job_id);
    });
  const num = (k: "vmid" | "cores" | "memory" | "disk", label: string, min: number) => (
    <Field label={label}>
      <GlassInput className="w-full" type="number" min={min} value={f[k]} onChange={(e) => set(k, Number(e.target.value))} />
    </Field>
  );
  const vlans = sw?.vlans.filter((v) => v.bridge === f.bridge) ?? [];
  const ready = f.image && f.vmid && f.name && f.storage && (f.password.length >= 8 || f.keys.trim()) && (f.dhcp || (f.cidr && f.gateway));

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={t("zt.title")}
      footer={
        job ? (
          <GlassButton onClick={onClose}>{t("common.close")}</GlassButton>
        ) : (
          <>
            <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
            <GlassButton variant="primary" disabled={busy || !ready} onClick={submit}>
              <Wand2 size={13} /> {t("zt.submit")}
            </GlassButton>
          </>
        )
      }
    >
      <div data-anchor="zt-wizard" className="space-y-4">
        {job ? (
          <JobCard jobId={job} title={t("zt.progress", { name: f.name })} onDone={(ok) => ok && onCreated?.()} />
        ) : (
          <>
            <p className="text-[11px] text-slate-400">{t("zt.hint")}</p>
            <Field label={t("zt.image")} hint={!images.length ? t("zt.noImages") : imageMatch && !f.image ? t("zt.notDownloaded") : undefined}>
              <GlassSelect className="w-full" value={f.image} onChange={(e) => set("image", e.target.value)}>
                <option value="">{t("zt.pickImage")}</option>
                {images.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </GlassSelect>
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              {num("vmid", t("zt.vmid"), 100)}
              <Field label={t("zt.name")} className="sm:col-span-2">
                <GlassInput className="w-full" placeholder="web-01" value={f.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              {num("cores", t("zt.cores"), 1)}
              {num("memory", t("zt.memory"), 256)}
              {num("disk", t("zt.disk"), 4)}
              <Field label={t("zt.storage")}>
                <GlassSelect className="w-full" value={f.storage} onChange={(e) => set("storage", e.target.value)}>
                  {diskStores.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label={t("zt.switch")}>
                <GlassSelect className="w-full" value={f.bridge} onChange={(e) => (set("bridge", e.target.value), set("vlan", ""))}>
                  {sw?.bridges.map((b) => (
                    <option key={b.name}>{b.name}</option>
                  ))}
                </GlassSelect>
              </Field>
              <Field label={t("zt.vlan")}>
                <GlassSelect className="w-full" value={f.vlan} onChange={(e) => set("vlan", e.target.value)}>
                  <option value="">{t("zt.untagged")}</option>
                  {vlans.map((v) => (
                    <option key={v.vlan_id} value={v.vlan_id}>
                      {v.vlan_id} · {v.name}
                    </option>
                  ))}
                </GlassSelect>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("zt.user")}>
                <GlassInput className="w-full" value={f.user} onChange={(e) => set("user", e.target.value)} />
              </Field>
              <Field label={t("zt.password")} hint={t("zt.loginHint")}>
                <GlassInput className="w-full" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
              </Field>
            </div>
            <Field label={t("zt.keys")}>
              <textarea className="input min-h-16 w-full font-mono text-[11px]" spellCheck={false} placeholder="ssh-ed25519 AAAA… me@laptop" value={f.keys} onChange={(e) => set("keys", e.target.value)} />
            </Field>
            <Segmented
              value={f.dhcp ? "dhcp" : "static"}
              onChange={(v) => set("dhcp", v === "dhcp")}
              options={[
                { id: "dhcp", label: t("zt.dhcp") },
                { id: "static", label: t("zt.static") },
              ]}
            />
            {!f.dhcp && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t("zt.cidr")}>
                  <GlassInput className="w-full" placeholder="192.168.1.50/24" value={f.cidr} onChange={(e) => set("cidr", e.target.value)} />
                </Field>
                <Field label={t("zt.gateway")}>
                  <GlassInput className="w-full" placeholder="192.168.1.1" value={f.gateway} onChange={(e) => set("gateway", e.target.value)} />
                </Field>
                <Field label={t("zt.dns")}>
                  <GlassInput className="w-full" placeholder="1.1.1.1, 9.9.9.9" value={f.dns} onChange={(e) => set("dns", e.target.value)} />
                </Field>
              </div>
            )}
            <div className="flex flex-wrap gap-4">
              <GlassSwitch checked={f.agent} onChange={(v) => set("agent", v)} label={t("zt.agent")} />
              <GlassSwitch checked={f.start} onChange={(v) => set("start", v)} label={t("zt.start")} />
            </div>
            <Notice error={error} />
          </>
        )}
      </div>
    </GlassModal>
  );
}
