export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

/* Step-up re-authentication: destructive endpoints answer 403 "step_up_required" until the password (or a 2FA code)
   is confirmed again. The token is valid for 5 minutes and bound to this sign-in. */
export const STEP_UP_REQUIRED = "step_up_required";
let stepUp: { token: string; until: number } | null = null;
let onStepUp: () => Promise<string | null> = async () => null;
export const setStepUpHandler = (fn: () => Promise<string | null>) => (onStepUp = fn);
export const rememberStepUp = (token: string, ttlSeconds: number) => (stepUp = { token, until: Date.now() + (ttlSeconds - 10) * 1000 });
export const forgetStepUp = () => (stepUp = null);
const stepUpToken = () => (stepUp && stepUp.until > Date.now() ? stepUp.token : null);

/** A valid step-up token, asking the user to confirm when there is none (null = cancelled). */
export async function ensureStepUp(): Promise<string | null> {
  return stepUpToken() ?? (await onStepUp());
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}, retried = false): Promise<T> {
  const { json, ...rest } = init;
  const token = stepUpToken();
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Step-Up-Token": token } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized();
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    if (res.status === 403 && detail === STEP_UP_REQUIRED && !retried) {
      forgetStepUp();
      if (await onStepUp()) return api<T>(path, init, true);
      throw new ApiError(403, "Cancelled: confirm your identity to continue");
    }
    if (res.status === 429) {
      const wait = res.headers.get("Retry-After");
      throw new ApiError(429, typeof detail === "string" ? detail : `Too many attempts${wait ? `; try again in ${wait} s` : ""}`);
    }
    // Validation errors arrive as [{loc, msg}]: show the reasons instead of "Unprocessable Entity".
    const reasons = Array.isArray(detail) ? detail.map((d: { msg?: string }) => d?.msg?.replace(/^Value error, /, "")).filter(Boolean).join("; ") : "";
    throw new ApiError(res.status, typeof detail === "string" ? detail : reasons || res.statusText || "Request failed");
  }
  return res.json();
}

/** Upload one ISO image to a storage (raw body, streamed to disk by the backend), reporting progress. */
export function uploadIso(storage: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/storage/${encodeURIComponent(storage)}/upload?filename=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      if (xhr.status === 401) onUnauthorized();
      let msg = xhr.statusText;
      try {
        msg = JSON.parse(xhr.responseText).detail ?? msg;
      } catch {
        /* keep statusText */
      }
      reject(new ApiError(xhr.status, String(msg)));
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error"));
    xhr.send(file);
  });
}

// XHR instead of fetch so we can report upload progress.
export function uploadFiles(dir: string, files: File[], onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("path", dir);
    files.forEach((f) => form.append("files", f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files/upload");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      if (xhr.status === 401) onUnauthorized();
      let msg = xhr.statusText;
      try {
        msg = JSON.parse(xhr.responseText).detail ?? msg;
      } catch {
        /* keep statusText */
      }
      reject(new ApiError(xhr.status, String(msg)));
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error"));
    xhr.send(form);
  });
}
