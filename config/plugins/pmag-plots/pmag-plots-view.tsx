import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EChart, type EChartsOption } from "@/components/echart";
import { ErrorMessage } from "@/components/error-message";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { cx } from "@/lib/utils";
import {
  araiOption,
  demagOption,
  deremagOption,
  directionSetOption,
  fitTitle,
  hysteresisOption,
  type Size,
  stepsNetOption,
  zijderveldOption,
} from "./pmag-plots-charts";
import {
  type AraiSpecimen,
  COORD_LABELS,
  COORDS,
  type Coord,
  type DemagSpecimen,
  type DirectionSet,
  type Kind,
  nf,
  PLOTS,
  type PlotData,
  type PlotType,
  whereOf,
} from "./pmag-plots-data";

const CARD_HEIGHT = 130;
/** A card's narrowest width before the grid drops a column, and the gap. */
const CARD_MIN_WIDTH = 150;
const CARD_GAP = 8;
/** A row of cards: the chart, its title and borders. */
const CARD_ROW_ESTIMATE = CARD_HEIGHT + 28;
const LARGE_HEIGHT = 520;
/** From this width the selected plot sits beside the cards, not above them. */
const SIDE_BY_SIDE = 960;

/** One plot of the grid: a specimen's, or a group's directions. */
interface PlotItem {
  key: string;
  title: string;
  where: string;
  /** Lower-cased names the filter matches. */
  names: string;
  /** Equal Area: the data model level plotted. */
  level?: string;
  /** Coordinate systems it can be drawn in (Equal Area, Zijderveld). */
  coords?: Coord[];
  build: (size: Size, coord: Coord, large: boolean) => EChartsOption;
  note?: (coord: Coord) => ReactNode;
}

// What each plot type's symbols mean, under its controls.
const LEGENDS: Record<PlotType, string> = {
  eqarea:
    "Equal-area, lower hemisphere filled, upper open · ▲ Fisher mean with α95 · great circles are planes · ◆ best-fit lines",
  zijd: "● horizontal projection (N, E) · □ vertical projection (N, Down) · dashed: published best-fit lines",
  demag: "Intensity over its maximum at each treatment step · ◆ steps flagged bad",
  arai: "● ZI steps · □ IZ steps · △ pTRM checks · ■ pTRM tail checks · dashed: slope over the published interpretation's steps",
  deremag: "● NRM remaining · ■ pTRM gained, over the NRM, at each temperature",
  hyst: "Moment against applied field",
};

