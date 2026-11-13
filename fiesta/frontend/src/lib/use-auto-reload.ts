import { useCallback, useEffect, useRef, useState } from "react";
import { AWAY_AFTER_MS, msIdle } from "./idle";

/**
 * Moves the tab onto a newly deployed build, but only when nobody would feel
 * it. A reload discards work (scroll position, text typed but not saved), so
 * this never pulls the page away the moment it notices a deploy:
 *
 *  - **Tab hidden**: reload immediately, no prompt. Nobody is looking, and this
 *    is the common case: the deploy lands while the tab sits in the background.
 *  - **User active**: nothing from this hook. Their next route change carries
 *    them onto the new build as a full document navigation
 *    (use-migrate-on-navigate).
 *  - **Visible but idle**: after `inactivityMs` with no input, show the toast
 *    (components/auto-reload.tsx) and count `countdownMs` down into a reload;
 *    **Reload** goes now, **Postpone** buys `postponeMs` of quiet. Any input
 *    while the toast is up retreats it (the reader is back) and the idle wait
 *    starts over. Coming back to the tab does the same.
 *  - **Idle but mid-edit**: focus parked in a field, an open dropdown, or a
 *    form open in a dialog (see `isHeld`): the toast shows with the clock
 *    parked. A lull does not end these on its own.
 *
 * What survives a reload: the URL, and with it the search, its filters and an
 * open contribution modal (?contribution=<id>&tab=...).
 */

/** How long the toast counts down once armed. */
const COUNTDOWN_MS = 60_000;
/** Idle time before the toast appears at all. */
const INACTIVITY_MS = AWAY_AFTER_MS;
/** How long "Postpone" keeps the toast away. */
const POSTPONE_MS = 60 * 60_000;
/** Countdown resolution; also how often the idle gate and hold check re-test. */
const TICK_MS = 1_000;
/** sessionStorage key for the reload-loop guard (see below). */
const GUARD_KEY = "fiesta:auto-reloaded-for";
/** sessionStorage key holding the timestamp a postponement expires at. */
const POSTPONE_KEY = "fiesta:reload-postponed-until";

const doReload = () => window.location.reload();

interface Options {
  /** The build being served once it stops matching this bundle's (use-update-available). */
  newBuild?: string | null;
  countdownMs?: number;
  inactivityMs?: number;
  postponeMs?: number;
  tickMs?: number;
  reload?: () => void;
}

/** What the toast needs to render. Null when there is nothing to say. */
export interface ReloadPrompt {
  /** Whole seconds left on the clock. */
  secondsLeft: number;
  /** What it started at, for the progress bar. */
  totalSeconds: number;
  /** The clock is parked: the user is mid-edit (see `isHeld`). */
  held: boolean;
  reloadNow: () => void;
  /** Not now: ask again in an hour. */
  postpone: () => void;
}

/** Nothing to do (`quiet`), waiting out the reader (`waiting`, no UI), or toast up (`armed`). */
type Phase = "quiet" | "waiting" | "armed";

/** True when the user is inside something a pause does not end: a focused
 *  field, an open dropdown or menu, or a form in an open dialog. A plain open
 *  dialog (the contribution modal) does not hold: it lives in the URL and
 *  comes back after the reload. */
function isHeld(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
      return true;
    }
  }
  return (
    document.querySelector(
      '[role="listbox"], [role="menu"], dialog[open] form, [role="dialog"] form',
    ) !== null
  );
}

