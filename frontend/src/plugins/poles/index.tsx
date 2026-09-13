import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ErrorMessage } from "../../components/error-message";
import { Cell, DefinitionTable, NoDataCell, ResultCardFrame } from "../../components/result-item";
import { Icon } from "../../components/ui/icon";
import { PageSpinner } from "../../components/ui/spinner";
import { api } from "../../lib/api";
import type {
  NodeConfig,
  SearchLevel,
  SearchPage as SearchPageData,
  SearchResult,
} from "../../lib/types";
import { cx } from "../../lib/utils";
import type { PluginFiltersProps, PluginModule, PluginSubTabContext } from "../index";
import {
  formatAge,
  formatLat,
  formatLon,
  makeAgeScale,
  type Pole,
  poleBlockOf,
  polesFromHits,
} from "./poles-data";

// echarts + echarts-gl live in a lazily loaded chunk so other nodes never pay for them.
const PolesGlobes = lazy(() => import("./globes"));

const POLES_LEVEL: SearchLevel = { name: "Poles", table: "poles", count_field: null };
const DEFAULT_MAX_POLES = 100;

interface PolesPluginConfig {
  base_level?: string;
  after_sub_tab?: string;
  table?: string;
  has_base_texture?: boolean;
  has_plate_boundaries?: boolean;
  plate_boundary_color?: string;
  filters?: unknown[];
}

function polesConfig(config: NodeConfig): PolesPluginConfig {
  return (config.plugins.poles ?? {}) as PolesPluginConfig;
}

// --- Result item (used for the Summaries list and the detail card) ----------------

function firstNumber(value: unknown): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : undefined;
}

function PolesResultItem({ hit, level }: { hit: SearchResult; level: SearchLevel }) {
  const block = poleBlockOf(hit);
  const lat = firstNumber(block?.pole_lat);
  const lon = firstNumber(block?.pole_lon);
  const alpha95 = firstNumber(block?.pole_alpha95);
  const age = firstNumber(block?.age ?? block?.pole_age);
  const ageUnit =
    typeof block?.age_unit === "string"
      ? block.age_unit
      : Array.isArray(block?.age_unit)
        ? String(block?.age_unit[0])
        : undefined;

  const cells = (
    <>
      {lat !== undefined ? (
        <Cell width={125} wrap>
          <b>Pole Latitude:</b>
          <br />
          {formatLat(lat)}
        </Cell>
      ) : (
        <NoDataCell label="Pole Latitude" width={125} />
      )}
      {lon !== undefined ? (
        <Cell width={125} wrap>
          <b>Pole Longitude:</b>
          <br />
          {formatLon(lon)}
        </Cell>
      ) : (
        <NoDataCell label="Pole Longitude" width={125} />
      )}
      {alpha95 !== undefined ? (
        <Cell width={100} wrap>
          <b>Alpha95:</b>
          <br />
          {alpha95}°
        </Cell>
      ) : (
        <NoDataCell label="Alpha95" width={100} />
      )}
      {age !== undefined ? (
        <Cell width={120} wrap>
          <b>Age:</b>
          <br />
          {age}
          {ageUnit ? ` ${ageUnit}` : ""}
        </Cell>
      ) : (
        <NoDataCell label="Age" width={120} />
      )}
    </>
  );

  const expanded = block ? <DefinitionTable data={block} /> : undefined;

  return <ResultCardFrame doc={hit} level={level} cells={cells} expanded={expanded} />;
}

// --- Side panel (max poles, ellipse toggle, color legend) -------------------------

function ColorLegend({
  minAge,
  maxAge,
  hasAges,
}: {
  minAge: number;
  maxAge: number;
  hasAges: boolean;
}) {
  const labels = hasAges
    ? [1, 0.75, 0.5, 0.25, 0].map((f) => formatAge(minAge + f * (maxAge - minAge)))
    : ["", "", "", "", ""];
  return (
    <div>
      <div className="flex gap-2">
        <div
          className="shrink-0"
          style={{
            width: 14,
            height: 150,
            background: "linear-gradient(to bottom, #ff0000, #ffff00)",
            border: "1px solid #D4D4D5",
          }}
          aria-hidden="true"
        />
        <div
          className="flex flex-col justify-between text-[11px] text-gray-600"
          style={{ height: 150 }}
        >
          {labels.map((label, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5-tick legend
            <span key={i}>{label || "—"}</span>
          ))}
        </div>
      </div>
      <div className="mt-2 space-y-1 text-[11px] text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: "#000" }} />
          Unknown Age
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: "#800080" }} />
          Selected Pole
        </span>
      </div>
    </div>
  );
}

