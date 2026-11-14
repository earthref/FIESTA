import type { ReactNode } from "react";

/** `ui circular small basic label` + legacy `styles.countLabel`: white bg, 1px
 * border, bold text, min-width 4em, pulled into the tab's padding. Shared by
 * the search level tabs, the search sidebar's filters (`inline`: in the flow,
 * not pulled into a tab's padding) and the private workspace's toggles. 11px
 * as legacy: count pills are the one exception to the search page's 13px
 * least size (2026-11-12). Dark mode reads 12px/600 (2026-11-13): light text
 * on a dark pill blurs at 11px bold. The em-based box scales with it. */
export function CountLabel({ children, inline }: { children: ReactNode; inline?: boolean }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full border bg-surface text-center text-[11px] font-bold dark:text-[12px] dark:font-semibold"
      style={{
        color: "var(--er-ink-heading)",
        borderColor: "var(--er-line)",
        margin: inline ? 0 : "-1em -1em -1em 0.5em",
        minWidth: inline ? "3em" : "4em",
        minHeight: "2em",
        lineHeight: "0.7em",
        padding: "0.5em",
      }}
    >
      {children}
    </span>
  );
}
