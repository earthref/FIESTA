import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/utils";
import { Icon } from "./ui/icon";

const MENU_WIDTH = 300;

/**
 * A summary grid column's filter icon (as on osu-mgr.org's result tables):
 * a count of its active filters, and a menu of the column's filters, the
 * sidebar's own controls, with Clear and Close. The menu sits in a portal so
 * the results pane's scroll box cannot clip it, and follows the icon when the
 * pane scrolls.
 */
export function ColumnFilterMenu({
  label,
  active,
  onClear,
  children,
}: {
  label: string;
  /** How many of the column's filters apply (the badge). */
  active: number;
  onClear: () => void;
  children: ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const isOpen = position !== null;

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      top: rect.bottom + 4,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      return !menuRef.current?.contains(target) && !buttonRef.current?.contains(target);
    };
    const onPointer = (event: PointerEvent) => {
      if (outside(event)) setPosition(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPosition(null);
        buttonRef.current?.focus();
      }
    };
    // The menu's own scrolling leaves it where it is.
    const onScroll = (event: Event) => {
      if (outside(event)) place();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [isOpen, place]);
  useEffect(() => {
    if (isOpen) menuRef.current?.focus();
  }, [isOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (isOpen ? setPosition(null) : place())}
        title={`Filter by ${label}`}
        aria-label={`Filter by ${label}${active ? ` (${active} applied)` : ""}`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={cx(
          "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 py-0.5 hover:bg-[#F0F0F0] hover:text-node focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
          active || isOpen ? "text-node" : "text-[#AAAAAA]",
        )}
      >
        <Icon name="filter" style={{ width: "0.85em", height: "0.85em" }} />
        {active > 0 && (
          <span
            className="rounded-full bg-node px-[0.45em] text-[10px] font-bold leading-[1.5] text-white"
            aria-hidden="true"
          >
            {active}
          </span>
        )}
      </button>
      {position &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label={`${label} filters`}
            tabIndex={-1}
            className="fixed z-50 flex flex-col rounded-sm border border-[#D4D4D5] bg-white text-[13px] font-normal text-[rgba(0,0,0,.87)] shadow-lg focus:outline-hidden"
            style={{ ...position, width: MENU_WIDTH, maxHeight: "min(70vh, 560px)" }}
          >
            <div
              className="flex items-center justify-between bg-[#F0F0F0]"
              style={{ padding: "0.5em 1em", borderBottom: "1px solid #D4D4D5" }}
            >
              <span className="font-bold">{label}</span>
              <button
                type="button"
                onClick={onClear}
                disabled={!active}
                className="cursor-pointer rounded-sm border border-[rgba(34,36,38,.15)] bg-white px-2 py-0.5 text-[12px] hover:bg-[#F0F0F0] disabled:cursor-default disabled:opacity-45"
              >
                Clear
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto whitespace-normal">{children}</div>
            <div style={{ padding: "0.5em 1em", borderTop: "1px solid #D4D4D5" }}>
              <button
                type="button"
                onClick={() => {
                  setPosition(null);
                  buttonRef.current?.focus();
                }}
                className="w-full cursor-pointer rounded-sm border border-[rgba(34,36,38,.15)] bg-white py-1 text-[12px] hover:bg-[#F0F0F0]"
              >
                Close
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
