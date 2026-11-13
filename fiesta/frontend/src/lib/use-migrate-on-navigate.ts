import { useBlocker, useRouter } from "@tanstack/react-router";

/**
 * The active user's path onto a newly deployed build: their next route change
 * becomes a full document navigation to the same destination, so the tab
 * moves onto the new build without a prompt and without discarding anything
 * the navigation would not have discarded anyway.
 *
 * It also beats the sharpest stale-tab failure: a plugin view the old bundle
 * lazy-loads on click 404s once its hashed chunk is gone from the new release
 * (main.tsx's vite:preloadError handler is the fallback for that).
 *
 * Only PUSH navigations are intercepted. REPLACE is how the search page and
 * the contribution modal sync tabs, rows and plots into the URL; a reload there
 * would tear the page out from under the reader. BACK/FORWARD arrive with the
 * history entry already moved, where cancelling into a document load fights
 * the router's own restoration.
 *
 * No loop guard needed: every migration needs a user's navigation, so a stale
 * cache can only ever cost full-page navigations, never a reload spin.
 */
export function useMigrateOnNavigate(newBuild: string | null): void {
  const router = useRouter();
  useBlocker({
    disabled: !newBuild,
    // The blocker exists to leave the page, not keep it: no "leave site?"
    // dialog on external links while an update is pending.
    enableBeforeUnload: false,
    shouldBlockFn: ({ next, action }) => {
      if (action !== "PUSH") return false;
      // `next` is the matched route, not a URL; rebuild the URL the SPA
      // transition would have produced. `publicHref` carries the router
      // basepath (/MagIC/...); `href` is the basepath-less internal path.
      // `search` is the union of every route's schema; the router only
      // re-serializes it here, so widen it to a plain record.
      const { publicHref } = router.buildLocation({
        to: next.pathname,
        search: next.search as Record<string, unknown>,
      });
      window.location.assign(publicHref);
      // "Blocked": the SPA transition must not also run; the document is
      // leaving. Should it somehow not unload, the next click tries again.
      return true;
    },
  });
}
