// Depth plots: a contribution's cores as multi-track SVG plots with a track
// picker, flagged-point toggle, robust/log value scales, section boundaries,
// a hover readout across tracks and drag-to-zoom on depth.

import { type PointerEvent, useId, useMemo, useState } from "react";
import {
  type CoreData,
  decimate,
  depthOf,
  formatValue,
  isBad,
  logTicks,
  nearest,
  niceTicks,
  type Payload,
  type Point,
  segments,
  splitOffScale,
  type TrackDef,
  trackPoints,
  trackValue,
  valueDomain,
} from "./depth-plot-data";

const PANEL_WIDTH = 120;
const PANEL_GAP = 12;
const PLOT_HEIGHT = 400;
const AXIS_LEFT = 48;
const SECTION_RIGHT = 34;
const TOP = 6;
const FOOTER = 28;
const BAD_COLOR = "#d62728";

/** Picked tracks, the flagged-point toggle and per-track log overrides,
 * shared by a contribution's cores. */
export function ContributionPlots({ payload }: { payload: Payload }) {
  const { cores, tracks } = payload;
  const defaults = useMemo(() => tracks.filter((t) => t.default).map((t) => t.key), [tracks]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [showBad, setShowBad] = useState(false);
  const [logs, setLogs] = useState<Record<string, boolean>>({});
  const selected = picked ?? defaults;
  const shown = tracks.filter((t) => selected.includes(t.key));
  const badCount = useMemo(
    () => cores.reduce((n, core) => n + core.rows.filter(isBad).length, 0),
    [cores],
  );
  const logOf = (track: TrackDef) => logs[track.key] ?? track.log;

  return (
    <>
      <PlotControls
        tracks={tracks}
        selected={selected}
        onPick={setPicked}
        defaults={defaults}
        badCount={badCount}
        showBad={showBad}
        onShowBad={setShowBad}
      />
      <div className="flex flex-wrap gap-6">
        {cores.map((core) => (
          <CoreTracks
            key={core.name}
            core={core}
            tracks={shown}
            showBad={showBad}
            logOf={logOf}
            onToggleLog={(track) => setLogs((prev) => ({ ...prev, [track.key]: !logOf(track) }))}
          />
        ))}
      </div>
    </>
  );
}

function PlotControls({
  tracks,
  selected,
  onPick,
  defaults,
  badCount,
  showBad,
  onShowBad,
}: {
  tracks: TrackDef[];
  selected: string[];
  onPick: (keys: string[]) => void;
  defaults: string[];
  badCount: number;
  showBad: boolean;
  onShowBad: (show: boolean) => void;
}) {
  const groups = [...new Set(tracks.map((t) => t.group))];
  const toggle = (key: string) =>
    onPick(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  const linkClass = "cursor-pointer text-node hover:underline";
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
      <details className="relative">
        <summary className="cursor-pointer select-none rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50">
          Tracks ({selected.filter((k) => tracks.some((t) => t.key === k)).length} of{" "}
          {tracks.length})
        </summary>
        <div className="absolute z-20 mt-1 max-h-96 w-80 overflow-y-auto rounded border border-gray-200 bg-surface p-2 shadow-lg">
          <div className="mb-2 flex gap-3 text-[12px]">
            <button type="button" className={linkClass} onClick={() => onPick(defaults)}>
              Defaults
            </button>
            <button
              type="button"
              className={linkClass}
              onClick={() => onPick(tracks.map((t) => t.key))}
            >
              All
            </button>
            <button type="button" className={linkClass} onClick={() => onPick([])}>
              None
            </button>
          </div>
          {groups.map((group) => (
            <fieldset key={group} className="mb-2">
              <legend className="mb-1 text-[11px] font-bold uppercase text-ink-faint">
                {group}
              </legend>
              <div className="grid grid-cols-2 gap-x-2">
                {tracks
                  .filter((t) => t.group === group)
                  .map((track) => (
                    <label
                      key={track.key}
                      className="flex min-w-0 cursor-pointer items-center gap-1 py-0.5"
                      title={track.label}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(track.key)}
                        onChange={() => toggle(track.key)}
                      />
                      <span
                        aria-hidden="true"
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ background: track.color }}
                      />
                      <span className="truncate">{track.label}</span>
                    </label>
                  ))}
              </div>
            </fieldset>
          ))}
        </div>
      </details>
      {badCount > 0 && (
        <label className="flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            checked={showBad}
            onChange={(event) => onShowBad(event.target.checked)}
          />
          Show {badCount.toLocaleString()} flagged points
          <span
            aria-hidden="true"
            className="inline-block size-2 rounded-full"
            style={{ background: BAD_COLOR }}
          />
        </label>
      )}
      <span className="text-[12px] text-ink-faint">
        Drag on a plot to zoom in on depth; double-click to reset.
      </span>
    </div>
  );
}