function SidePanel({
  maxPoles,
  setMaxPoles,
  showEllipses,
  setShowEllipses,
  minAge,
  maxAge,
  hasAges,
}: {
  maxPoles: number;
  setMaxPoles: (n: number) => void;
  showEllipses: boolean;
  setShowEllipses: (show: boolean) => void;
  minAge: number;
  maxAge: number;
  hasAges: boolean;
}) {
  const section = "border-b border-[#D4D4D5]";
  const heading = "mb-1 text-[13px] font-bold text-[rgba(0,0,0,0.87)]";
  return (
    <aside className="w-[180px] shrink-0 overflow-y-auto border-l border-[#D4D4D5] bg-white">
      <div className={section} style={{ padding: "0.25em 1em 0.5em" }}>
        <h5 className={heading}>Displayed Poles</h5>
        <label className="sr-only" htmlFor="poles-max">
          Maximum displayed poles
        </label>
        <input
          id="poles-max"
          type="number"
          min={1}
          value={maxPoles}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (Number.isFinite(n) && n >= 1) setMaxPoles(Math.floor(n));
          }}
          className="w-full rounded-sm border border-gray-300 px-2 py-1 text-[12px] focus:border-node focus:outline-hidden"
        />
      </div>
      <div className={section} style={{ padding: "0.25em 1em 0.5em" }}>
        <h5 className={heading}>Uncertainty Ellipses</h5>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setShowEllipses(true)}
            className={cx(
              "flex-1 rounded-sm px-2 py-1 text-[12px] font-medium",
              showEllipses ? "bg-node text-white" : "border border-gray-300 bg-white text-gray-600",
            )}
          >
            Show
          </button>
          <button
            type="button"
            onClick={() => setShowEllipses(false)}
            className={cx(
              "flex-1 rounded-sm px-2 py-1 text-[12px] font-medium",
              !showEllipses
                ? "bg-node text-white"
                : "border border-gray-300 bg-white text-gray-600",
            )}
          >
            Hide
          </button>
        </div>
      </div>
      <div style={{ padding: "0.25em 1em 0.5em" }}>
        <h5 className={heading}>Color Legend</h5>
        <ColorLegend minAge={minAge} maxAge={maxAge} hasAges={hasAges} />
      </div>
    </aside>
  );
}

// --- Poles map sub-tab: detail bar + dual globes + side panel ----------------------

