import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EChart, type EChartsOption } from "@/components/echart";
import { ErrorMessage } from "@/components/error-message";
import { Choices, PlotCard, PlotFilter, PlotLayout } from "@/components/plot-grid";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
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

const LARGE_HEIGHT = 520;
/** The selected plot's header, note and hint around its chart. */
const LARGE_CHROME = 90;

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

/**
 * A plot type's tab: the selected plot drawn large and interactive (the
 * first, or `selected`), and every plot of the level as a small card to pick
 * from, below it or beside it, whichever leaves them more room (PlotLayout).
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
  const scroller = useRef<HTMLDivElement>(null);
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
      <PlotFilter
        value={filter}
        onChange={(next) => {
          setFilter(next);
          toTop();
        }}
        label="Filter plots by specimen, sample, site or location"
        shown={shown.length}
        total={leveled.length}
      />
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

  return (
    // The controls stay put; the plots scroll below them.
    <PlotLayout
      header={
        <>
          {controls}
          <p className="text-[12px] text-gray-500">{LEGENDS[type]}</p>
        </>
      }
      large={large}
      count={shown.length}
      index={index}
      scrollRef={scroller}
      largeHeight={LARGE_HEIGHT + LARGE_CHROME}
      renderCard={(i, size) => {
        const item = shown[i];
        return (
          <ItemCard
            key={item.key}
            item={item}
            size={size.width}
            coord={coordOf(item)}
            selected={item.key === current?.key}
            onSelect={() => choose(item)}
          />
        );
      }}
    />
  );
}

/** A plot to pick: the whole card selects it. */
function ItemCard({
  item,
  size,
  coord,
  selected,
  onSelect,
}: {
  item: PlotItem;
  /** The side of its square chart. */
  size: number;
  coord: Coord;
  selected: boolean;
  onSelect: () => void;
}) {
  const build = useCallback((size: Size) => item.build(size, coord, false), [item, coord]);
  return (
    <PlotCard
      title={item.title}
      tooltip={[item.title, item.where].filter(Boolean).join(" · ")}
      selected={selected}
      onSelect={onSelect}
    >
      <EChart build={build} height={size} label={`${item.title} plot`} />
    </PlotCard>
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
