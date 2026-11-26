import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FlaskConical, Plus, ShieldCheck } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation } from "../../i18n";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassCheckbox, GlassInput, GlassModal, Notice } from "../ui/GlassKit";

/* Shapes of /api/virtual-hardware/labs/sandbox (backend/app/virtual_hardware.py). */
interface Lab {
  id: string;
  name: string;
  bridge: string;
  vlan_id: number;
  gateway_cidr: string;
  range_start: string;
  range_end: string;
  members: { guest_type: "vm" | "lxc"; guest_id: number; net_id: string }[];
  created_at: string;
}

/** ".1/24" gateway -> a .100-.200 style range inside the same subnet (IPv4, /29 or larger). */
function rangeFor(cidr: string): [string, string] | null {
  const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const ip = m.slice(1, 5).reduce((a, x) => a * 256 + Number(x), 0);
  const bits = Number(m[5]);
  if (bits < 8 || bits > 29) return null;
  const size = 2 ** (32 - bits);
  const net = ip - (ip % size);
  const lo = net + (size >= 256 ? 100 : size / 2);
  const hi = net + (size >= 256 ? 200 : size - 2);
  const s = (n: number) => [24, 16, 8, 0].map((b) => (n >>> b) & 255).join(".");
  return [s(lo), s(hi)];
}

/** Quick-start presets: name, gateway/subnet and VLAN filled in one click. */
const PRESETS = [
  { key: "lab.example1", cidr: "10.99.10.1/24", vlan: 910 },
  { key: "lab.example2", cidr: "10.99.20.1/24", vlan: 920 },
  { key: "lab.example3", cidr: "10.99.30.1/24", vlan: 930 },
] as const;

/** A captioned group of controls; a div, unlike Field's <label>, so the caption doesn't click the first control. */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="text-[11px] text-slate-400">
      <div className="mb-1.5 font-medium text-slate-300">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[10px] text-slate-500">{hint}</div>}
    </div>
  );
}

function LabWizard({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [cidr, setCidr] = useState("10.66.0.1/24");
  const [range, setRange] = useState<[string, string]>(["10.66.0.100", "10.66.0.200"]);
  const [vlan, setVlan] = useState("");
  const [guests, setGuests] = useState<Guest[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run } = useRunner();
  useEffect(() => {
    if (!open) return;
    setName("");
    setPicked([]);
    api<Guest[]>("/v1/guests").then(setGuests, () => setGuests([]));
  }, [open]);
  const changeCidr = (v: string) => {
    setCidr(v);
    const r = rangeFor(v);
    if (r) setRange(r);
  };
  const launch = () =>
    run(async () => {
      try {
        const r = await api<{ errors: string[] }>("/virtual-hardware/labs/sandbox", {
          method: "POST",
          json: {
            name: name.trim(),
            gateway_cidr: cidr.trim(),
            range_start: range[0].trim(),
            range_end: range[1].trim(),
            vlan_id: vlan ? Number(vlan) : null,
            guests: picked.map((k) => ({ guest_type: k.startsWith("qemu") ? "vm" : "lxc", guest_id: Number(k.split("/")[1]) })),
          },
        });
        onCreated();
        if (r.errors.length) throw new Error(t("lab.partial", { list: r.errors.join("; ") }));
        onClose();
      } catch (e) {
        if (e instanceof ApiError && e.message === "dnsmasq_missing") throw new Error(t("vsw.dhcpMissing"));
        throw e;
      }
    });
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={t("lab.wizardTitle")}
      subtitle={t("lab.subtitle")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !name.trim()} onClick={launch}>
            <ShieldCheck size={13} /> {busy ? t("lab.launching") : t("lab.launch")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl bg-emerald-400/10 p-3 ring-1 ring-emerald-300/20 ring-inset">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-300" />
          <div className="text-[11px] leading-relaxed text-emerald-100/90">
            <div className="mb-0.5 font-semibold text-emerald-200">{t("lab.airgap")}</div>
            {t("lab.airgapExplain")}
          </div>
        </div>
        <Group label={t("lab.presets")}>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <GlassButton key={p.key} size="xs" onClick={() => (setName(t(p.key)), changeCidr(p.cidr), setVlan(String(p.vlan)))}>
                {t(p.key)}
              </GlassButton>
            ))}
          </div>
        </Group>
        <Field label={t("lab.name")}>
          <GlassInput className="w-full" value={name} maxLength={40} placeholder={t("lab.example1")} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("lab.gateway")} hint={t("lab.gatewayHint")}>
            <GlassInput className="w-full font-mono" value={cidr} onChange={(e) => changeCidr(e.target.value)} />
          </Field>
          <Field label={t("lab.vlan")} hint={t("lab.vlanHint")}>
            <GlassInput className="w-full" type="number" min={2} max={4094} value={vlan} placeholder={t("lab.auto")} onChange={(e) => setVlan(e.target.value)} />
          </Field>
        </div>
        <Group label={t("lab.dhcp")} hint={t("lab.dhcpHint")}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("lab.rangeStart")}>
              <GlassInput className="w-full font-mono" value={range[0]} onChange={(e) => setRange([e.target.value, range[1]])} />
            </Field>
            <Field label={t("lab.rangeEnd")}>
              <GlassInput className="w-full font-mono" value={range[1]} onChange={(e) => setRange([range[0], e.target.value])} />
            </Field>
          </div>
        </Group>
        <Group label={t("lab.guests")} hint={t("lab.guestsHint")}>
          <div className="glass-field max-h-52 space-y-1 overflow-y-auto p-2">
            {guests.length === 0 && <p className="text-[11px] text-slate-500">{t("lab.noGuests")}</p>}
            {guests.map((g) => {
              const k = `${g.type}/${g.vmid}`;
              return (
                <div key={k} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-white/5">
                  <GlassCheckbox
                    className="min-w-0 flex-1"
                    checked={picked.includes(k)}
                    onChange={() => toggle(k)}
                    label={
                      <span className="truncate">
                        <span className="font-mono text-slate-400">{g.vmid}</span> · {g.name || g.vmid} · {g.type === "qemu" ? t("lab.vm") : t("lab.container")}
                      </span>
                    }
                  />
                  <GlassBadge tone={g.status === "running" ? "success" : "neutral"}>{g.status}</GlassBadge>
                </div>
              );
            })}
          </div>
        </Group>
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