interface Panel {
  track: TrackDef;
  log: boolean;
  good: Point[];
  bad: Point[];
  domain: [number, number];
  path: string;
  /** Far off-scale points (a failed scan's zeros): ticks at the low or high edge. */
  off: { depth: number; low: boolean }[];
}

function CoreTracks({
  core,
  tracks,
  showBad,
  logOf,
  onToggleLog,
}: {
  core: CoreData;
  tracks: TrackDef[];
  showBad: boolean;
  logOf: (track: TrackDef) => boolean;
  onToggleLog: (track: TrackDef) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null);

  const extent = useMemo<[number, number] | null>(() => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const row of core.rows) {
      if (!showBad && isBad(row)) continue;
      const depth = depthOf(row);
      if (depth === undefined) continue;
      lo = Math.min(lo, depth);
      hi = Math.max(hi, depth);
    }
    return lo <= hi ? [lo, hi] : null;
  }, [core, showBad]);
  const view = zoom ?? extent;
  const span = view ? view[1] - view[0] || 1 : 1;
  const y = (depth: number) => TOP + ((depth - (view?.[0] ?? 0)) / span) * PLOT_HEIGHT;

  const logKey = tracks.map((t) => `${t.key}:${logOf(t)}`).join(",");
  const panels = useMemo<Panel[]>(() => {
    if (!view) return [];
    const top = view[0];
    const yOf = (depth: number) => TOP + ((depth - top) / span) * PLOT_HEIGHT;
    return tracks.flatMap((track) => {
      const log = logOf(track);
      // A track this core has no values for gets no panel (whatever the zoom
      // or scale, so its log toggle stays reachable).
      const has = core.rows.some(
        (row) => (showBad || !isBad(row)) && trackValue(row, track) !== undefined,
      );
      if (!has) return [];
      const good = trackPoints(core.rows, track, { bad: false, log, window: view });
      const bad = showBad ? trackPoints(core.rows, track, { bad: true, log, window: view }) : [];
      const domain = valueDomain(
        (good.length ? good : bad).map((p) => p.value),
        log,
      );
      const x = valueX(domain, log, 0);
      const { runs, off } = splitOffScale(segments(good), domain, log);
      const path = runs
        .map((run) =>
          decimate(run, yOf)
            .map((p, i) => `${i ? "L" : "M"}${x(p.value).toFixed(1)},${yOf(p.depth).toFixed(1)}`)
            .join(""),
        )
        .join("");
      const offTicks = decimate(off, yOf).map((p) => ({
        depth: p.depth,
        low: (log ? Math.log10(p.value) : p.value) < domain[0],
      }));
      return [{ track, log, good, bad: decimate(bad, yOf), domain, path, off: offTicks }];
    });
  }, [core, tracks, showBad, view, span, logKey]);

  if (!view || panels.length === 0) {
    return (
      <div>
        <div className="mb-1 text-[13px] font-bold">{core.name}</div>
        <p className="text-[13px] text-ink-faint">No plottable tracks for {core.name}.</p>
      </div>
    );
  }

  const plotRight = AXIS_LEFT + panels.length * (PANEL_WIDTH + PANEL_GAP) - PANEL_GAP;
  const width = plotRight + SECTION_RIGHT;
  const height = TOP + PLOT_HEIGHT + FOOTER;
  const depthTicks = niceTicks(view[0], view[1], 6);
  const sections = core.sections.filter((s) => s.bottom >= view[0] && s.top <= view[1]);
  const tolerance = (span / PLOT_HEIGHT) * 6;

  const depthAt = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    return view[0] + fraction * span;
  };
  const onPointerDown = (event: PointerEvent<SVGRectElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const depth = depthAt(event);
    setBrush({ from: depth, to: depth });
  };
  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const depth = depthAt(event);
    setHover(depth);
    if (brush) setBrush({ ...brush, to: depth });
  };
  const onPointerUp = () => {
    if (brush && Math.abs(y(brush.to) - y(brush.from)) > 4) {
      setZoom([Math.min(brush.from, brush.to), Math.max(brush.from, brush.to)]);
    }
    setBrush(null);
  };

  return (
    <div className="overflow-x-auto">
      <div className="mb-1 flex items-baseline gap-3 text-[13px]">
        <span className="font-bold">{core.name}</span>
        {zoom && (
          <>
            <span className="text-[12px] text-ink-faint">
              {formatValue(zoom[0])}–{formatValue(zoom[1])} m
            </span>
            <button
              type="button"
              className="cursor-pointer text-[12px] text-node hover:underline"
              onClick={() => setZoom(null)}
            >
              Reset zoom
            </button>
          </>
        )}
      </div>
      {/* Track headers: label (full text on hover) and the scale toggle. */}
      <div className="flex" style={{ paddingLeft: AXIS_LEFT, width }}>
        {panels.map(({ track, log }) => (
          <div
            key={track.key}
            className="flex min-w-0 items-baseline justify-between gap-1"
            style={{ width: PANEL_WIDTH, marginRight: PANEL_GAP }}
          >
            <span
              className="truncate text-[10px] font-bold"
              style={{ color: track.color }}
              title={track.label}
            >
              {track.label}
            </span>
            {!track.ratio?.log && (
              <button
                type="button"
                aria-pressed={log}
                title={log ? "Log scale (switch to linear)" : "Linear scale (switch to log)"}
                aria-label={`Log scale for ${track.label}`}
                onClick={() => onToggleLog(track)}
                className={`shrink-0 cursor-pointer rounded px-1 text-[9px] leading-[14px] ${
                  log ? "bg-gray-600 text-white" : "border border-gray-300 text-gray-500"
                }`}
              >
                log
              </button>
            )}
          </div>
        ))}
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Depth plot for ${core.name}`}
        className="er-light bg-surface select-none"
      >
        <defs>
          {panels.map(({ track }, index) => (
            <clipPath key={track.key} id={`${uid}-clip-${index}`}>
              <rect
                x={AXIS_LEFT + index * (PANEL_WIDTH + PANEL_GAP)}
                y={TOP}
                width={PANEL_WIDTH}
                height={PLOT_HEIGHT}
              />
            </clipPath>
          ))}
        </defs>

        {/* Shared depth axis (increasing downward) and its gridlines. */}
        <line
          x1={AXIS_LEFT - 6}
          y1={TOP}
          x2={AXIS_LEFT - 6}
          y2={TOP + PLOT_HEIGHT}
          stroke="var(--color-gray-400)"
        />
        {depthTicks.map((tick) => (
          <g key={`tick-${tick}`}>
            <line
              x1={AXIS_LEFT}
              y1={y(tick)}
              x2={plotRight}
              y2={y(tick)}
              stroke="var(--color-gray-100)"
            />
            <line
              x1={AXIS_LEFT - 10}
              y1={y(tick)}
              x2={AXIS_LEFT - 6}
              y2={y(tick)}
              stroke="var(--color-gray-400)"
            />
            <text
              x={AXIS_LEFT - 12}
              y={y(tick) + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--color-gray-500)"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}
        <text
          x={10}
          y={TOP + PLOT_HEIGHT / 2}
          fontSize={9}
          fill="var(--color-gray-500)"
          transform={`rotate(-90 10 ${TOP + PLOT_HEIGHT / 2})`}
          textAnchor="middle"
        >
          Depth (m)
        </text>

        {/* Section boundaries, named in the right margin. */}
        {sections.map((section, index) => {
          const top = Math.max(section.top, view[0]);
          const bottom = Math.min(section.bottom, view[1]);
          return (
            <g key={`${section.section}-${section.top}`}>
              {index > 0 && section.top > view[0] && (
                <line
                  x1={AXIS_LEFT}
                  y1={y(section.top)}
                  x2={plotRight + 4}
                  y2={y(section.top)}
                  stroke="var(--color-gray-400)"
                  strokeDasharray="3 3"
                />
              )}
              {y(bottom) - y(top) >= 12 && (
                <text
                  x={plotRight + 6}
                  y={(y(top) + y(bottom)) / 2 + 3}
                  fontSize={9}
                  fill="var(--color-gray-500)"
                >
                  <title>Section {section.section}</title>
                  {section.section}
                </text>
              )}
            </g>
          );
        })}

        {panels.map((panel, index) => (
          <TrackPanel
            key={panel.track.key}
            panel={panel}
            x0={AXIS_LEFT + index * (PANEL_WIDTH + PANEL_GAP)}
            y={y}
            clip={`url(#${uid}-clip-${index})`}
            hover={hover}
            tolerance={tolerance}
          />
        ))}

        {/* The hover line and its depth. */}
        {hover !== null && (
          <g pointerEvents="none">
            <line
              x1={AXIS_LEFT - 6}
              y1={y(hover)}
              x2={plotRight}
              y2={y(hover)}
              stroke="var(--color-gray-600)"
              strokeWidth={0.75}
            />
            <rect
              x={0}
              y={y(hover) - 7}
              width={AXIS_LEFT - 7}
              height={14}
              fill="var(--color-gray-700)"
            />
            <text x={AXIS_LEFT - 10} y={y(hover) + 3} textAnchor="end" fontSize={9} fill="white">
              {formatValue(hover)} m
            </text>
          </g>
        )}
        {brush && (
          <rect
            x={AXIS_LEFT}
            y={Math.min(y(brush.from), y(brush.to))}
            width={plotRight - AXIS_LEFT}
            height={Math.abs(y(brush.to) - y(brush.from))}
            fill="var(--node-color)"
            fillOpacity={0.12}
            stroke="var(--node-color)"
            pointerEvents="none"
          />
        )}
        {/* Pointer surface: hover readout, drag to zoom, double-click to reset. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut over the plot; Reset zoom is a button and every value is on the Data tab */}
        <rect
          x={AXIS_LEFT}
          y={TOP}
          width={plotRight - AXIS_LEFT}
          height={PLOT_HEIGHT}
          fill="transparent"
          className="cursor-crosshair"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => !brush && setHover(null)}
          onDoubleClick={() => setZoom(null)}
        />
      </svg>
    </div>
  );
}

