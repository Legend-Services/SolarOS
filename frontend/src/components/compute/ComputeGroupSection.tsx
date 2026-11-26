import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Container, FlaskConical, Layers, Monitor, Network, Pencil, Play, Power, Sparkles, Tag, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { usePoll } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation, type TKey } from "../../i18n";
import { GlassBadge, GlassButton, GlassCheckbox, GlassInput, GlassModal, GlassSelect, Field, Notice } from "../ui/GlassKit";
import { JobCard } from "../cluster/ClusterDialogs";
import { openLink } from "../../lib/stores";

/* Shapes of /api/compute/groups (backend/app/compute_groups.py). */
export interface GroupIface {
  iface: string;
  ip: string | null;
  mac: string | null;
  bridge: string;
  vlan_id: number | null;
  vlan_name: string | null;
  network_id: string | null;
}
export interface GroupMember {
  guest_type: "vm" | "lxc";
  guest_id: number;
  name: string;
  status: string;
  host: string;
  matched_interfaces: GroupIface[];
  all_group_ids: string[];
}
export interface ComputeGroup {
  group_id: string;
  source: "network" | "custom" | "ungrouped";
  kind: "switch" | "vlan" | "lab" | "custom" | "ungrouped";
  name: string;
  color: string;
  description: string;
  linked_network_id: string | null;
  network_kind: "switch" | "vlan" | "lab" | null;
  vlan_id: number | null;
  subnet_cidr: string | null;
  dhcp_active: boolean;
  members: GroupMember[];
  total_guests: number;
  running_guests: number;
  total_vcpu: number;
  allocated_ram_mb: number;
  used_ram_mb: number;
  avg_cpu_pct: number;
}
interface Suggestion {
  suggested_name: string | null;
  suggested_color: string | null;
  linked_network_id: string | null;
  source_label: string | null;
}

export const guestKey = (type: string, id: number) => `${type === "qemu" || type === "vm" ? "vm" : "lxc"}:${id}`;
const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

export function useComputeGroups(ms = 5000) {
  const [groups, setGroups] = useState<ComputeGroup[] | null>(null);
  const load = useCallback(() => api<{ groups: ComputeGroup[] }>("/compute/groups").then((r) => setGroups(r.groups), () => setGroups((g) => g ?? [])), []);
  usePoll(load, ms);
  return { groups, reload: load };
}

/** Display name: "Ungrouped" is the only server-side English name, so it is translated here. */
export function useGroupName() {
  const { t } = useTranslation();
  return (g: Pick<ComputeGroup, "source" | "name">) => (g.source === "ungrouped" ? t("grp.ungrouped") : g.name);
}

/** "VLAN 20 · Network Group", "Custom Group", … */
export function useOriginLabel() {
  const { t } = useTranslation();
  return (g: ComputeGroup) =>
    g.source === "custom" ? t("grp.customGroup") : g.source === "ungrouped" ? t("grp.ungroupedHint") : t("grp.networkGroup", { label: t(`grp.kind.${g.kind}` as TKey, { id: g.vlan_id ?? "" }) });
}

export const KindIcon = ({ kind, size = 14 }: { kind: ComputeGroup["kind"]; size?: number }) =>
  kind === "lab" ? <FlaskConical size={size} /> : kind === "vlan" ? <Layers size={size} /> : kind === "switch" ? <Network size={size} /> : <Tag size={size} />;