/** Lab list with the 1-click wizard and teardown (Compute and Settings → Network & Services → Network & Virtual Switch). */
export default function LabSandboxPanel() {
  const { t } = useTranslation();
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [wizard, setWizard] = useState(false);
  const [teardown, setTeardown] = useState<Lab | null>(null);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(() => {
    api<{ labs: Lab[] }>("/virtual-hardware/labs/sandbox").then((r) => (setLabs(r.labs), setLoadError("")), (e) => setLoadError(e.message));
  }, []);
  useEffect(load, [load]);
  const { busy, error, notice, run } = useRunner(load);
  const remove = (lab: Lab) =>
    run(async () => {
      await api(`/virtual-hardware/labs/sandbox/${lab.id}`, { method: "DELETE" });
      setTeardown(null);
    }, t("lab.removed", { name: lab.name }));

  return (
    <div className="space-y-3">
      <section className="glass-soft rounded-xl p-3">
        <div className="mb-2 flex items-center gap-2">
          <FlaskConical size={14} className="text-amber-300" />
          <h4 className="flex-1 text-xs font-semibold text-slate-200">{t("lab.title")}</h4>
          <GlassButton variant="primary" size="xs" onClick={() => setWizard(true)}>
            <Plus size={12} /> {t("lab.new")}
          </GlassButton>
        </div>
        <p className="mb-3 text-[11px] text-slate-400">{t("lab.intro")}</p>
        <Notice error={loadError || error} notice={notice} />
        {labs && labs.length === 0 && <p className="text-xs text-slate-500">{t("lab.empty")}</p>}
        <div className="grid gap-2 md:grid-cols-2">
          {labs?.map((lab) => (
            <div key={lab.id} className="rounded-xl bg-white/5 p-3 ring-1 ring-white/10 ring-inset">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-white">{lab.name}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                    {lab.bridge} · VLAN {lab.vlan_id} · {lab.gateway_cidr}
                  </div>
                </div>
                <GlassBadge tone="success">
                  <ShieldCheck size={11} /> {t("lab.airgap")}
                </GlassBadge>
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                {t("lab.dhcpRange", { start: lab.range_start, end: lab.range_end })} · {t("lab.members", { n: lab.members.length })}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {lab.members.map((m) => (
                  <GlassBadge key={`${m.guest_type}${m.guest_id}`}>
                    {m.guest_type === "vm" ? t("lab.vm") : t("lab.container")} {m.guest_id}
                  </GlassBadge>
                ))}
              </div>
              <div className="mt-3 flex justify-end">
                <GlassButton size="xs" variant="danger" disabled={busy} onClick={() => setTeardown(lab)}>
                  {t("lab.teardown")}
                </GlassButton>
              </div>
            </div>
          ))}
        </div>
      </section>
      <LabWizard open={wizard} onClose={() => setWizard(false)} onCreated={load} />
      <ConfirmModal
        open={!!teardown}
        onClose={() => setTeardown(null)}
        onConfirm={() => teardown && remove(teardown)}
        busy={busy}
        error={error}
        title={t("lab.teardownTitle")}
        confirmLabel={t("lab.teardown")}
        message={teardown ? t("lab.teardownMsg", { name: teardown.name }) : ""}
      />
    </div>
  );
}
