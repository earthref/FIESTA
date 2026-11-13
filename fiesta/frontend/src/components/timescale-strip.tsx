// The geologic time scale under an age histogram (a range filter with
// `timescale: true`): a colored row per rank, lined up with the chart's x axis
// (its grid's left/right margins and the window it shows, zoomed or not);
// clicking a unit selects its age range. TimescalePicker finds a unit by name.

import { useEffect, useId, useRef, useState } from "react";
import {
  cellLabel,
  TIMESCALE,
  TIMESCALE_RANKS,
  type TimescaleUnit,
  textOn,
} from "../lib/timescale";
import { cx } from "../lib/utils";

const ROW = 24;
/** A cell narrower than this (px) shows no name; hover still names it. */
const MIN_LABEL = 30;

const boundary = (ma: number, sigma?: number) =>
  `${ma.toLocaleString()}${sigma ? ` ± ${sigma}` : ""} Ma`;
export const unitRange = (unit: TimescaleUnit) =>
  `${boundary(unit.min, unit.minSigma)} to ${boundary(unit.max, unit.maxSigma)}`;

export function TimescaleStrip({
  window: [x0, x1],
  log,
  left,
  right,
  toValue,
  selected,
  onPick,
}: {
  /** The chart's x window, in the filter's units. */
  window: [number, number];
  log: boolean;
  /** The chart grid's left and right margins (px). */
  left: number;
  right: number;
  /** A boundary in Ma as a value in the filter's units. */
  toValue: (ma: number) => number;
  /** The selected range, to mark the unit that matches it. */
  selected: { lo: number; hi: number };
  onPick: (unit: TimescaleUnit) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ unit: TimescaleUnit; center: number; row: number } | null>(
    null,
  );
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(() => setWidth(track.clientWidth));
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const t = (v: number) => (log ? (v > 0 ? Math.log10(v) : Number.NEGATIVE_INFINITY) : v);
  const [t0, t1] = [t(x0), t(x1)];
  const pct = (v: number) => Math.min(100, Math.max(0, ((t(v) - t0) / (t1 - t0)) * 100));

  const rows = TIMESCALE_RANKS.map((rank) =>
    TIMESCALE.filter((unit) => unit.rank === rank).flatMap((unit) => {
      const [lo, hi] = [pct(toValue(unit.min)), pct(toValue(unit.max))];
      return hi - lo > 0 ? [{ unit, lo, hi }] : [];
    }),
  );
  if (!(t1 > t0)) return null;

  return (
    <div className="relative select-none pt-1 pb-2 text-[13px]">
      {TIMESCALE_RANKS.map((rank, row) => (
        <div key={rank} className="flex" style={{ height: ROW }}>
          <span
            className="shrink-0 pr-2 text-right text-ink-muted"
            style={{ width: left, lineHeight: `${ROW}px` }}
          >
            {rank}
          </span>
          <div ref={row === 0 ? trackRef : undefined} className="relative flex-1 overflow-hidden">
            {rows[row].map(({ unit, lo, hi }) => {
              const picked =
                near(selected.lo, toValue(unit.min)) && near(selected.hi, toValue(unit.max));
              const show = () => setHover({ unit, center: (lo + hi) / 2, row });
              return (
                <button
                  key={unit.name}
                  type="button"
                  aria-label={`${unit.name} ${unit.rank}: ${unitRange(unit)}`}
                  aria-pressed={picked}
                  onClick={() => onPick(unit)}
                  onMouseEnter={show}
                  onFocus={show}
                  onMouseLeave={() => setHover(null)}
                  onBlur={() => setHover(null)}
                  className={cx(
                    "absolute inset-y-px cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap px-0.5 text-center font-bold hover:brightness-95 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-node",
                    picked && "z-10 outline-2 -outline-offset-2 outline-ink",
                  )}
                  style={{
                    left: `${lo}%`,
                    width: `${hi - lo}%`,
                    background: unit.color,
                    color: textOn(unit.color),
                    boxShadow: "inset -1px 0 0 var(--color-surface, #fff)",
                    lineHeight: `${ROW - 2}px`,
                  }}
                >
                  {((hi - lo) / 100) * width >= MIN_LABEL ? cellLabel(unit) : ""}
                </button>
              );
            })}
          </div>
          <span className="shrink-0" style={{ width: right }} />
        </div>
      ))}
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm border border-line bg-surface px-2 py-1 text-[13px] text-ink shadow-md"
          style={{
            left: `calc(${left}px + (100% - ${left + right}px) * ${Math.min(88, Math.max(12, hover.center)) / 100})`,
            top: hover.row * ROW,
          }}
        >
          <div className="font-bold">
            {hover.unit.name} {hover.unit.rank}
          </div>
          <div className="text-ink-muted">{unitRange(hover.unit)}</div>
        </div>
      )}
    </div>
  );
}