/** Value (in data units) to x within a panel starting at x0. */
function valueX(domain: [number, number], log: boolean, x0: number) {
  const [lo, hi] = domain;
  return (value: number) =>
    x0 + (((log ? Math.log10(value) : value) - lo) / (hi - lo || 1)) * PANEL_WIDTH;
}

function TrackPanel({
  panel,
  x0,
  y,
  clip,
  hover,
  tolerance,
}: {
  panel: Panel;
  x0: number;
  y: (depth: number) => number;
  clip: string;
  hover: number | null;
  tolerance: number;
}) {
  const { track, log, good, bad, domain, path, off } = panel;
  const x = valueX(domain, log, x0);
  const ticks = log ? logTicks(domain[0], domain[1]) : niceTicks(domain[0], domain[1], 3);
  const tickX = (tick: number) =>
    x0 + ((tick - domain[0]) / (domain[1] - domain[0] || 1)) * PANEL_WIDTH;
  const at = hover === null ? undefined : nearest(good, hover);
  const near = at && hover !== null && Math.abs(at.depth - hover) <= tolerance ? at : undefined;
  const readout = near ? formatValue(near.value) : null;

  return (
    <g>
      {ticks.map((tick) => (
        <g key={`v-${tick}`}>
          <line
            x1={tickX(tick)}
            y1={TOP}
            x2={tickX(tick)}
            y2={TOP + PLOT_HEIGHT + 3}
            stroke="var(--color-gray-100)"
          />
          <text
            x={tickX(tick)}
            y={TOP + PLOT_HEIGHT + 12}
            // Labels near an edge grow inward, clear of the next panel's.
            textAnchor={
              tickX(tick) < x0 + 14
                ? "start"
                : tickX(tick) > x0 + PANEL_WIDTH - 14
                  ? "end"
                  : "middle"
            }
            fontSize={8.5}
            fill="var(--color-gray-500)"
          >
            {formatValue(log ? 10 ** tick : tick)}
          </text>
        </g>
      ))}
      <text
        x={x0 + PANEL_WIDTH / 2}
        y={TOP + PLOT_HEIGHT + 23}
        textAnchor="middle"
        fontSize={8.5}
        fill="var(--color-gray-400)"
      >
        {log ? "log scale" : (track.unit ?? "")}
      </text>
      <rect
        x={x0}
        y={TOP}
        width={PANEL_WIDTH}
        height={PLOT_HEIGHT}
        fill="none"
        stroke="var(--color-gray-300)"
      />
      <g clipPath={clip}>
        {/* The path's x is panel-relative (computed once per zoom). */}
        <path
          d={path}
          transform={`translate(${x0},0)`}
          fill="none"
          stroke={track.color}
          strokeWidth={1.1}
        />
        {off.length > 0 && (
          <path
            d={off
              .map(({ depth, low }) => {
                const edge = low ? x0 : x0 + PANEL_WIDTH;
                return `M${edge},${y(depth).toFixed(1)}h${low ? 4 : -4}`;
              })
              .join("")}
            stroke={track.color}
            strokeOpacity={0.6}
          >
            <title>{`${off.length} off-scale values`}</title>
          </path>
        )}
        {bad.map((p, i) => (
          <circle
            key={`b-${i}`}
            cx={x(p.value)}
            cy={y(p.depth)}
            r={1.6}
            fill={BAD_COLOR}
            fillOpacity={0.55}
          />
        ))}
        {near && (
          <circle cx={x(near.value)} cy={y(near.depth)} r={3} fill={track.color} stroke="white" />
        )}
      </g>
      {readout && (
        <g pointerEvents="none">
          <rect
            x={x0 + 2}
            y={TOP + 2}
            width={readout.length * 5.4 + 6}
            height={13}
            rx={2}
            fill="white"
            fillOpacity={0.9}
            stroke={track.color}
            strokeWidth={0.5}
          />
          <text x={x0 + 5} y={TOP + 12} fontSize={9} fill={track.color} fontWeight="bold">
            {readout}
          </text>
        </g>
      )}
    </g>
  );
}
