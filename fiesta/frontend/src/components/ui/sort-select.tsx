import type { CSSProperties } from "react";
import { Icon } from "./icon";

/**
 * The search results' sort dropdown (legacy `<color> ui dropdown label`): a
 * node-coloured pill with a white caret. The search page's sort and the
 * filter modals' value sorts both use it, so they look the same.
 */
export function SortSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  className,
  style,
}: {
  id: string;
  /** Screen-reader label (the pill shows only the chosen option). */
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={`relative inline-block ${className ?? ""}`} style={style}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="cursor-pointer appearance-none border-0 bg-node font-bold text-white focus:outline-hidden focus-visible:ring-2 focus-visible:ring-node focus-visible:ring-offset-1"
        style={{
          padding: "0.5em calc(1.86em - 8px) 0.5em 0.5em",
          fontSize: "0.92857143rem",
          lineHeight: "1em",
          borderRadius: "0.28571429rem",
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon
        name="caret-down"
        // In rem, as the pill's text is: the same wherever its parent's font size.
        className="pointer-events-none absolute top-1/2 right-[0.5rem] -translate-y-1/2 text-white"
        style={{ width: "0.857rem", height: "0.857rem" }}
      />
    </span>
  );
}
