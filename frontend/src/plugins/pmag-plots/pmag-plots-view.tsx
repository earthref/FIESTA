import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { EChart, type EChartsOption } from "../../components/echart";
import { ErrorMessage } from "../../components/error-message";
import { PageSpinner } from "../../components/ui/spinner";
import { api } from "../../lib/api";
import { cx } from "../../lib/utils";
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

const PAGE = 12;
const CARD_HEIGHT = 260;
const LARGE_HEIGHT = 520;

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
}: {
  type: PlotType;
  id: string;
  privateKey?: string;
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
  return <PlotGrid type={type} items={items} />;
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
            directionSetOption(size, group.sets[coord] as DirectionSet),
          note: (coord: Coord) => setNote(group.sets[coord] as DirectionSet),
        })),
        ...demagSpecimens.map((s) => ({
          ...specimenItem(s),
          level: "Measurements",
          coords: coordsOf(s),
          build: (size: Size, coord: Coord) => stepsNetOption(size, s, coord),
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
  return COORDS.filter(
    (coord) => coord === "s" || (coord === "g" ? specimen.geo : specimen.tilt) !== undefined,
  );
}

function stepUnit(specimen: DemagSpecimen): string {
  const af = specimen.steps.kind.filter((k) => k === "AF").length;
  return af * 2 >= specimen.steps.kind.filter((k) => k !== "NRM").length ? "mT" : "°C";
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
    parts.push(
      `b ${nf(fit.b)} over ${nf(fit.min ?? 0)}–${nf(fit.max ?? 0)} °C (n ${fit.n})`,
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

function PlotGrid({ type, items }: { type: PlotType; items: PlotItem[] }) {
  const [filter, setFilter] = useState("");
  const [visible, setVisible] = useState(PAGE);
  const [expanded, setExpanded] = useState<string | null>(null);
  const levelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items)
      if (item.level) counts.set(item.level, (counts.get(item.level) ?? 0) + 1);
    return counts;
  }, [items]);
  const [level, setLevel] = useState(() => LEVELS.find((l) => levelCounts.has(l)));
  const leveled = level ? items.filter((item) => item.level === level) : items;
  const coords = COORDS.filter((coord) => leveled.some((item) => item.coords?.includes(coord)));
  const [coord, setCoord] = useState<Coord>(() => coords[0] ?? "g");
  const needle = filter.trim().toLowerCase();
  const shown = needle ? leveled.filter((item) => item.names.includes(needle)) : leveled;
  const current = expanded ? shown.findIndex((item) => item.key === expanded) : -1;

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
            setVisible(PAGE);
            setExpanded(null);
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
          setVisible(PAGE);
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

  return (
    <div className="space-y-3 p-3">
      {controls}
      <p className="text-[12px] text-gray-500">{LEGENDS[type]}</p>
      {current >= 0 ? (
        <ExpandedPlot
          item={shown[current]}
          coord={coordOf(shown[current])}
          preferred={coord}
          position={`${current + 1} of ${shown.length}`}
          onBack={() => setExpanded(null)}
          onStep={(delta) =>
            setExpanded(shown[(current + delta + shown.length) % shown.length].key)
          }
        />
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-gray-500">No plots match the filter.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.slice(0, visible).map((item) => (
              <PlotCard
                key={item.key}
                item={item}
                coord={coordOf(item)}
                preferred={coord}
                onExpand={() => setExpanded(item.key)}
              />
            ))}
          </div>
          {shown.length > visible && (
            <div className="text-center">
              <button
                type="button"
                onClick={() => setVisible((n) => n + PAGE)}
                className="rounded-sm border border-gray-300 bg-white px-3 py-1 text-[13px] font-bold text-gray-700 hover:bg-gray-50"
              >
                Show {Math.min(PAGE, shown.length - visible)} more of {shown.length - visible}
              </button>
            </div>
          )}
        </>
      )}
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
                : "bg-white text-gray-700 hover:bg-gray-50",
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

function PlotCard({
  item,
  coord,
  preferred,
  onExpand,
}: {
  item: PlotItem;
  coord: Coord;
  preferred: Coord;
  onExpand: () => void;
}) {
  const build = useCallback((size: Size) => item.build(size, coord, false), [item, coord]);
  return (
    <section className="min-w-0 rounded-sm border border-gray-300 bg-white">
      <header className="flex items-baseline gap-2 border-b border-gray-200 px-3 py-1.5">
        <button
          type="button"
          onClick={onExpand}
          className="truncate text-left text-[13px] font-bold text-node hover:underline"
          title="Enlarge"
        >
          {item.title}
        </button>
        <span className="truncate text-[12px] text-gray-500">{item.where}</span>
      </header>
      <EChart build={build} height={CARD_HEIGHT} label={`${item.title} plot`} />
      <PlotNote item={item} coord={coord} preferred={preferred} />
    </section>
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

function ExpandedPlot({
  item,
  coord,
  preferred,
  position,
  onBack,
  onStep,
}: {
  item: PlotItem;
  coord: Coord;
  preferred: Coord;
  position: string;
  onBack: () => void;
  onStep: (delta: number) => void;
}) {
  const build = useCallback((size: Size) => item.build(size, coord, true), [item, coord]);
  const button =
    "rounded-sm border border-gray-300 bg-white px-2 py-0.5 text-[13px] text-gray-700 hover:bg-gray-50";
  return (
    <section className="rounded-sm border border-gray-300 bg-white">
      <header className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2">
        <button type="button" onClick={onBack} className={button}>
          ← All plots
        </button>
        <h4 className="text-[14px] font-bold text-gray-900">{item.title}</h4>
        <span className="text-[12px] text-gray-500">{item.where}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-gray-500">
          <button
            type="button"
            onClick={() => onStep(-1)}
            className={button}
            aria-label="Previous plot"
          >
            ‹
          </button>
          {position}
          <button type="button" onClick={() => onStep(1)} className={button} aria-label="Next plot">
            ›
          </button>
        </span>
      </header>
      <EChart build={build} height={LARGE_HEIGHT} label={`${item.title} plot`} />
      <PlotNote item={item} coord={coord} preferred={preferred} />
      <p className="px-3 pb-2 text-[11px] text-gray-400">
        Hover a point for its values; scroll or pinch to zoom where the plot allows.
      </p>
    </section>
  );
}