function PolesMapView({ query, ranges, bbox, config }: PluginSubTabContext) {
  const [selected, setSelected] = useState<number | null>(null);
  const [maxPoles, setMaxPoles] = useState(DEFAULT_MAX_POLES);
  const [showEllipses, setShowEllipses] = useState(true);

  const pconfig = polesConfig(config);

  const polesQuery = useQuery({
    queryKey: ["plugin", "poles", "search", query, ranges, bbox, maxPoles],
    queryFn: () =>
      api<SearchPageData>("/search/poles", {
        params: {
          query: query || undefined,
          size: maxPoles,
          range: ranges.length > 0 ? ranges : undefined,
          bbox: bbox || undefined,
        },
      }),
    staleTime: 60_000,
  });

  const boundaries = useQuery({
    queryKey: ["plugin", "poles", "plate-boundaries"],
    queryFn: () => api<unknown>("/plugins/poles/plate-boundaries"),
    enabled: pconfig.has_plate_boundaries === true,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const poles = useMemo<Pole[]>(
    () => polesFromHits(polesQuery.data?.results ?? []),
    [polesQuery.data],
  );
  const ageScale = useMemo(() => makeAgeScale(poles), [poles]);

  // Reset selection when the pole set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the list identity changes
  useEffect(() => {
    setSelected(null);
  }, [poles]);

  const selectedPole = selected !== null ? poles[selected] : undefined;
  const canPrev = (selected ?? 0) > 0;
  const canNext = poles.length > 0 && (selected ?? -1) < poles.length - 1;

  const chevronButton = (dir: "left" | "right", disabled: boolean, onClick: () => void) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={dir === "left" ? "Previous pole" : "Next pole"}
      className={cx(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border",
        disabled
          ? "cursor-not-allowed border-gray-200 text-gray-300"
          : "border-gray-300 text-gray-600 hover:bg-gray-50",
      )}
    >
      <Icon name={dir === "left" ? "chevron-left" : "chevron-right"} size="large" />
    </button>
  );

  if (polesQuery.isPending) return <PageSpinner label="Loading poles…" />;
  if (polesQuery.error) return <ErrorMessage error={polesQuery.error} className="my-3" />;

  if (poles.length === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-gray-500">
        No poles with coordinates for this query.
      </p>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: 680 }}>
      {/* Row 1 — detail card bar */}
      <div
        className="flex items-center gap-[10px] border-b border-[#D4D4D5] bg-white"
        style={{ height: 194.5, padding: 10 }}
      >
        {chevronButton("left", !canPrev, () => setSelected(Math.max(0, (selected ?? 0) - 1)))}
        <div className="h-full min-w-0 flex-1 overflow-y-auto">
          {selectedPole ? (
            <PolesResultItem hit={selectedPole.hit} level={POLES_LEVEL} />
          ) : (
            <p className="text-[13px] text-gray-500">
              Select a pole on a globe, or use the arrows to browse {poles.length} poles.
            </p>
          )}
        </div>
        {chevronButton("right", !canNext, () =>
          setSelected(Math.min(poles.length - 1, (selected ?? -1) + 1)),
        )}
      </div>

      {/* Row 2 — globes + side panel */}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {boundaries.error && <ErrorMessage error={boundaries.error} className="m-2" />}
          <Suspense fallback={<PageSpinner label="Loading globes…" />}>
            <PolesGlobes
              poles={poles}
              ageScale={ageScale}
              boundaries={boundaries.data ?? null}
              plateColor={pconfig.plate_boundary_color ?? "#990000"}
              hasBaseTexture={pconfig.has_base_texture === true}
              showEllipses={showEllipses}
              selected={selected}
              onSelect={setSelected}
            />
          </Suspense>
        </div>
        <SidePanel
          maxPoles={maxPoles}
          setMaxPoles={setMaxPoles}
          showEllipses={showEllipses}
          setShowEllipses={setShowEllipses}
          minAge={ageScale.minAge}
          maxAge={ageScale.maxAge}
          hasAges={ageScale.hasAges}
        />
      </div>
    </div>
  );
}

// --- Structured plugin filters (range + bbox) ---------------------------------------

interface StructuredFilter {
  name: string;
  type: "range" | "bbox";
  field?: string;
  unit?: string;
  /** Multiply the displayed (unit) value by this to get the stored field value
   * (e.g. Age is entered in Ma but stored in years, scale = 1e6). */
  scale?: number;
}

function structuredFilters(config: NodeConfig): StructuredFilter[] {
  const filters = polesConfig(config).filters;
  if (!Array.isArray(filters)) return [];
  return filters
    .filter((entry) => entry && typeof entry === "object" && "type" in entry)
    .map((entry) => entry as unknown as StructuredFilter)
    .filter((entry) => entry.type === "range" || entry.type === "bbox");
}

/** Split "field:gte:lte" from the right (field may contain dots, never colons). */
function parseRange(entry: string): { field: string; gte: string; lte: string } {
  const parts = entry.split(":");
  const lte = parts.pop() ?? "";
  const gte = parts.pop() ?? "";
  return { field: parts.join(":"), gte, lte };
}

const rangeInputClass =
  "w-20 min-w-0 rounded-sm border border-gray-300 px-1.5 py-1 text-[12px] " +
  "placeholder:text-[#AAAAAA] focus:border-node focus:outline-hidden";

