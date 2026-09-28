import { useState } from "react";
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

/** The Globe / Mercator / North Pole / South Pole buttons. */
export function ModeButtons({ mode, setMode }: { mode: Mode; setMode: (mode: Mode) => void }) {
  return (
    <div className="inline-flex">
      {MODES.map(([value, label], index) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => setMode(value)}
          className={`border px-2 py-1 font-bold ${mapButtonClass(mode === value)} ${
            index === 0 ? "rounded-l-sm" : "-ml-px"
          } ${index === MODES.length - 1 ? "rounded-r-sm" : ""}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
