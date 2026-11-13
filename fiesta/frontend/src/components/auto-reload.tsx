import { faArrowsRotate } from "@fortawesome/free-solid-svg-icons";
import { useAutoReload } from "../lib/use-auto-reload";
import { useMigrateOnNavigate } from "../lib/use-migrate-on-navigate";
import { useUpdateAvailable } from "../lib/use-update-available";
import { Button } from "./ui/button";
import { FaIcon } from "./ui/fa-icon";

/**
 * Mount once: notices newly deployed builds and moves the tab onto them by the
 * least disruptive path. A hidden tab reloads at once; an active user's next
 * route change becomes a full document navigation (use-migrate-on-navigate);
 * only a tab left visible and untouched for five minutes gets this toast, a
 * countdown into an automatic reload with Reload and Postpone (an hour). Input
 * while it counts retreats it: the reader came back.
 */
export function AutoReload() {
  const newBuild = useUpdateAvailable();
  useMigrateOnNavigate(newBuild);
  const prompt = useAutoReload({ newBuild });
  if (!prompt) return null;

  const { secondsLeft, totalSeconds, held, reloadNow, postpone } = prompt;
  const elapsed = totalSeconds ? (totalSeconds - secondsLeft) / totalSeconds : 1;

  return (
    // role="status", not a dialog: the toast must not count as an open
    // interaction in use-auto-reload's hold check. It sits above the fixed
    // footer, which is only fixed from `sm` up.
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-lg sm:bottom-[calc(var(--footer-h,3.5em)_+_1em)]"
    >
      <div className="flex items-start gap-3 p-3">
        <FaIcon icon={faArrowsRotate} className="mt-0.5 shrink-0 text-node-ink" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink-strong">A new version is available</div>
          <div className="mt-0.5 text-xs text-ink-muted" aria-live="off">
            {held
              ? "Reloading once you're done here, or reload now."
              : `Reloading in ${secondsLeft}s.`}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" onClick={reloadNow}>
              Reload
            </Button>
            <Button size="sm" variant="secondary" onClick={postpone} title="Ask again in an hour">
              Postpone
            </Button>
          </div>
        </div>
      </div>
      {/* Filling bar, so the countdown reads at a glance. */}
      <div className="h-0.5 bg-panel">
        <div
          className="h-full bg-node transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.min(100, elapsed * 100)}%` }}
        />
      </div>
    </div>
  );
}
