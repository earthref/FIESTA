// Depth plots: a contribution's cores as multi-track SVG plots with track
// chips, reorderable and recolorable tracks, a flagged-point toggle,
// robust/log value scales, section boundaries, a hover readout across tracks
// and drag-to-zoom on depth.

import {
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
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

const PANEL_WIDTH = 132;
const PANEL_GAP = 14;
const PLOT_HEIGHT = 800;
const AXIS_LEFT = 62;
const SECTION_RIGHT = 40;
const TOP = 8;
const FOOTER = 40;
/** The least text size: the modal's count pills (11px). */
const FONT = 11;
const BAD_COLOR = "#d62728";
const DRAG_TYPE = "application/x-depth-plot-track";

/** A viewer's track choices, kept per node in this browser: tracks added
 * beyond the defaults, defaults taken away, the order and colors picked, and
 * log overrides. */
interface PlotSettings {
  on: string[];
  off: string[];
  order: string[];
  colors: Record<string, string>;
  logs: Record<string, boolean>;
}

const NO_SETTINGS: PlotSettings = { on: [], off: [], order: [], colors: {}, logs: {} };

function loadSettings(key: string): PlotSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!stored || typeof stored !== "object") return NO_SETTINGS;
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
    const map = (value: unknown) => (value && typeof value === "object" ? value : {});
    return {
      on: list(stored.on),
      off: list(stored.off),
      order: list(stored.order),
      colors: map(stored.colors) as Record<string, string>,
      logs: map(stored.logs) as Record<string, boolean>,
    };
  } catch {
    return NO_SETTINGS;
  }
}

function usePlotSettings(key: string) {
  const [settings, setSettings] = useState(() => loadSettings(key));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      // Private window or blocked storage: the choices last for this visit.
    }
  }, [key, settings]);
  return [settings, setSettings] as const;
}

