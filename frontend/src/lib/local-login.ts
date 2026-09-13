import { ApiError, api, getToken, setToken } from "./api";

/** Called once on page startup, so signing out lasts until the next refresh. */
export async function initializeLocalLogin(): Promise<void> {
  try {
    if (getToken()) {
      try {
        await api("/v1/auth/me", { signal: AbortSignal.timeout(5000) });
        return; // Preserve an explicitly selected account, including the viewer.
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) return;
      }
    }
    const result = await api<{ access_token: string } | null>("/v1/auth/local-login", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (result) setToken(result.access_token);
  } catch {
    // Missing seeds, unavailable backend, or an older backend: normal login still works.
  }
}
