import { api, setToken } from "./api";
import type { TokenResponse } from "./types";

/** Passwordless sign-in (docs/api.md "Auth"): an emailed one-time link, or an
 * external account (Google, Microsoft, GitHub, ORCID). Both come back to the
 * page they started on with a secret in the URL fragment:
 *   #fiesta_link=…              an emailed link (used only when the person confirms,
 *                               so a mail scanner opening it cannot spend it)
 *   #fiesta_login=…&nonce=…     an OAuth hand-off code, exchanged at once
 *   #fiesta_login_error=…&nonce=…
 * The nonce is this tab's: a result from a flow this tab did not start is ignored. */

const NONCE_KEY = "fiesta-oauth-nonce";

export interface SignInProvider {
  id: string;
  name: string;
}

/** What startup found in the fragment for the login modal to show. */
export let pendingSignIn: { link?: string; error?: string } | null = null;

export function clearPendingSignIn(): void {
  pendingSignIn = null;
}

/** This page without its fragment: where a sign-in comes back to. */
export function returnTo(): string {
  return window.location.href.split("#")[0];
}

function readNonce(): string | null {
  try {
    const nonce = sessionStorage.getItem(NONCE_KEY);
    sessionStorage.removeItem(NONCE_KEY);
    return nonce;
  } catch {
    return null;
  }
}

/** Called once on page startup, before the app renders. */
export async function initializeSignIn(): Promise<void> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const link = params.get("fiesta_link");
  const code = params.get("fiesta_login");
  const error = params.get("fiesta_login_error");
  if (!link && !code && !error) return;
  // The secret leaves the address bar (and history) before anything else runs.
  window.history.replaceState(window.history.state, "", returnTo());
  if (link) {
    pendingSignIn = { link };
    return;
  }
  const nonce = readNonce();
  if (!nonce || params.get("nonce") !== nonce) return;
  if (error) {
    pendingSignIn = { error };
    return;
  }
  try {
    // The account is linked or created only now, for the tab holding the nonce.
    const token = await api<TokenResponse>("/v2/auth/exchange", {
      method: "POST",
      json: { token: code, nonce },
      signal: AbortSignal.timeout(10000),
    });
    setToken(token.access_token);
  } catch (failure) {
    pendingSignIn = { error: failure instanceof Error ? failure.message : "sign-in failed" };
  }
}

/** Send the browser to PROVIDER; with `link`, connect it to the signed-in account. */
export async function startProviderSignIn(provider: string, link = false): Promise<void> {
  const nonce = crypto.randomUUID();
  try {
    sessionStorage.setItem(NONCE_KEY, nonce);
  } catch {
    // Without session storage the result is ignored on return; nothing more to do here.
  }
  const { url } = await api<{ url: string }>(`/v2/auth/oauth/${provider}/start`, {
    method: "POST",
    json: { return_to: returnTo(), nonce, link },
  });
  window.location.assign(url);
}

export async function sendSignInLink(email: string): Promise<void> {
  await api("/v2/auth/email-link", { method: "POST", json: { email, return_to: returnTo() } });
}

export function redeemSignInLink(secret: string): Promise<TokenResponse> {
  return api<TokenResponse>("/v2/auth/email-link/verify", {
    method: "POST",
    json: { token: secret },
  });
}

/** Labels for UserOut.profile_missing, in the order publication asks for them. */
export const PROFILE_LABELS: Record<string, string> = {
  first_name: "first name",
  last_name: "last name",
  affiliation: "affiliation",
  verified_email: "a verified email address",
};