const hex = (color: string) => (/^#[0-9a-f]{6}$/i.test(color) ? color : "#666666");

/** The viewer's track choices over a set of tracks (one contribution's, or
 * the union of every plotted contribution's): which are shown and in what
 * order and colors, their scales and the flagged-point toggle. One set of
 * controls drives every plot under it. */
export function useTrackControls(tracks: TrackDef[], storageKey: string) {
  const [settings, setSettings] = usePlotSettings(storageKey);
  const [showBad, setShowBad] = useState(false);

  const colored = (t: TrackDef) =>
    settings.colors[t.key] ? { ...t, color: settings.colors[t.key] } : t;
  const isOn = (t: TrackDef) =>
    settings.on.includes(t.key) || (t.default && !settings.off.includes(t.key));
  const rank = (t: TrackDef) => {
    const at = settings.order.indexOf(t.key);
    return at >= 0 ? at : settings.order.length + tracks.indexOf(t);
  };
  const shown = tracks
    .filter(isOn)
    .sort((a, b) => rank(a) - rank(b))
    .map(colored);
  const logOf = (track: TrackDef) => settings.logs[track.key] ?? track.log;

  const toggle = (track: TrackDef) =>
    setSettings((prev) => {
      const without = (list: string[]) => list.filter((k) => k !== track.key);
      if (isOn(track)) {
        return track.default
          ? { ...prev, on: without(prev.on), off: [...without(prev.off), track.key] }
          : { ...prev, on: without(prev.on) };
      }
      // Switched on: it goes to the end of the plots.
      const order = [...shown.map((t) => t.key), track.key];
      return {
        ...prev,
        on: track.default ? prev.on : [...without(prev.on), track.key],
        off: without(prev.off),
        order: [...order, ...prev.order.filter((k) => !order.includes(k))],
      };
    });
  /** Move a shown track to another's place (or by a step, from the keyboard). */
  const move = (key: string, target: string | number) =>
    setSettings((prev) => {
      const keys = shown.map((t) => t.key);
      const from = keys.indexOf(key);
      const to = typeof target === "number" ? from + target : keys.indexOf(target);
      if (from < 0 || to < 0 || to >= keys.length || from === to) return prev;
      keys.splice(to, 0, ...keys.splice(from, 1));
      return { ...prev, order: [...keys, ...prev.order.filter((k) => !keys.includes(k))] };
    });

  return {
    chips: {
      tracks: tracks.map(colored),
      isOn,
      onToggle: toggle,
      onDefaults: () => setSettings((prev) => ({ ...NO_SETTINGS, colors: prev.colors })),
      onAll: () => setSettings((prev) => ({ ...prev, on: tracks.map((t) => t.key), off: [] })),
      onNone: () =>
        setSettings((prev) => ({
          ...prev,
          on: [],
          off: tracks.filter((t) => t.default).map((t) => t.key),
        })),
      showBad,
      onShowBad: setShowBad,
    },
    plots: {
      tracks: shown,
      showBad,
      logOf,
      onToggleLog: (track: TrackDef) =>
        setSettings((prev) => ({ ...prev, logs: { ...prev.logs, [track.key]: !logOf(track) } })),
      onMove: move,
      onColor: (track: TrackDef, color: string) =>
        setSettings((prev) => ({ ...prev, colors: { ...prev.colors, [track.key]: color } })),
    },
  };
}

export type TrackControls = ReturnType<typeof useTrackControls>;

/** Rows flagged bad across cores, for the flagged-point toggle. */
export const badCountOf = (cores: CoreData[]) =>
  cores.reduce((n, core) => n + core.rows.filter(isBad).length, 0);

/** The controls bar: every track as a chip and the flagged-point toggle. */
export function TrackControlsBar({
  controls,
  badCount,
}: {
  controls: TrackControls;
  badCount: number;
}) {
  return <TrackChips {...controls.chips} badCount={badCount} />;
}

/** Cores' plots, drawn with the controls' tracks, order, colors and scales. */
export function CorePlots({ cores, controls }: { cores: CoreData[]; controls: TrackControls }) {
  return (
    <div className="flex flex-wrap gap-6">
      {cores.map((core) => (
        <CoreTracks key={core.name} core={core} {...controls.plots} />
      ))}
    </div>
  );
}

/** One contribution's plots under their own controls (the modal's tab). */
export function ContributionPlots({
  payload,
  storageKey,
}: {
  payload: Payload;
  storageKey: string;
}) {
  const controls = useTrackControls(payload.tracks, storageKey);
  const badCount = useMemo(() => badCountOf(payload.cores), [payload.cores]);
  return (
    <>
      <TrackControlsBar controls={controls} badCount={badCount} />
      <CorePlots cores={payload.cores} controls={controls} />
    </>
  );
}

/** Every track as a toggle chip, by group, above the plots. */
function TrackChips({
  tracks,
  isOn,
  onToggle,
  onDefaults,
  onAll,
  onNone,
  badCount,
  showBad,
  onShowBad,
}: {
  tracks: TrackDef[];
  isOn: (track: TrackDef) => boolean;
  onToggle: (track: TrackDef) => void;
  onDefaults: () => void;
  onAll: () => void;
  onNone: () => void;
  badCount: number;
  showBad: boolean;
  onShowBad: (show: boolean) => void;
}) {
  const groups = [...new Set(tracks.map((t) => t.group))];
  const linkClass = "cursor-pointer text-node hover:underline";
  return (
    <div className="mb-4 text-[13px]">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-bold">
          Tracks{" "}
          <span className="font-normal text-ink-faint">
            ({tracks.filter(isOn).length} of {tracks.length})
          </span>
        </span>
        <button type="button" className={linkClass} onClick={onDefaults}>
          Defaults
        </button>
        <button type="button" className={linkClass} onClick={onAll}>
          All
        </button>
        <button type="button" className={linkClass} onClick={onNone}>
          None
        </button>
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
              className="inline-block size-2.5 rounded-full"
              style={{ background: BAD_COLOR }}
            />
          </label>
        )}
      </div>
      {groups.map((group) => (
        <div key={group} className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="w-full text-[11px] font-bold uppercase tracking-wide text-ink-faint sm:w-44 sm:shrink-0">
            {group}
          </span>
          {tracks
            .filter((t) => t.group === group)
            .map((track) => {
              const on = isOn(track);
              return (
                <button
                  key={track.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggle(track)}
                  title={on ? `Hide ${track.label}` : `Plot ${track.label}`}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node ${
                    on ? "font-bold" : "border-gray-300 text-gray-500 hover:bg-gray-50"
                  }`}
                  style={on ? { borderColor: track.color, color: track.color } : undefined}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ background: on ? track.color : "var(--color-gray-300)" }}
                  />
                  {track.label}
                </button>
              );
            })}
        </div>
      ))}
      <p className="m-0 mt-2 text-[12px] text-ink-faint">
        Drag a plot's header to reorder it, click its swatch to change its color; drag on a plot to
        zoom in on depth, double-click to reset.
      </p>
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
  onMove,
  onColor,
}: {
  core: CoreData;
  tracks: TrackDef[];
  showBad: boolean;
  logOf: (track: TrackDef) => boolean;
  onToggleLog: (track: TrackDef) => void;
  onMove: (key: string, target: string | number) => void;
  onColor: (track: TrackDef, color: string) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
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
  const depthTicks = niceTicks(view[0], view[1], 12);
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
      {/* Track headers: drag one onto another to reorder (or arrow keys on
          its grip), the swatch picks its color, and the scale toggle. */}
      <div className="flex" style={{ paddingLeft: AXIS_LEFT, width }}>
        {panels.map(({ track, log }) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: dragging is the pointer path; the grip button moves it by keyboard
          <div
            key={track.key}
            draggable
            onDragStart={(event: DragEvent<HTMLDivElement>) => {
              event.dataTransfer.setData(DRAG_TYPE, track.key);
              event.dataTransfer.effectAllowed = "move";
              setDragging(track.key);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropOn(null);
            }}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropOn(track.key);
            }}
            onDragLeave={() => setDropOn((key) => (key === track.key ? null : key))}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              const key = event.dataTransfer.getData(DRAG_TYPE);
              if (key) onMove(key, track.key);
              setDragging(null);
              setDropOn(null);
            }}
            className={`min-w-0 cursor-grab rounded-t border-b-2 px-1 pb-1 active:cursor-grabbing ${
              dragging === track.key ? "opacity-40" : ""
            } ${dropOn === track.key && dragging !== track.key ? "bg-gray-100" : ""}`}
            style={{ width: PANEL_WIDTH, marginRight: PANEL_GAP, borderColor: track.color }}
          >
            <div
              className="truncate text-[12px] font-bold leading-[18px]"
              style={{ color: track.color }}
              title={track.label}
            >
              {track.label}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={`Move ${track.label}: left and right arrow keys`}
                title="Drag to reorder, or use the left and right arrow keys"
                onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
                  if (!step) return;
                  event.preventDefault();
                  onMove(track.key, step);
                }}
                className="cursor-grab rounded px-0.5 text-[13px] leading-none text-gray-400 hover:text-gray-600 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
              >
                ⠿
              </button>
              <input
                type="color"
                value={hex(track.color)}
                onChange={(event) => onColor(track, event.target.value)}
                aria-label={`Color of ${track.label}`}
                title="Change the color"
                className="size-[18px] cursor-pointer rounded border border-gray-300 bg-transparent p-0"
              />
              {!track.ratio?.log && (
                <button
                  type="button"
                  aria-pressed={log}
                  title={log ? "Log scale (switch to linear)" : "Linear scale (switch to log)"}
                  aria-label={`Log scale for ${track.label}`}
                  onClick={() => onToggleLog(track)}
                  className={`ml-auto shrink-0 cursor-pointer rounded px-1.5 text-[11px] leading-[18px] ${
                    log ? "bg-gray-600 text-white" : "border border-gray-300 text-gray-500"
                  }`}
                >
                  log
                </button>
              )}
            </div>
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
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={FONT}
              fill="var(--color-gray-500)"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}
        <text
          x={10}
          y={TOP + PLOT_HEIGHT / 2}
          fontSize={FONT}
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
              {y(bottom) - y(top) >= 16 && (
                <text
                  x={plotRight + 6}
                  y={(y(top) + y(bottom)) / 2 + 3}
                  fontSize={FONT}
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
              y={y(hover) - 8}
              width={AXIS_LEFT - 7}
              height={16}
              fill="var(--color-gray-700)"
            />
            <text x={AXIS_LEFT - 10} y={y(hover) + 4} textAnchor="end" fontSize={FONT} fill="white">
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
            y={TOP + PLOT_HEIGHT + 15}
            // Labels near an edge grow inward, clear of the next panel's.
            textAnchor={
              tickX(tick) < x0 + 18
                ? "start"
                : tickX(tick) > x0 + PANEL_WIDTH - 18
                  ? "end"
                  : "middle"
            }
            fontSize={FONT}
            fill="var(--color-gray-500)"
          >
            {formatValue(log ? 10 ** tick : tick)}
          </text>
        </g>
      ))}
      <text
        x={x0 + PANEL_WIDTH / 2}
        y={TOP + PLOT_HEIGHT + 31}
        textAnchor="middle"
        fontSize={FONT}
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
            width={readout.length * 6.7 + 8}
            height={16}
            rx={2}
            fill="white"
            fillOpacity={0.9}
            stroke={track.color}
            strokeWidth={0.5}
          />
          <text x={x0 + 6} y={TOP + 14} fontSize={FONT} fill={track.color} fontWeight="bold">
            {readout}
          </text>
        </g>
      )}
    </g>
  );
}
