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
  /** Nearly the whole window (the contribution grid editor). */
  full?: boolean;
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
  full,
  largeTitle,
}: ModalProps) {
  const panelRef = useRef<HTMLDialogElement>(null);
  // Focus moves to the panel when it opens, not each time a parent passes a new onClose
  // (that stole focus from the grid editor's cells on every edit).
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

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
          "relative m-0 flex w-full flex-col rounded-lg border-0 bg-surface p-0 shadow-xl outline-hidden",
          full ? "max-h-[96vh] max-w-[1800px]" : "max-h-[85vh]",
          !full && (xl ? "max-w-5xl" : wide ? "max-w-3xl" : "max-w-lg"),
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
            className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-6 w-6">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-gray-100 px-4 py-3">{footer}</div>
        )}
      </dialog>
    </div>
  );
}
