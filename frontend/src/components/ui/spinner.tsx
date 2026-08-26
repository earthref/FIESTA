import { cx } from "../../lib/utils";

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <output className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cx(
          "inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-node",
          className,
        )}
      />
      <span className={label ? "text-sm text-gray-500" : "sr-only"}>{label ?? "Loading"}</span>
    </output>
  );
}

export function PageSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex justify-center py-16">
      <Spinner className="h-6 w-6" label={label} />
    </div>
  );
}
