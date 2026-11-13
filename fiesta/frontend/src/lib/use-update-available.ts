import { useEffect, useState } from "react";
import { BUILD_BASE } from "./base";

/**
 * Detects that a newer build has been deployed underneath a running tab.
 *
 * A deployment serves static files (deploy-fiesta.sh swaps the release dir);
 * there is no process left to push changes from (Vite's HMR exists only in
 * the dev server). A loaded SPA fetched index.html once and keeps running that
 * bundle until something reloads the document. This polls the build id the
 * server is currently serving (<base>version.json, written by the
 * `fiesta-build-version` plugin in vite.config.ts) and reports when it no
 * longer matches the id compiled into this bundle.
 *
 * Detection only: what to do about a new build is use-auto-reload's and
 * use-migrate-on-navigate's business. Returns the build id being served once
 * it stops matching this bundle's, so the caller can tell one deploy from the
 * next (the auto-reloader keys its loop guard on it).
 */

const VERSION_URL = `${BUILD_BASE}version.json`;
const POLL_MS = 60_000;

interface Options {
  /** Off outside a real build: dev has HMR, and has no version.json. */
  enabled?: boolean;
  intervalMs?: number;
  /** Build this bundle is running; the id vite inlined at build time. */
  running?: string;
}

export function useUpdateAvailable({
  enabled = import.meta.env.PROD,
  intervalMs = POLL_MS,
  running = import.meta.env.VITE_BUILD_ID as string | undefined,
}: Options = {}): string | null {
  const [newBuild, setNewBuild] = useState<string | null>(null);

  useEffect(() => {
    // Once stale, stop: the answer can't change back.
    if (!enabled || !running || newBuild) return;
    let cancelled = false;

    async function check() {
      // A background tab still polls: a hidden tab is the safest moment to
      // reload (nobody is looking), so that is exactly when the auto-reloader
      // most wants to know. visibilitychange re-checks on the way back in.
      try {
        // The query string defeats any cache between here and the release
        // dir (the dev host's web server config is not in this repo).
        const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const { build } = (await res.json()) as { build?: string };
        if (!cancelled && build && build !== running) setNewBuild(build);
      } catch {
        // Offline, or mid-deploy. A failed check is neither "up to date" nor
        // "new version"; try again next tick.
      }
    }

    void check(); // a deploy may already have landed before this tab opened
    const timer = setInterval(check, intervalMs);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [enabled, running, newBuild, intervalMs]);

  return newBuild;
}
