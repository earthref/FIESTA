import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "../../lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Wider still, for a filter's list, histogram or map. */
  xl?: boolean;
  /** A menu down the left (the search's filters, one tab each); the modal
   * then keeps its height as the tabs change. */
  nav?: ReactNode;
  /** The title as large as the search's level tabs (the filter modals). */
  largeTitle?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  xl,
  nav,
  largeTitle,
}: ModalProps) {
  const panelRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 cursor-default bg-backdrop"
        onClick={onClose}
        tabIndex={-1}
      />
      <dialog
        ref={panelRef}
        open
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(
          "relative m-0 flex max-h-[85vh] w-full flex-col rounded-lg border-0 bg-surface p-0 shadow-xl outline-hidden",
          nav ? "h-[85vh] max-w-6xl" : xl ? "max-w-5xl" : wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2
            className={
              largeTitle
                ? "text-base font-bold text-ink-strong"
                : "text-sm font-semibold text-gray-900"
            }
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
        {nav ? (
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Filters"
              className="flex w-56 shrink-0 flex-col border-r border-gray-100 bg-panel"
            >
              {nav}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
              {footer && (
                <div className="flex justify-end gap-2 border-t border-gray-100 px-4 py-3">
                  {footer}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-y-auto px-4 py-4">{children}</div>
            {footer && (
              <div className="flex justify-end gap-2 border-t border-gray-100 px-4 py-3">
                {footer}
              </div>
            )}
          </>
        )}
      </dialog>
    </div>
  );
}
