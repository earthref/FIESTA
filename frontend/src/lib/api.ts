// Minimal fetch wrapper for the FIESTA API (see base.ts for where it lives).
// Callers pass a path relative to this node -- "/config" becomes
// <api>/v2/<node>/config -- or, for the node-less account routes, a full
// "/v2/auth/..." path.

import { apiUrl, nodeUrl } from "./base";

const TOKEN_KEY = "fiesta_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(detailToMessage(detail) || `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function detailToMessage(detail: unknown): string {
  if (typeof detail === "string") return detail;
  // Admin API: an invalid node configuration lists every problem.
  if (detail && typeof detail === "object" && "errors" in detail) {
    return detailToMessage((detail as { errors: unknown }).errors);
  }
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (d && typeof d === "object" && "msg" in d) {
          const loc = "loc" in d && Array.isArray(d.loc) ? `${d.loc.join(".")}: ` : "";
          return `${loc}${String((d as { msg: unknown }).msg)}`;
        }
        return String(d);
      })
      .join("; ");
  }
  return "";
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON-serialized as the request body. */
  json?: unknown;
  /** Form-encoded body (application/x-www-form-urlencoded), e.g. OAuth2 login. */
  form?: Record<string, string>;
  /** Multipart body (browser sets the content type + boundary). */
  formData?: FormData;
  /** Query params; array values are appended as repeated keys (e.g. range=…&range=…). */
  params?: Record<string, string | number | boolean | undefined | (string | number)[]>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  } else if (options.formData) {
    body = options.formData;
  }

  let url = path.startsWith("/v2/") ? apiUrl(path.slice(3)) : nodeUrl(path);
  if (options.params) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params)) {
      if (Array.isArray(value)) {
        for (const entry of value) qs.append(key, String(entry));
      } else if (value !== undefined && value !== "") {
        qs.set(key, String(value));
      }
    }
    const encoded = qs.toString();
    if (encoded) url += `?${encoded}`;
  }

  const response = await fetch(url, {
    method: options.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    signal: options.signal,
  });

  if (response.status === 401) {
    // Token is invalid or expired: drop it so the UI falls back to logged-out.
    clearToken();
  }

  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      const data = (await response.json()) as { detail?: unknown };
      if (data && typeof data === "object" && "detail" in data) detail = data.detail;
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(response.status, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
