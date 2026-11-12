import { cx } from "../../lib/utils";

// One class set per size: cx does not merge Tailwind classes, so an `h-3`
// passed beside the default `h-4` loses to it (Tailwind orders by value).
const SIZES = {
  // Inside a count pill (18px line): the contribution tabs, the search filters.
  xs: "h-2.5 w-2.5 border-[1.5px]",
  md: "h-4 w-4 border-2",
  lg: "h-6 w-6 border-2",
};

export function Spinner({
  className,
  label,
  size = "md",
}: {
  className?: string;
  label?: string;
  size?: keyof typeof SIZES;
}) {
  return (
    <output className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cx(
          "inline-block animate-spin rounded-full border-gray-300 border-t-node",
          SIZES[size],
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
      <Spinner size="lg" label={label} />
    </div>
  );
}
