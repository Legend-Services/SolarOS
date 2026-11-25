import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api } from "../../lib/api";
import { useTelemetry } from "../../lib/stores";
import { useHypervisorDefaults, type GuestProfile } from "../../store/hypervisorStore";
import { Card } from "../ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassInput, GlassSelect, GlassSwitch } from "../../components/ui/GlassKit";

function ProfileFields({ title, value, onChange }: { title: string; value: GuestProfile; onChange: (p: GuestProfile) => void }) {
  const field = (k: keyof GuestProfile, label: string, min: number, step = 1) => (
    <Field label={label}>
      <GlassInput type="number" min={min} step={step} className="w-full" value={value[k]} onChange={(e) => onChange({ ...value, [k]: Math.max(min, Number(e.target.value) || min) })} />
    </Field>
  );
  return (
    <Card title={title}>
      <div className="grid gap-3 sm:grid-cols-3">
        {field("cores", "CPU cores", 1)}
        {field("memory", "Memory (MiB)", 64, 64)}
        {field("disk", "Disk (GB)", 1)}
      </div>
    </Card>
  );
}

/** Settings > Hypervisor & Runtime > Hypervisor Defaults: what the New VM / New Container wizards start with. */
export default function HypervisorDefaultsPanel() {
  const d = useHypervisorDefaults();
  const targets = useTelemetry((s) => s.storage?.targets ?? []).filter((t) => t.active && /images|rootdir/.test(t.content));
  const [nested, setNested] = useState<{ nested: boolean | null; raw: string | null } | null>(null);
  useEffect(() => {
    api<{ nested: boolean | null; raw: string | null }>("/system/nested-virt").then(setNested, () => setNested({ nested: null, raw: null }));
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">New virtual machines and containers start with these values. You can still change every value in the wizard.</p>
      <ProfileFields title="Virtual machine profile" value={d.vm} onChange={(vm) => d.set({ vm })} />
      <ProfileFields title="Container profile" value={d.lxc} onChange={(lxc) => d.set({ lxc })} />
      <Card title="Storage target">
        <Field label="Default storage for new disks" hint="Automatic picks a ZFS pool first, then local-lvm, then any storage that holds disks.">
          <GlassSelect className="w-full max-w-sm" value={d.storage} onChange={(e) => d.set({ storage: e.target.value })}>
            <option value="">Automatic</option>
            {targets.map((t) => (
              <option key={t.storage} value={t.storage}>
                {t.storage} ({t.type})
              </option>
            ))}
          </GlassSelect>
        </Field>
      </Card>
      <Card
        title="Nested virtualization"
        action={
          nested && <GlassBadge tone={nested.nested ? "success" : nested.nested === false ? "warning" : "neutral"}>{nested.nested ? "ON" : nested.nested === false ? "OFF" : "UNKNOWN"}</GlassBadge>
        }
      >
        <p className="mb-3 text-xs text-slate-400">
          Host KVM module: {nested?.raw ? <span className="font-mono">nested={nested.raw}</span> : "not loaded or not readable"}. Nested virtualization lets a VM run its own
          hypervisor; turn it on in the BIOS (VT-x / AMD-V) and the kvm module options.
        </p>
        <GlassSwitch checked={d.nesting} onChange={(nesting) => d.set({ nesting })} label="Enable nesting for new containers (needed for Docker inside a container)" />
      </Card>
      <GlassButton onClick={d.reset}>
        <RotateCcw size={13} /> Reset to defaults
      </GlassButton>
    </div>
  );
}