function RangeFilter({
  filter,
  ranges,
  setRanges,
}: {
  filter: StructuredFilter;
  ranges: string[];
  setRanges: (ranges: string[]) => void;
}) {
  const field = filter.field ?? "";
  const scale = filter.scale ?? 1;
  const stored = ranges.map(parseRange).find((entry) => entry.field === field);
  // Convert stored (field units) <-> displayed (filter units).
  const toDisplay = (v: string) => (v === "" || scale === 1 ? v : String(Number(v) / scale));
  const toStore = (v: string) => (v === "" || scale === 1 ? v : String(Number(v) * scale));
  const current = { gte: toDisplay(stored?.gte ?? ""), lte: toDisplay(stored?.lte ?? "") };

  const update = (gte: string, lte: string) => {
    const others = ranges.filter((entry) => parseRange(entry).field !== field);
    if (gte === "" && lte === "") setRanges(others);
    else setRanges([...others, `${field}:${toStore(gte)}:${toStore(lte)}`]);
  };

  return (
    <div style={{ padding: "0.25em 1em 0.5em", borderBottom: "1px solid #D4D4D5" }}>
      <div className="mb-1 text-[13px] font-bold">{filter.name}</div>
      <div className="flex items-center gap-1">
        <label className="sr-only" htmlFor={`range-${field}-gte`}>
          {filter.name} minimum
        </label>
        <input
          id={`range-${field}-gte`}
          type="number"
          placeholder="min"
          value={current?.gte ?? ""}
          onChange={(event) => update(event.target.value, current?.lte ?? "")}
          className={rangeInputClass}
        />
        <span className="text-[12px] text-gray-500">to</span>
        <label className="sr-only" htmlFor={`range-${field}-lte`}>
          {filter.name} maximum
        </label>
        <input
          id={`range-${field}-lte`}
          type="number"
          placeholder="max"
          value={current?.lte ?? ""}
          onChange={(event) => update(current?.gte ?? "", event.target.value)}
          className={rangeInputClass}
        />
        {filter.unit && <span className="text-[12px] text-gray-500">{filter.unit}</span>}
      </div>
    </div>
  );
}

function BboxFilter({
  filter,
  bbox,
  setBbox,
}: {
  filter: StructuredFilter;
  bbox?: string;
  setBbox: (bbox: string | undefined) => void;
}) {
  // bbox = "minLon,minLat,maxLon,maxLat"
  const parts = (bbox ?? ",,,").split(",");
  const [minLon, minLat, maxLon, maxLat] = [
    parts[0] ?? "",
    parts[1] ?? "",
    parts[2] ?? "",
    parts[3] ?? "",
  ];

  const update = (next: [string, string, string, string]) => {
    if (next.every((value) => value === "")) setBbox(undefined);
    else setBbox(next.join(","));
  };

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
  ) => (
    <label className="flex items-center gap-1 text-[12px] text-gray-600">
      <span className="w-14">{label}</span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={rangeInputClass}
      />
    </label>
  );

  return (
    <div style={{ padding: "0.25em 1em 0.5em", borderBottom: "1px solid #D4D4D5" }}>
      <div className="mb-1 text-[13px] font-bold">{filter.name}</div>
      <div className="grid gap-1">
        {field("Min Lat", minLat, (v) => update([minLon, v, maxLon, maxLat]), "-90")}
        {field("Max Lat", maxLat, (v) => update([minLon, minLat, maxLon, v]), "90")}
        {field("Min Lon", minLon, (v) => update([v, minLat, maxLon, maxLat]), "-180")}
        {field("Max Lon", maxLon, (v) => update([minLon, minLat, v, maxLat]), "180")}
      </div>
    </div>
  );
}

function PolesFiltersPanel(props: PluginFiltersProps) {
  const filters = structuredFilters(props.config);
  if (filters.length === 0) return null;
  return (
    <div>
      {filters.map((filter) =>
        filter.type === "range" ? (
          <RangeFilter
            key={filter.name}
            filter={filter}
            ranges={props.ranges}
            setRanges={props.setRanges}
          />
        ) : (
          <BboxFilter key={filter.name} filter={filter} bbox={props.bbox} setBbox={props.setBbox} />
        ),
      )}
    </div>
  );
}

// --- Plugin module -------------------------------------------------------------------

export const polesPlugin: PluginModule = {
  // Legacy home page: a full-width "Poles / View" tiny card under the primary cards.
  homeCards(config) {
    const pconfig = polesConfig(config);
    if (!pconfig.base_level) return [];
    return [
      {
        key: "poles",
        title: "Poles\nView",
        to: "/search",
        search: { level: pconfig.base_level },
      },
    ];
  },
  // Poles is a sub-tab of its base level (Locations), added after `after_sub_tab`.
  levelSubTabs(level, config) {
    const pconfig = polesConfig(config);
    if (!pconfig.base_level || pconfig.base_level !== level.name) return [];
    return [{ name: "Poles", render: (ctx) => <PolesMapView {...ctx} /> }];
  },
  filtersPanel(props) {
    const pconfig = polesConfig(props.config);
    if (pconfig.base_level !== props.levelName || props.subTabName !== "Poles") return null;
    return <PolesFiltersPanel {...props} />;
  },
};