/** "2 Networks" / "3 Groups" badge on a multi-homed guest; opens the list of every group it is in. */
export function MultiGroupBadge({ member, groups }: { member: GroupMember; groups: ComputeGroup[] }) {
  const { t } = useTranslation();
  const name = useGroupName();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  const mine = groups.filter((g) => member.all_group_ids.includes(g.group_id));
  if (mine.length < 2) return null;
  const nets = mine.filter((g) => g.source === "network").length;
  return (
    <span ref={ref} className="relative inline-block">
      <button className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-semibold text-sky-200 ring-1 ring-sky-300/30 ring-inset hover:bg-sky-400/25" onClick={() => setOpen(!open)} aria-expanded={open}>
        {nets === mine.length ? t("grp.networks", { n: nets }) : t("grp.groups", { n: mine.length })}
      </button>
      {open && (
        <div
          className="absolute left-0 z-30 mt-1 w-72 rounded-xl border border-slate-700/80 p-2 shadow-2xl"
          style={{ backgroundColor: "rgb(from var(--sd-surface-elevated) r g b / 0.98)" }}
          role="dialog"
          aria-label={t("grp.memberOf")}
        >
          <div className="mb-1 px-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{t("grp.memberOf")}</div>
          <ul className="space-y-1">
            {mine.map((g) => {
              const m = g.members.find((x) => x.guest_type === member.guest_type && x.guest_id === member.guest_id);
              return (
                <li key={g.group_id} className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[11px]">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
                  <span className="min-w-0 flex-1 truncate text-slate-100">{name(g)}</span>
                  <span className="font-mono text-[10px] text-slate-400">{m?.matched_interfaces.map((i) => `${i.iface}${i.ip ? ` · ${i.ip}` : ""}`).join(", ")}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </span>
  );
}

/** NIC(s) a guest uses in this group plus the multi-homed badge; shown under the guest's name. */
export function GroupMemberInfo({ member, groups }: { member: GroupMember; groups: ComputeGroup[] }) {
  const { t } = useTranslation();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {member.matched_interfaces.map((i) => (
        <span key={i.iface} className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-white/10 ring-inset">
          {i.iface} · {i.ip ?? t("grp.noIp")}
        </span>
      ))}
      <MultiGroupBadge member={member} groups={groups} />
    </div>
  );
}

/** Collapsible group: header bar with origin, subnet, running count, CPU / RAM summary and group power, then the members. */
export function ComputeGroupSection({ group, open, onToggle, onEdit, onChanged, children }: {
  group: ComputeGroup;
  open: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  onChanged: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const name = useGroupName();
  const origin = useOriginLabel();
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState("");
  const power = (action: "start" | "shutdown") => {
    if (action === "shutdown" && !window.confirm(t("grp.stopConfirm", { name: name(group) }))) return;
    api<{ job_id: string }>(`/compute/groups/${encodeURIComponent(group.group_id)}/power`, { method: "POST", json: { action } }).then(
      (r) => (setError(""), setJob(r.job_id)),
      (e) => setError(e.message),
    );
  };
  const remove = () =>
    window.confirm(t("grp.deleteConfirm", { name: group.name })) &&
    api(`/compute/groups/${encodeURIComponent(group.group_id)}`, { method: "DELETE" }).then(onChanged, (e) => setError(e.message));
  const stopped = group.total_guests - group.running_guests;
  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]" style={{ borderLeft: `3px solid ${group.color}` }}>
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button className="flex min-w-0 items-center gap-2 text-left" onClick={onToggle} aria-expanded={open}>
          {open ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg" style={{ background: `${group.color}26`, color: group.color }}>
            <KindIcon kind={group.kind} size={13} />
          </span>
          <span className="truncate text-sm font-semibold text-slate-100">{name(group)}</span>
        </button>
        <GlassBadge tone={group.source === "custom" ? "info" : "neutral"}>{origin(group)}</GlassBadge>
        {group.subnet_cidr && (
          <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[10px] text-slate-300 ring-1 ring-white/10 ring-inset">
            {group.subnet_cidr}
            {group.dhcp_active ? " · DHCP" : ""}
          </span>
        )}
        <GlassBadge tone={group.running_guests ? "success" : "neutral"}>{t("grp.running", { n: group.running_guests, total: group.total_guests })}</GlassBadge>
        <span className="text-[11px] text-slate-400 tabular-nums">
          {t("grp.summary", { vcpu: group.total_vcpu, cpu: group.avg_cpu_pct, used: mb(group.used_ram_mb), alloc: mb(group.allocated_ram_mb) })}
        </span>
        <span className="ml-auto flex gap-1">
          <GlassButton size="xs" disabled={!stopped} onClick={() => power("start")}>
            <Play size={12} /> {t("grp.startGroup")}
          </GlassButton>
          <GlassButton size="xs" disabled={!group.running_guests} onClick={() => power("shutdown")}>
            <Power size={12} /> {t("grp.stopGroup")}
          </GlassButton>
          {onEdit && (
            <GlassButton size="xs" onClick={onEdit} aria-label={t("grp.edit")}>
              <Pencil size={12} />
            </GlassButton>
          )}
          {group.source === "custom" && (
            <GlassButton size="xs" onClick={remove} aria-label={t("grp.delete")}>
              <Trash2 size={12} className="text-rose-300" />
            </GlassButton>
          )}
        </span>
      </header>
      {(job || error) && (
        <div className="px-3 pb-2">
          <Notice error={error} />
          {job && <JobCard jobId={job} title={t("grp.powerTitle", { name: name(group) })} onDone={() => setTimeout(onChanged, 1500)} />}
        </div>
      )}
      {open && <div className="border-t border-white/5">{group.total_guests ? children : <p className="px-4 py-3 text-xs text-slate-400">{t("grp.empty")}</p>}</div>}
    </section>
  );
}

/** Create / edit a custom group. Picking a guest on a named VLAN, switch or lab fills in its name and color until the name is typed. */
export function GroupModal({ open, group, guests, groups, onClose, onSaved }: {
  open: boolean;
  group: ComputeGroup | null;
  guests: Guest[];
  groups: ComputeGroup[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#38bdf8");
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  const [auto, setAuto] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setColor(group?.color ?? "#38bdf8");
    setDescription(group?.description ?? "");
    setLink(group?.linked_network_id ?? "");
    setMembers(new Set(group?.members.map((m) => guestKey(m.guest_type, m.guest_id)) ?? []));
    setTouched(!!group);
    setAuto(null);
    setQ("");
    setError("");
  }, [open, group]);
  const networks = groups.filter((g) => g.source === "network");

  const fill = (s: Suggestion) => {
    if (!s.suggested_name) return;
    setName(s.suggested_name);
    setColor(s.suggested_color ?? "#38bdf8");
    setLink(s.linked_network_id ?? "");
    setAuto(s.source_label);
  };
  const toggle = (key: string) => {
    const next = new Set(members);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setMembers(next);
    if (!touched && next.size)
      api<Suggestion>(`/compute/groups/suggest?guest_ids=${encodeURIComponent([...next].join(","))}`).then(fill, () => {});
  };
  const pickNetwork = (id: string) => {
    setLink(id);
    if (!touched && id) api<Suggestion>(`/compute/groups/suggest?network_id=${encodeURIComponent(id)}`).then(fill, () => {});
  };
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return guests.filter((g) => !s || g.name.toLowerCase().includes(s) || String(g.vmid).includes(s));
  }, [guests, q]);

  const save = async () => {
    setBusy(true);
    const json = {
      name: name.trim(),
      color,
      description,
      linked_network_id: link || null,
      members: [...members].map((k) => ({ guest_type: k.split(":")[0], guest_id: Number(k.split(":")[1]) })),
    };
    try {
      await api(group ? `/compute/groups/${encodeURIComponent(group.group_id)}` : "/compute/groups", { method: group ? "PUT" : "POST", json });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={group ? t("grp.edit") : t("grp.create")}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-400">{t("grp.selected", { n: members.size })}</span>
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !name.trim()} onClick={save}>
            {t("grp.save")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <Notice error={error} />
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={t("grp.name")}>
            <GlassInput
              className="w-full"
              value={name}
              maxLength={64}
              onChange={(e) => (setName(e.target.value), setTouched(true), setAuto(null))}
              aria-label={t("grp.name")}
            />
          </Field>
          <Field label={t("grp.color")}>
            <input type="color" className="h-9 w-16 cursor-pointer rounded-lg border border-white/10 bg-transparent" value={color} onChange={(e) => (setColor(e.target.value), setTouched(true))} aria-label={t("grp.color")} />
          </Field>
        </div>
        {auto && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-sky-400/10 px-2.5 py-1 text-[11px] text-sky-200 ring-1 ring-sky-300/25 ring-inset" role="status">
            <Sparkles size={12} /> {t("grp.autoFilled", { source: auto })}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("grp.linkedNetwork")}>
            <GlassSelect className="w-full" value={link} onChange={(e) => pickNetwork(e.target.value)} aria-label={t("grp.linkedNetwork")}>
              <option value="">{t("grp.noLink")}</option>
              {networks.map((n) => (
                <option key={n.group_id} value={n.linked_network_id ?? ""}>
                  {n.name}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label={t("grp.description")}>
            <GlassInput className="w-full" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} aria-label={t("grp.description")} />
          </Field>
        </div>
        <Field label={t("grp.members")}>
          <GlassInput className="mb-2 w-full" placeholder={t("grp.searchMembers")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("grp.searchMembers")} />
          <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {shown.map((g) => {
              const key = guestKey(g.type, g.vmid);
              const nets = networks.filter((n) => n.members.some((m) => guestKey(m.guest_type, m.guest_id) === key));
              return (
                <li key={key} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/5">
                  <GlassCheckbox
                    checked={members.has(key)}
                    onChange={() => toggle(key)}
                    label={
                      <span className="flex items-center gap-1.5 text-xs text-slate-100">
                        {g.type === "qemu" ? <Monitor size={12} className="text-sky-300" /> : <Container size={12} className="text-violet-300" />}
                        {g.name} <span className="text-slate-500">· {g.vmid}</span>
                      </span>
                    }
                  />
                  <span className="ml-auto flex flex-wrap justify-end gap-1">
                    {nets.map((n) => (
                      <span key={n.group_id} className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: `${n.color}22`, color: n.color }}>
                        {n.name}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </Field>
      </div>
    </GlassModal>
  );
}

/** Network and custom groups as zoom pills (Virtual Switch & VLANs): each opens Network Architect zoomed into that group. */
export function GroupZoomPills() {
  const { t } = useTranslation();
  const { groups } = useComputeGroups(10000);
  const shown = (groups ?? []).filter((g) => g.source !== "ungrouped");
  if (!shown.length) return null;
  return (
    <section className="glass rounded-2xl px-4 py-3" aria-label={t("sz.studioTitle")}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-xs font-semibold text-white">{t("sz.studioTitle")}</h3>
        <p className="text-[11px] text-slate-400">{t("sz.studioHint")}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((g) => (
          <button
            key={g.group_id}
            onClick={() => openLink("architect", g.group_id)}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition hover:brightness-125"
            style={{ background: `${g.color}1f`, color: g.color, boxShadow: `inset 0 0 0 1px ${g.color}55` }}
            aria-label={t("sz.zoomInto", { name: g.name })}
          >
            <KindIcon kind={g.kind} size={11} />
            <span className="text-slate-100">{g.name}</span>
            {g.subnet_cidr && <span className="font-mono text-[10px] text-slate-400">{g.subnet_cidr}</span>}
            <span className="text-[10px] text-slate-300">{t("grp.running", { n: g.running_guests, total: g.total_guests })}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Quick add / remove of one guest across the custom groups ("Assign to Group…" in the guest's actions). */
export function AssignGroupModal({ guest, groups, onClose, onSaved, onCreate }: {
  guest: Guest | null;
  groups: ComputeGroup[];
  onClose: () => void;
  onSaved: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const key = guest ? guestKey(guest.type, guest.vmid) : "";
  const custom = groups.filter((g) => g.source === "custom");
  const nets = groups.filter((g) => g.source === "network" && g.members.some((m) => guestKey(m.guest_type, m.guest_id) === key));
  const flip = async (g: ComputeGroup) => {
    setBusy(g.group_id);
    const has = g.members.some((m) => guestKey(m.guest_type, m.guest_id) === key);
    const members = has
      ? g.members.filter((m) => guestKey(m.guest_type, m.guest_id) !== key).map(({ guest_type, guest_id }) => ({ guest_type, guest_id }))
      : [...g.members.map(({ guest_type, guest_id }) => ({ guest_type, guest_id })), { guest_type: key.split(":")[0], guest_id: guest!.vmid }];
    try {
      await api(`/compute/groups/${encodeURIComponent(g.group_id)}`, {
        method: "PUT",
        json: { name: g.name, color: g.color, description: g.description, linked_network_id: g.linked_network_id, members },
      });
      setError("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <GlassModal open={!!guest} onClose={onClose} title={t("grp.assignTitle", { name: guest?.name ?? "" })} subtitle={t("grp.assignHint")}>
      <div className="space-y-3">
        <Notice error={error} />
        {nets.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {nets.map((n) => (
              <span key={n.group_id} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]" style={{ background: `${n.color}22`, color: n.color }}>
                <KindIcon kind={n.kind} size={11} /> {n.name}
              </span>
            ))}
          </div>
        )}
        <ul className="space-y-1">
          {custom.map((g) => (
            <li key={g.group_id} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/5">
              <GlassCheckbox
                checked={g.members.some((m) => guestKey(m.guest_type, m.guest_id) === key)}
                onChange={() => busy || flip(g)}
                label={
                  <span className="flex items-center gap-2 text-xs text-slate-100">
                    <span className="h-2 w-2 rounded-full" style={{ background: g.color }} /> {g.name}
                  </span>
                }
              />
            </li>
          ))}
          {!custom.length && <li className="text-xs text-slate-400">{t("grp.noCustom")}</li>}
        </ul>
        <GlassButton size="xs" onClick={onCreate}>
          + {t("grp.create")}
        </GlassButton>
      </div>
    </GlassModal>
  );
}