/** Timestamp the current postponement runs out at; 0 when not postponed. */
function postponedUntil(): number {
  try {
    return Number(sessionStorage.getItem(POSTPONE_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function useAutoReload({
  newBuild = null,
  countdownMs = COUNTDOWN_MS,
  inactivityMs = INACTIVITY_MS,
  postponeMs = POSTPONE_MS,
  tickMs = TICK_MS,
  reload = doReload,
}: Options = {}): ReloadPrompt | null {
  const [phase, setPhase] = useState<Phase>("quiet");
  /** When the automatic reload is due; null while the clock is parked. */
  const [deadline, setDeadline] = useState<number | null>(null);
  /** When the clock was last free to run (armed, or a hold lifted): the
   *  deadline is `countdownMs` from here, so a hold restarts the full count. */
  const freeSince = useRef<number | null>(null);
  /** When the current postponement runs out; seeded from the store so a tab
   *  opened inside the hour stays quiet too. */
  const [snoozedUntil, setSnoozedUntil] = useState(postponedUntil);
  /** Re-render pump: the countdown is derived from the clock, not stored. */
  const [, tick] = useState(0);

  const commit = useCallback(() => {
    if (!newBuild) return;
    try {
      sessionStorage.setItem(GUARD_KEY, newBuild);
    } catch {
      // Best effort; the automatic path never gets here without a store.
    }
    reload();
  }, [newBuild, reload]);

  const postpone = useCallback(() => {
    const until = Date.now() + postponeMs;
    try {
      sessionStorage.setItem(POSTPONE_KEY, String(until));
    } catch {
      // Unreachable: the toast is never armed without a working store.
    }
    setPhase("quiet");
    setDeadline(null);
    setSnoozedUntil(until);
  }, [postponeMs]);

  // Decide what a noticed deploy means for this tab: nothing (guarded or
  // snoozed), an immediate reload (hidden), or a wait for the reader to leave.
  useEffect(() => {
    setPhase("quiet");
    setDeadline(null);
    if (!newBuild) return;

    // Reload-loop guard: if the reloaded bundle still reports the old id (a
    // stale cache, a half-swapped release), an unconditional auto-reload would
    // spin forever. Acting on a given build id is once per session.
    try {
      if (sessionStorage.getItem(GUARD_KEY) === newBuild) return;
    } catch {
      // Storage disabled: no guard and Postpone would not stick, so stay quiet.
      return;
    }

    // Ask again when the postponement is up: clearing it re-runs this effect.
    const wait = snoozedUntil - Date.now();
    if (wait > 0) {
      const timer = setTimeout(() => setSnoozedUntil(0), wait);
      return () => clearTimeout(timer);
    }

    if (document.hidden) {
      commit();
      return;
    }
    setPhase("waiting");
  }, [newBuild, snoozedUntil, commit]);

  // Wait out the reader: arm only after `inactivityMs` of idle. Meanwhile
  // use-migrate-on-navigate is the active user's path onto the new build.
  useEffect(() => {
    if (phase !== "waiting") return;
    const gate = () => {
      if (document.hidden) {
        commit();
        return;
      }
      if (msIdle() >= inactivityMs) setPhase("armed");
    };
    gate();
    const timer = setInterval(gate, tickMs);
    document.addEventListener("visibilitychange", gate);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", gate);
    };
  }, [phase, inactivityMs, tickMs, commit]);

  // Armed: run the clock down, then reload, unless the reader comes back.
  useEffect(() => {
    if (phase !== "armed") return;
    freeSince.current = null;

    const attempt = () => {
      if (document.hidden) {
        commit();
        return;
      }
      // The reader is back: retreat rather than count down beside someone
      // working; the idle wait starts over.
      if (msIdle() < inactivityMs) {
        setDeadline(null);
        setPhase("waiting");
        return;
      }
      const now = Date.now();
      if (isHeld()) {
        freeSince.current = null;
        setDeadline(null);
      } else {
        if (freeSince.current === null) freeSince.current = now;
        const due = freeSince.current + countdownMs;
        if (now >= due) {
          commit();
          return;
        }
        setDeadline(due);
      }
      tick((n) => n + 1);
    };

    attempt();
    const timer = setInterval(attempt, tickMs);
    document.addEventListener("visibilitychange", attempt);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", attempt);
    };
  }, [phase, inactivityMs, countdownMs, tickMs, commit]);

  if (phase !== "armed") return null;
  const totalSeconds = Math.ceil(countdownMs / 1000);
  const secondsLeft =
    deadline === null
      ? totalSeconds
      : Math.min(totalSeconds, Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  return { secondsLeft, totalSeconds, held: deadline === null, reloadNow: commit, postpone };
}
