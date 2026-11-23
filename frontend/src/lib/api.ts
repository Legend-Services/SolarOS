export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized();
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    throw new ApiError(res.status, typeof detail === "string" ? detail : res.statusText || "Request failed");
  }
  return res.json();
}

// XHR instead of fetch so we can report upload progress.
export function uploadFiles(dir: string, files: File[], onProgress: (pct: number) => void): Promise<void> {
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
