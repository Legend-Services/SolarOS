import type { ReactNode } from "react";

/** Shapes from backend/app/reverse_proxy.py. */
export interface HostBody {
  domain_names: string[];
  upstream_scheme: "http" | "https";
  upstream_host: string;
  upstream_port: number;
  websocket_support: boolean;
  http2_enabled: boolean;
  force_ssl: boolean;
  hsts_enabled: boolean;
  client_max_body_size: string;
  rate_limit_rpm: number | null;
  solardeck_sso_auth: boolean;
  access_list_id: string | null;
  certificate_id: string | null;
  custom_nginx_config: string;
  enabled: boolean;
}
export type Host = HostBody & { id: string };

export interface Stream {
  id: string;
  protocol: "tcp" | "udp" | "both";
  listen_port: number;
  upstream_host: string;
  upstream_port: number;
  comment: string;
}

export interface Acl {
  id: string;
  name: string;
  allow: string[];
  deny: string[];
  satisfy: "any" | "all";
  basic_auth_users: string[];
}

export interface Cert {
  id: string;
  name: string;
  source: "self_signed" | "acme" | "upload" | "root_ca";
  domains: string[];
  issuer: string;
  expires: number;
  key_type?: string;
}

export interface AcmeJob {
  domains: string[];
  state: "running" | "done" | "error";
  error: string | null;
  log: string[];
}

export interface Overview {
  settings: { solardeck_url: string; acme_email: string };
  gate_url: string;
  applied: number | null;
  root_ca: Cert | null;
}

export interface Data {
  ov: Overview;
  hosts: Host[];
  certs: Cert[];
  acmeJob: AcmeJob | null;
  acls: Acl[];
  streams: Stream[];
}

/** Mutating call: reloads everything afterwards; `ok: false` (saved, not applied) is shown by the studio. */
export type Call = (path: string, method?: string, json?: unknown) => Promise<unknown>;

export interface Ctx {
  d: Data;
  call: Call;
  reload: () => Promise<void>;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  ask: (title: string, message: ReactNode, fn: () => Promise<unknown>) => void;
}

/** Comma / whitespace / newline separated list. */
export const list = (s: string) => s.split(/[\s,]+/).filter(Boolean);
export const daysLeft = (ts: number) => Math.floor((ts * 1000 - Date.now()) / 86_400_000);
export const day = (ts: number) => new Date(ts * 1000).toLocaleDateString();
export const area = "glass-field w-full font-mono text-[11px]";
export const linkBtn = "glass-btn inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-100";