function useKind<K extends Kind>(kind: K, id: string, privateKey?: string, enabled = true) {
  return useQuery({
    queryKey: ["plugin", "pmag-plots", kind, id, privateKey],
    queryFn: () =>
      api<PlotData[K]>(`/plugins/pmag-plots/contributions/${id}/${kind}`, {
        params: { private_key: privateKey || undefined },
      }),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export default function PmagPlotsView({
  type,
  id,
  privateKey,
  selected,
  onSelect,
}: {
  type: PlotType;
  id: string;
  privateKey?: string;
  /** The selected plot's key (`?plot=`), or none for the first. */
  selected?: string;
  onSelect?: (key: string) => void;
}) {
  const { kind } = PLOTS[type];
  const demag = useKind("demag", id, privateKey, kind === "demag" || type === "eqarea");
  const eqarea = useKind("eqarea", id, privateKey, kind === "eqarea");
  const arai = useKind("arai", id, privateKey, kind === "arai");
  const hyst = useKind("hyst", id, privateKey, kind === "hyst");
  const queries = { demag, eqarea, arai, hyst };
  const active = type === "eqarea" ? [eqarea, demag] : [queries[kind]];

  const items = useMemo(
    () =>
      plotItems(type, {
        demag: demag.data,
        eqarea: eqarea.data,
        arai: arai.data,
        hyst: hyst.data,
      }),
    [type, demag.data, eqarea.data, arai.data, hyst.data],
  );

  const failed = active.find((query) => query.error);
  if (failed) return <ErrorMessage error={failed.error} className="m-3" />;
  if (active.some((query) => query.isPending)) return <PageSpinner label="Loading plots…" />;
  return <PlotGrid type={type} items={items} selected={selected} onSelect={onSelect} />;
}

// --- items per plot type -------------------------------------------------------------------

function plotItems(type: PlotType, data: Partial<PlotData>): PlotItem[] {
  const specimenItem = (s: DemagSpecimen | AraiSpecimen) => ({
    key: s.specimen,
    title: s.specimen,
    where: whereOf(s),
    names: [s.specimen, s.sample, s.site, s.location].join(" ").toLowerCase(),
  });
  const demagSpecimens = data.demag?.specimens ?? [];
  const araiSpecimens = data.arai?.specimens ?? [];
  // The equal-area net (the same in both responses).
  const net = data.eqarea?.net ?? data.demag?.net ?? { rim: [], ticks: [] };
  switch (type) {
    case "eqarea":
      return [
        ...(data.eqarea?.plots ?? []).map((group) => ({
          key: `${group.level}:${group.name}`,
          title:
            group.group_level === "location"
              ? `${group.level} of ${group.name || "the contribution"}`
              : `${group.level} of site ${group.name || "(none)"}`,
          where: "",
          names: group.name.toLowerCase(),
          level: group.level,
          coords: COORDS.filter((coord) => group.sets[coord]),
          build: (size: Size, coord: Coord) =>
            directionSetOption(size, group.sets[coord] as DirectionSet, net),
          note: (coord: Coord) => setNote(group.sets[coord] as DirectionSet),
        })),
        ...demagSpecimens.map((s) => ({
          ...specimenItem(s),
          level: "Measurements",
          coords: coordsOf(s),
          build: (size: Size, coord: Coord) => stepsNetOption(size, s, coord, net),
          note: (coord: Coord) => fitsNote(s, coord),
        })),
      ];
    case "zijd":
      return demagSpecimens.map((s) => ({
        ...specimenItem(s),
        coords: coordsOf(s),
        build: (size, coord, large) => zijderveldOption(size, s, coord, large),
        note: (coord) => fitsNote(s, coord),
      }));
    case "demag":
      return demagSpecimens.map((s) => ({
        ...specimenItem(s),
        build: (size, _coord, large) => demagOption(size, s, large),
      }));
    case "arai":
      return araiSpecimens.map((s) => ({
        ...specimenItem(s),
        build: (size, _coord, large) => araiOption(size, s, large),
        note: () => araiNote(s),
      }));
    case "deremag":
      return araiSpecimens.map((s) => ({
        ...specimenItem(s),
        build: (size, _coord, large) => deremagOption(size, s, large),
        note: () => araiNote(s),
      }));
    case "hyst":
      return (data.hyst?.loops ?? []).map((loop) => ({
        key: `${loop.specimen}:${loop.experiment}`,
        title: loop.specimen,
        where: [loop.experiment, whereOf(loop)].filter(Boolean).join(" · "),
        names: [loop.specimen, loop.experiment, loop.site, loop.location].join(" ").toLowerCase(),
        build: (size, _coord, large) => hysteresisOption(size, loop, large),
        note: () => `${loop.field.length} measurements`,
      }));
  }
}

function coordsOf(specimen: DemagSpecimen): Coord[] {
  return COORDS.filter((coord) => specimen.coords[coord] !== undefined);
}

function stepUnit(specimen: DemagSpecimen): string {
  const steps = specimen.steps.kind.filter((k) => k !== "NRM");
  if (steps.filter((k) => k === "AF").length * 2 >= steps.length) return "mT";
  return steps.filter((k) => k === "MW").length * 2 > steps.length ? "J" : "°C";
}

function fitsNote(specimen: DemagSpecimen, coord: Coord): ReactNode {
  const fits = specimen.fits.filter((fit) => fit.coord === coord);
  if (fits.length === 0) return null;
  const unit = stepUnit(specimen);
  return fits.map((fit) => (
    <div key={`${fit.comp}:${fit.type}:${fit.dec}`}>
      {fitTitle(fit)}: D {nf(fit.dec)}° I {nf(fit.inc)}°
      {fit.mad !== null && ` · MAD ${nf(fit.mad)}°`}
      {fit.min !== null && fit.max !== null && ` · ${nf(fit.min)}–${nf(fit.max)} ${unit}`}
    </div>
  ));
}

function setNote(set: DirectionSet): ReactNode {
  const mean = set.mean;
  const planes = set.dirs.filter((d) => d.plane).length;
  return (
    <>
      {set.dirs.length} direction{set.dirs.length === 1 ? "" : "s"}
      {planes > 0 && ` (${planes} plane${planes === 1 ? "" : "s"})`}
      {mean && (
        <>
          {" "}
          · mean D {nf(mean.dec)}° I {nf(mean.inc)}°
          {mean.a95 !== undefined && ` · α95 ${nf(mean.a95)}°`}
          {mean.k !== undefined && ` · k ${nf(mean.k)}`}
        </>
      )}
    </>
  );
}

const CORRECTIONS: Record<string, string> = {
  aniso: "anisotropy",
  cooling_rate: "cooling rate",
  nlt: "non-linear TRM",
  arm: "ARM",
};

function araiNote(specimen: AraiSpecimen): ReactNode {
  const { fit, lab_field: lab } = specimen;
  const parts = [
    `NRM₀ ${nf(specimen.nrm0)} ${specimen.unit}`,
    ...(lab !== null ? [`Blab ${nf(lab)} µT`] : []),
  ];
  if (fit?.b !== undefined) {
    const corrections = Object.entries(fit.corrections ?? {}).map(
      ([name, factor]) => `${CORRECTIONS[name] ?? name} ${nf(factor)}`,
    );
    const sigma = fit.b_sigma !== undefined ? ` ± ${nf(fit.b_sigma)}` : "";
    const stats = (["f", "g", "q"] as const).flatMap((key) => {
      const value = fit[key];
      return value !== undefined ? [`${key} ${nf(value)}`] : [];
    });
    parts.push(
      `b ${nf(fit.b)}${sigma} over ${nf(fit.min ?? 0)}–${nf(fit.max ?? 0)} °C (n ${fit.n})`,
      ...stats,
      ...(fit.int_calc !== undefined
        ? [`B ${nf(fit.int_calc)} µT${corrections.length ? ` (× ${corrections.join(", ")})` : ""}`]
        : []),
    );
  }
  if (fit?.int_abs !== null && fit?.int_abs !== undefined)
    parts.push(`published ${nf(fit.int_abs)} µT`);
  return parts.join(" · ");
}

// --- the grid ------------------------------------------------------------------------------

const LEVELS = ["Sites", "Samples", "Specimens", "Measurements"];

/** The item a `?plot=` key names: its own key, else (a link from a summary's
 * Plot tile) a hysteresis loop of that specimen or an equal-area group of that
 * name at any level. */
function itemFor(items: PlotItem[], key: string | undefined): PlotItem | undefined {
  if (!key) return undefined;
  return (
    items.find((item) => item.key === key) ??
    items.find((item) => item.key.startsWith(`${key}:`) || item.key.endsWith(`:${key}`))
  );
}

/** Watches an element's width. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * A plot type's tab: the selected plot drawn large and interactive (the
 * first, or `selected`), and every plot of the level as a small card to pick
 * from, below it or, on a wide view, beside it.
 */
function PlotGrid({
  type,
  items,
  selected,
  onSelect,
}: {
  type: PlotType;
  items: PlotItem[];
  selected?: string;
  onSelect?: (key: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const outer = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const wide = useWidth(outer) >= SIDE_BY_SIDE;
  const levelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items)
      if (item.level) counts.set(item.level, (counts.get(item.level) ?? 0) + 1);
    return counts;
  }, [items]);
  const [chosen, setChosen] = useState(() => itemFor(items, selected)?.key);
  // Opened on a plot: its level; otherwise the first with plots.
  const [level, setLevel] = useState(
    () => itemFor(items, selected)?.level ?? LEVELS.find((l) => levelCounts.has(l)),
  );
  // A new `?plot=` while the tab is open (another Plot tile clicked).
  useEffect(() => {
    const item = itemFor(items, selected);
    if (!item) return;
    setChosen(item.key);
    if (item.level) setLevel(item.level);
  }, [items, selected]);
  const leveled = level ? items.filter((item) => item.level === level) : items;
  const coords = COORDS.filter((coord) => leveled.some((item) => item.coords?.includes(coord)));
  const [coord, setCoord] = useState<Coord>(() => coords[0] ?? "g");
  const needle = filter.trim().toLowerCase();
  const shown = needle ? leveled.filter((item) => item.names.includes(needle)) : leveled;
  // The chosen plot, or the first shown when it is filtered out or on another level.
  const index = Math.max(
    0,
    shown.findIndex((item) => item.key === chosen),
  );
  const current = shown[index];
  const choose = (item: PlotItem) => {
    setChosen(item.key);
    onSelect?.(item.key);
  };
  const toTop = () => scroller.current?.scrollTo({ top: 0 });

  const controls = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
      {levelCounts.size > 0 && (
        <Choices
          label="Level"
          options={LEVELS.filter((l) => levelCounts.has(l)).map((l) => ({
            value: l,
            label: l,
            count: levelCounts.get(l),
          }))}
          value={level}
          onChange={(next) => {
            setLevel(next);
            toTop();
          }}
        />
      )}
      {coords.length > 0 && (
        <Choices
          label="Coordinates"
          options={coords.map((c) => ({ value: c, label: COORD_LABELS[c] }))}
          value={coords.includes(coord) ? coord : coords[0]}
          onChange={setCoord}
        />
      )}
      <input
        type="search"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          toTop();
        }}
        placeholder="Filter by name…"
        aria-label="Filter plots by specimen, sample, site or location"
        className="w-48 rounded-sm border border-gray-300 px-2 py-1 text-[13px]"
      />
      <span className="text-gray-500">
        {shown.length === leveled.length
          ? `${leveled.length} plot${leveled.length === 1 ? "" : "s"}`
          : `${shown.length} of ${leveled.length} plots`}
      </span>
    </div>
  );

  const coordOf = (item: PlotItem): Coord =>
    !item.coords || item.coords.includes(coord) ? coord : item.coords[0];

  const large = current && (
    <SelectedPlot
      item={current}
      // Nets and Zijderveld plots keep one scale on both axes.
      zoom={type === "eqarea" || type === "zijd" ? "square" : "xy"}
      coord={coordOf(current)}
      preferred={coord}
      position={`${index + 1} of ${shown.length}`}
    />
  );
  const cards = (
    <VirtualCards
      // A grid per layout: each mounts with its own scroller (and reveal).
      key={wide ? "beside" : "below"}
      count={shown.length}
      scrollRef={scroller}
      // Beside the plot, the cards scroll to the selected one.
      reveal={wide ? index : undefined}
      render={(i) => {
        const item = shown[i];
        return (
          <PlotCard
            key={item.key}
            item={item}
            coord={coordOf(item)}
            selected={item.key === current?.key}
            onSelect={() => choose(item)}
          />
        );
      }}
    />
  );

  return (
    // The controls stay put; the plots scroll below them.
    <div ref={outer} className="flex h-full min-h-[420px] flex-col">
      <div className="space-y-3 px-3 pt-3">
        {controls}
        <p className="text-[12px] text-gray-500">{LEGENDS[type]}</p>
      </div>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-gray-500">No plots match the filter.</p>
      ) : wide ? (
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          <div className="min-w-0 flex-[3] overflow-y-auto">{large}</div>
          <div ref={scroller} className="relative min-w-0 flex-[2] overflow-y-auto">
            {cards}
          </div>
        </div>
      ) : (
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto p-3">
          {large}
          <div className="mt-3">{cards}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The plot cards as a grid that scrolls virtually: as many columns as fit
 * (at least CARD_MIN_WIDTH each), and only the rows of cards in view, and two
 * above and below, mounted, so a contribution's hundreds of charts never all
 * draw at once. `reveal` scrolls that card into view once the columns are
 * known.
 */
function VirtualCards({
  count,
  scrollRef,
  reveal,
  render,
}: {
  count: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  reveal?: number;
  render: (index: number) => ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  // Unknown until the grid's width is measured (no rows until then).
  const [columns, setColumns] = useState<number | null>(null);
  // Where the grid starts inside the scroller (its padding, a plot above it).
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const update = () => {
      const fit = Math.floor((grid.clientWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP));
      setColumns(Math.max(1, Math.min(8, fit)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const top = gridRef.current?.offsetTop ?? 0;
    if (top !== margin) setMargin(top);
  });
  const perRow = columns ?? 1;
  const rows = columns ? Math.ceil(count / columns) : 0;
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ROW_ESTIMATE,
    overscan: 2,
    gap: CARD_GAP,
    scrollMargin: margin,
  });
  // Once the columns are known and the virtualizer has its scroller (which
  // mounts with the grid, so after the grid's first effects), the selected
  // card into view.
  // Rows not yet drawn sit at their estimated places, so the scroller goes
  // straight to the row's estimated middle and the virtualizer follows it.
  const pending = useRef(reveal);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!columns || pending.current === undefined || !scroller) return;
    const row = Math.floor(pending.current / columns);
    const middle = margin + row * (CARD_ROW_ESTIMATE + CARD_GAP) + CARD_ROW_ESTIMATE / 2;
    scroller.scrollTop = Math.max(0, middle - scroller.clientHeight / 2);
    pending.current = undefined;
  });
  return (
    <div ref={gridRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          className="absolute inset-x-0 top-0 grid"
          style={{
            gap: CARD_GAP,
            gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))`,
            transform: `translateY(${row.start - margin}px)`,
          }}
        >
          {Array.from(
            { length: Math.min(perRow, count - row.index * perRow) },
            (_, i) => row.index * perRow + i,
          ).map(render)}
        </div>
      ))}
    </div>
  );
}

function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; count?: number }[];
  value?: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex items-center gap-1.5">
      <legend className="float-left mr-1.5 font-bold text-gray-700">{label}</legend>
      <div className="inline-flex overflow-hidden rounded-sm border border-gray-300">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={cx(
              "border-l border-gray-300 px-2 py-0.5 first:border-l-0",
              option.value === value
                ? "bg-node font-bold text-white"
                : "bg-surface text-gray-700 hover:bg-gray-50",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={cx("ml-1", option.value === value ? "text-white/80" : "text-gray-500")}
              >
                {option.count}
              </span>
            )}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** A plot to pick: the whole card selects it. The small chart only shows
 * (the selected plot is the interactive one). */
function PlotCard({
  item,
  coord,
  selected,
  onSelect,
}: {
  item: PlotItem;
  coord: Coord;
  selected: boolean;
  onSelect: () => void;
}) {
  const build = useCallback((size: Size) => item.build(size, coord, false), [item, coord]);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={[item.title, item.where].filter(Boolean).join(" · ")}
      className={cx(
        "block w-full min-w-0 cursor-pointer overflow-hidden rounded-sm border bg-surface text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
        selected ? "border-node ring-1 ring-node" : "border-gray-300 hover:border-node",
      )}
    >
      <span
        className={cx(
          "block truncate border-b px-2 py-1 text-[12px] font-bold",
          selected
            ? "border-node bg-node-soft text-node-ink-strong"
            : "border-gray-200 text-node-ink",
        )}
      >
        {item.title}
      </span>
      <span className="pointer-events-none block">
        <EChart build={build} height={CARD_HEIGHT} label={`${item.title} plot`} />
      </span>
    </button>
  );
}

function PlotNote({ item, coord, preferred }: { item: PlotItem; coord: Coord; preferred: Coord }) {
  const note = item.note?.(coord);
  const fallback = item.coords && coord !== preferred;
  if (!note && !fallback) return null;
  return (
    <div className="border-t border-gray-100 px-3 py-1.5 text-[12px] text-gray-600">
      {fallback && <div className="italic">In {COORD_LABELS[coord].toLowerCase()} coordinates</div>}
      {note}
    </div>
  );
}

/** The selected plot, large: hover for values, the toolbar zooms and pans. */
function SelectedPlot({
  item,
  zoom,
  coord,
  preferred,
  position,
}: {
  item: PlotItem;
  zoom: "xy" | "square";
  coord: Coord;
  preferred: Coord;
  position: string;
}) {
  const build = useCallback((size: Size) => item.build(size, coord, true), [item, coord]);
  return (
    <section className="rounded-sm border border-gray-300 bg-surface">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-gray-200 px-3 py-2">
        <h4 className="text-[14px] font-bold text-gray-900">{item.title}</h4>
        <span className="text-[12px] text-gray-500">{item.where}</span>
        <span className="ml-auto text-[12px] text-gray-500">{position}</span>
      </header>
      {/* Keyed by plot, so a newly picked one starts at its full view. */}
      <EChart
        key={item.key}
        build={build}
        height={LARGE_HEIGHT}
        zoom={zoom}
        label={`${item.title} plot`}
      />
      <PlotNote item={item} coord={coord} preferred={preferred} />
      <p className="px-3 pb-2 text-[11px] text-gray-400">
        Hover a point for its values; the plot's toolbar zooms (a box, or the wheel), pans and
        resets the axes. Pick another plot from the cards.
      </p>
    </section>
  );
}
