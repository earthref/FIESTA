/**
 * How long has this tab been left alone?
 *
 * The idle clock restarts on real input (a key, a click, a pointer move, a
 * scroll) and whenever the tab becomes present again (window focus regained,
 * or the tab shown). The post-deploy auto-reload (use-auto-reload.ts) reads it
 * to wait until nobody would feel a reload.
 */

/** No input for this long and the reader has left the page alone. */
export const AWAY_AFTER_MS = 5 * 60_000;

const ACTIVITY_EVENTS = [
  "keydown",
  "pointerdown",
  "pointermove",
  "wheel",
  "touchstart",
  "scroll",
] as const;

let installed = false;
let lastActivityAt = Date.now();

function touch(): void {
  lastActivityAt = Date.now();
}

/** Idempotent; called by every reader so none has to remember. */
function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  lastActivityAt = Date.now();
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, touch, { passive: true, capture: true });
  }
  window.addEventListener("focus", touch);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) touch();
  });
}

// Start at page load, not at the first read: the auto-reloader first reads
// only once a deploy is noticed, and a reader who has been away since long
// before then is already idle.
install();

/** ms since this tab was last touched or last became present. */
export function msIdle(): number {
  install();
  return Date.now() - lastActivityAt;
}