/** Units whose name (or rank) matches, those whose name starts with it first. */
function findUnits(text: string): TimescaleUnit[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return TIMESCALE;
  const full = (unit: TimescaleUnit) => `${unit.name} ${unit.rank}`.toLowerCase();
  const starts = (unit: TimescaleUnit) => unit.name.toLowerCase().startsWith(needle);
  return [
    ...TIMESCALE.filter(starts),
    ...TIMESCALE.filter((unit) => !starts(unit) && full(unit).includes(needle)),
  ];
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-5 * Math.max(Math.abs(b), 1e-9);

/**
 * A named age range: a box to type a geologic time unit's name in, over the
 * units that match (all of them, by rank, while it is empty); picking one
 * selects its age range. It shows the unit the selection matches.
 */
export function TimescalePicker({
  toValue,
  selected,
  onPick,
}: {
  /** A boundary in Ma as a value in the filter's units. */
  toValue: (ma: number) => number;
  selected: { lo: number; hi: number };
  onPick: (unit: TimescaleUnit) => void;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const current = TIMESCALE.find(
    (unit) => near(selected.lo, toValue(unit.min)) && near(selected.hi, toValue(unit.max)),
  );
  const matches = open ? findUnits(text) : [];
  const at = Math.min(cursor, matches.length - 1);

  useEffect(() => {
    if (open && at >= 0) listRef.current?.children[at]?.scrollIntoView({ block: "nearest" });
  }, [open, at]);

  const pick = (unit: TimescaleUnit) => {
    onPick(unit);
    setOpen(false);
    setText("");
  };

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-label="Named age range"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && at >= 0 ? `${listId}-${at}` : undefined}
        value={open ? text : current ? `${current.name} ${current.rank}` : ""}
        placeholder="Named age range…"
        onFocus={() => {
          setOpen(true);
          setText("");
          setCursor(0);
        }}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setCursor(Math.max(0, Math.min(matches.length - 1, at + step)));
          } else if (event.key === "Enter" && open && matches[at]) {
            event.preventDefault();
            pick(matches[at]);
          } else if (event.key === "Escape" && open) {
            // Close the list, not the modal.
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className="w-56 rounded-sm border border-gray-300 bg-surface px-[0.8em] py-[0.45em] text-[13px] placeholder:text-ink-faint focus:border-node focus:outline-hidden"
      />
      {open && (
        // Opens upward: the chart is above the box, the modal's footer below.
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Geologic time units"
          className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-80 overflow-y-auto rounded-sm border border-line bg-surface py-1 text-[13px] shadow-lg"
        >
          {matches.map((unit, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's input handles the keys
            <div
              key={`${unit.rank}-${unit.name}`}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === at}
              // Before the box's blur closes the list.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(unit)}
              onMouseEnter={() => setCursor(i)}
              className={cx(
                "flex cursor-pointer items-center gap-2 px-2 py-1",
                i === at && "bg-node-soft",
              )}
            >
              <span
                aria-hidden="true"
                className="h-3 w-3 shrink-0 rounded-[2px]"
                style={{ background: unit.color }}
              />
              <span className="min-w-0 grow">
                <span className="font-bold">{unit.name}</span>{" "}
                <span className="text-ink-muted">{unit.rank}</span>
              </span>
              <span className="shrink-0 text-[13px] text-ink-muted">
                {unit.min.toLocaleString()}–{unit.max.toLocaleString()} Ma
              </span>
            </div>
          ))}
          {matches.length === 0 && (
            <div className="px-2 py-1 text-ink-faint">No unit matches “{text.trim()}”.</div>
          )}
        </div>
      )}
    </div>
  );
}
