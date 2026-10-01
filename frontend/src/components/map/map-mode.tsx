import { useState } from "react";
import { BODIES, type Body } from "./bodies";
import { MODES, type Mode } from "./map-points";

/** A map's view mode, remembered in this browser under `key`. */
export function useSavedMode(key: string, fallback: Mode = "globe") {
  const [mode, setModeState] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem(key);
      return MODES.some(([value]) => value === saved) ? (saved as Mode) : fallback;
    } catch {
      return fallback;
    }
  });
  const setMode = (next: Mode) => {
    setModeState(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // private window: the mode just isn't remembered
    }
  };
  return [mode, setMode] as const;
}

export const mapButtonClass = (active: boolean) =>
  active
    ? "border-node bg-node text-white"
    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50";

/** Each option's records, when known: shown in its button unless 0, when the
 * button is disabled with `emptyTitle(option)` as its tooltip. */
type Counts<T extends string> = {
  counts?: Partial<Record<T, number>>;
  emptyTitle?: (option: T) => string;
};

function ButtonGroup<T extends string>({
  options,
  value,
  setValue,
  counts,
  emptyTitle,
}: {
  options: [T, string][];
  value: T;
  setValue: (value: T) => void;
} & Counts<T>) {
  return (
    <div className="inline-flex">
      {options.map(([option, label], index) => {
        const count = counts?.[option];
        // aria-disabled rather than disabled, so that its tooltip still shows.
        const empty = count === 0;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            aria-disabled={empty || undefined}
            title={empty ? emptyTitle?.(option) : undefined}
            onClick={() => !empty && setValue(option)}
            className={`border px-2 py-1 font-bold ${mapButtonClass(value === option)} ${
              index === 0 ? "rounded-l-sm" : "-ml-px"
            } ${index === options.length - 1 ? "rounded-r-sm" : ""} ${
              empty ? "cursor-not-allowed opacity-50 hover:bg-white" : ""
            }`}
          >
            {label}
            {count ? ` (${count.toLocaleString()})` : ""}
          </button>
        );
      })}
    </div>
  );
}

/** The Globe / Mercator / North Pole / South Pole buttons. */
export function ModeButtons({
  mode,
  setMode,
  ...counts
}: { mode: Mode; setMode: (mode: Mode) => void } & Counts<Mode>) {
  return <ButtonGroup options={MODES} value={mode} setValue={setMode} {...counts} />;
}

/** The Earth / Moon / Mars buttons, for `bodies` (in BODIES order); none
 * when Earth is the only one. */
export function BodyButtons({
  bodies,
  body,
  setBody,
  ...counts
}: {
  bodies: Body[];
  body: Body;
  setBody: (body: Body) => void;
} & Counts<Body>) {
  if (bodies.every((each) => each === "earth")) return null;
  const options = BODIES.filter(([each]) => bodies.includes(each));
  return <ButtonGroup options={options} value={body} setValue={setBody} {...counts} />;
}

/** The body a map shows: the one chosen, while it has points, else the one
 * with the most. */
export function useBody(bodies: Body[]) {
  const [chosen, setBody] = useState<Body | null>(null);
  const body = chosen && bodies.includes(chosen) ? chosen : (bodies[0] ?? "earth");
  return [body, setBody] as const;
}
