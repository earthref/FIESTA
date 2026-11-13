// The geologic time scale under an age histogram (a range filter with
// `timescale: true`): a colored row per rank, lined up with the chart's x axis
// (its grid's left/right margins and the window it shows, zoomed or not);
// clicking a unit selects its age range.

import { useEffect, useRef, useState } from "react";
import {
  cellLabel,
  TIMESCALE,
  TIMESCALE_RANKS,
  type TimescaleUnit,
  textOn,
} from "../lib/timescale";
import { cx } from "../lib/utils";

const ROW = 22;
/** A cell narrower than this (px) shows no name; hover still names it. */
const MIN_LABEL = 26;

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
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-5 * Math.max(Math.abs(b), 1e-9);

  const rows = TIMESCALE_RANKS.map((rank) =>
    TIMESCALE.filter((unit) => unit.rank === rank).flatMap((unit) => {
      const [lo, hi] = [pct(toValue(unit.min)), pct(toValue(unit.max))];
      return hi - lo > 0 ? [{ unit, lo, hi }] : [];
    }),
  );
  if (!(t1 > t0)) return null;

  return (
    <div className="relative select-none pt-1 pb-2 text-[11px]">
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
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm border border-line bg-surface px-2 py-1 text-[12px] text-ink shadow-md"
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
