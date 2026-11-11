import type { ReactNode } from "react";

/** `ui circular small basic label` + legacy `styles.countLabel`: white bg, 1px
 * border, bold 11px text, min-width 4em, pulled into the tab's padding. Shared
 * by the search level tabs and the private workspace's toggles. */
export function CountLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-full border bg-surface text-center font-bold"
      style={{
        color: "var(--er-ink-heading)",
        borderColor: "var(--er-line)",
        margin: "-1em -1em -1em 0.5em",
        minWidth: "4em",
        minHeight: "2em",
        fontSize: 11,
        lineHeight: "0.7em",
        padding: "0.5em",
      }}
    >
      {children}
    </span>
  );
}
