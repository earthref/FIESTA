import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ErrorMessage } from "@/components/error-message";
import { MapThumbnail } from "@/components/map-thumbnail";
import { Cell, NoDataCell } from "@/components/result-item";
import { SummaryGrid } from "@/components/summary-grid";
import { Icon } from "@/components/ui/icon";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import type {
  GridColumn,
  NodeConfig,
  SearchLevel,
  SearchPage as SearchPageData,
  SearchResult,
} from "@/lib/types";
import { cx, getPath } from "@/lib/utils";
import type { PluginModule, PluginSubTabContext } from "@/plugins";
import {
  type AgeColors,
  DEFAULT_AGE_COLORS,
  formatAge,
  formatLat,
  formatLon,
  makeAgeScale,
  normalizeLon,
  type Pole,
  poleBlockOf,
  polesFromHits,
} from "./poles-data";
import PolesMap from "./poles-map";

const POLES_LEVEL: SearchLevel = { name: "Poles", table: "poles", count_field: null };
const DEFAULT_MAX_POLES = 100;

interface PolesPluginConfig {
  base_level?: string;
  after_sub_tab?: string;
  table?: string;
  has_plate_boundaries?: boolean;
  plate_boundary_color?: string;
  age_color?: Partial<AgeColors>;
}

function polesConfig(config: NodeConfig): PolesPluginConfig {
  return (config.plugins.poles ?? {}) as PolesPluginConfig;
}

// --- Detail card: the selected pole as a Summaries grid row ----------------------

function firstNumber(value: unknown): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === "" || candidate === null || candidate === undefined) return undefined;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : undefined;
}

function textOf(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value.join(", ") : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

/** The pole's location row (the doc's `summary.locations`, as uploaded). */
function locationRowOf(hit: SearchResult): Record<string, unknown> {
  const row = getPath(hit, "summary.locations");
  return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
}

/** The location's position: its lat/lon, else the middle of its lat/lon box
 * (where the backend places the dp/dm ellipse; a box across 0°/360° handled). */
function siteOf(row: Record<string, unknown>): { lat: number; lon: number } | undefined {
  const lat = firstNumber(row.lat);
  const lon = firstNumber(row.lon);
  if (lat !== undefined && lon !== undefined) {
    return Math.abs(lat) <= 90 ? { lat, lon: normalizeLon(lon) } : undefined;
  }
  const [s, n, w, e] = ["lat_s", "lat_n", "lon_w", "lon_e"].map((k) => firstNumber(row[k]));
  if (s === undefined || n === undefined || w === undefined || e === undefined) return undefined;
  const middle = (s + n) / 2;
  const span = (((e - w) % 360) + 360) % 360;
  return Math.abs(middle) <= 90 ? { lat: middle, lon: normalizeLon(w + span / 2) } : undefined;
}

// Location columns the core tiles (geo, geology, method codes, citations) read
// from `summary._all`. A pole doc's `_all` holds only the facet columns, so the
// card fills in the rest from its location row.
const ALL_COLUMNS = [
  "plate_blocks",
  "terranes",
  "geological_province_sections",
  "tectonic_settings",
  "continent_ocean",
  "country",
  "state_province",
  "ocean_sea",
  "region",
  "village_city",
  "location",
  "location_type",
  "location_alternatives",
  "geologic_classes",
  "lithologies",
  "method_codes",
  "citations",
];

/** The hit as the card's grid reads it: `_all` completed from the location row,
 * and its `_geo_point` the location (for the core map tile), not the pole. */
function cardDocOf(hit: SearchResult): SearchResult {
  const row = locationRowOf(hit);
  const all: Record<string, unknown> = {};
  for (const column of ALL_COLUMNS) {
    const value = row[column];
    if (typeof value === "string" && value.trim()) {
      all[column] = value
        .split(":")
        .map((v) => v.trim())
        .filter(Boolean);
    }
  }
  const { _geo_point: _pole, ...indexed } = (getPath(hit, "summary._all") ?? {}) as Record<
    string,
    unknown
  >;
  const site = siteOf(row);
  const summary = (hit.summary ?? {}) as Record<string, unknown>;
  return {
    ...hit,
    summary: { ...summary, _all: { ...all, ...indexed, ...(site && { _geo_point: site }) } },
  } as SearchResult;
}

const tile = (key: string, cell: GridColumn["cell"], label: string, width: number): GridColumn => ({
  key,
  cell,
  label,
  width,
  sortable: false,
  filterable: false,
  facets: [],
  geospatial: false,
});

// The card's tiles: the core Summaries tiles plus the plugin's own (rendered by
// `gridCell`, matched on their keys), in the legacy result card's order.
const CARD_TILES = new Set(["pole_map", "pole", "pole_age", "direction"]);
const CARD_LEVEL: SearchLevel = {
  ...POLES_LEVEL,
  columns: [
    tile("record", "record", "Location", 260),
    tile("map", "map", "Map", 100),
    tile("pole_map", "map", "Pole Map", 100),
    tile("pole", "field", "Pole", 140),
    tile("pole_age", "age", "Age", 125),
    tile("direction", "field", "Direction", 125),
    tile("geo", "geo", "Geography", 125),
    tile("geology", "geology", "Geology", 125),
    tile("method_codes", "method_codes", "Method Codes", 125),
    tile("citations", "citations", "Citations", 125),
  ],
};

/** A row value as typed, trimmed of float noise ("6.561361711545552" -> "6.6"). */
const rounded = (value: number, digits = 1) => String(Number(value.toFixed(digits)));
const degrees = (value: number) => `${rounded(value)}°`;

/** "Label: value" lines, one per defined value. */
function Lines({ lines }: { lines: [string, string | undefined][] }) {
  return (
    <>
      {lines
        .filter((line): line is [string, string] => line[1] !== undefined)
        .map(([label, value]) => (
          <span key={label} className="block overflow-hidden text-ellipsis whitespace-nowrap">
            <b>{label}:</b> {value}
          </span>
        ))}
    </>
  );
}

/** The pole on a globe centred on it, magnified to its uncertainty outline
 * (none on a doc indexed before the rings: `fiesta rebuild`). */
function PoleMapTile({ hit, color, width }: { hit: SearchResult; color: string; width: number }) {
  const [pole] = useMemo(() => polesFromHits([hit]), [hit]);
  const markers = useMemo(
    () => (pole ? [{ lat: pole.lat, lon: pole.lon, color }] : []),
    [pole, color],
  );
  const rings = useMemo(() => (pole?.ring ? [{ points: pole.ring, color }] : []), [pole, color]);
  if (!pole) return <NoDataCell label="Pole" width={width} />;
  return (
    <Cell width={width} style={{ height: 104 }}>
      <MapThumbnail
        markers={markers}
        rings={rings}
        zoomToRings
        label="Map of the pole and its uncertainty outline"
      />
    </Cell>
  );
}

function PoleTile({ hit, width }: { hit: SearchResult; width: number }) {
  const row = locationRowOf(hit);
  const block = poleBlockOf(hit);
  const lat = firstNumber(block?.pole_lat ?? row.pole_lat);
  const lon = firstNumber(block?.pole_lon ?? row.pole_lon);
  if (lat === undefined || lon === undefined) return <NoDataCell label="Pole" width={width} />;
  const alpha95 = firstNumber(row.pole_alpha95);
  const dp = firstNumber(row.pole_dp);
  const dm = firstNumber(row.pole_dm);
  const k = firstNumber(row.pole_k);
  const n = firstNumber(row.pole_n_sites);
  const paleolat = firstNumber(row.paleolat);
  return (
    <Cell width={width}>
      <b>Pole:</b>
      <span className="block">
        {formatLat(lat)}, {formatLon(lon)}
      </span>
      <Lines
        lines={[
          ["A95", alpha95 !== undefined ? degrees(alpha95) : undefined],
          [
            "dp / dm",
            alpha95 === undefined && dp !== undefined && dm !== undefined
              ? `${degrees(dp)} / ${degrees(dm)}`
              : undefined,
          ],
          ["K", k !== undefined ? rounded(k) : undefined],
          ["N Sites", n !== undefined ? String(n) : undefined],
          ["Paleolat", paleolat !== undefined ? degrees(paleolat) : undefined],
        ]}
      />
    </Cell>
  );
}

function AgeTile({ hit, width }: { hit: SearchResult; width: number }) {
  const row = locationRowOf(hit);
  const unit = textOf(row.age_unit);
  const withUnit = (text: string) => (unit ? `${text} ${unit}` : text);
  const age = firstNumber(row.age);
  const sigma = firstNumber(row.age_sigma);
  const low = firstNumber(row.age_low);
  const high = firstNumber(row.age_high);
  const hasRange = low !== undefined && high !== undefined;
  if (age === undefined && !hasRange) return <NoDataCell label="Age" width={width} />;
  return (
    <Cell width={width} wrap>
      {age !== undefined && (
        <>
          <b>Age:</b>
          <br />
          {withUnit(
            sigma !== undefined ? `${rounded(age, 3)} ± ${rounded(sigma, 3)}` : rounded(age, 3),
          )}
          <br />
        </>
      )}
      {hasRange && (
        <>
          <b>Age Range:</b>
          <br />
          {withUnit(`${rounded(low, 3)} to ${rounded(high, 3)}`)}
        </>
      )}
    </Cell>
  );
}

function DirectionTile({ hit, width }: { hit: SearchResult; width: number }) {
  const row = locationRowOf(hit);
  const dec = firstNumber(row.dir_dec);
  const inc = firstNumber(row.dir_inc);
  if (dec === undefined || inc === undefined) return <NoDataCell label="Direction" width={width} />;
  const alpha95 = firstNumber(row.dir_alpha95);
  const k = firstNumber(row.dir_k);
  const n = firstNumber(row.dir_n_sites);
  const tilt = firstNumber(row.dir_tilt_correction);
  return (
    <Cell width={width}>
      <b>Dec / Inc:</b>
      <span className="block">
        {degrees(dec)} / {degrees(inc)}
      </span>
      <Lines
        lines={[
          ["α95", alpha95 !== undefined ? degrees(alpha95) : undefined],
          ["K", k !== undefined ? rounded(k) : undefined],
          ["N Sites", n !== undefined ? String(n) : undefined],
          ["Polarity", textOf(row.dir_polarity)],
          ["Tilt Corr.", tilt !== undefined ? `${rounded(tilt)}%` : undefined],
        ]}
      />
    </Cell>
  );
}

/** The selected pole as one Summaries grid row: the core record, location map,
 * geography, geology, method codes and citations tiles, and the plugin's pole
 * map, pole, age and direction tiles. */
function PoleCard({ hit, privateKey }: { hit: SearchResult; privateKey?: string }) {
  const doc = useMemo(() => cardDocOf(hit), [hit]);
  return <SummaryGrid level={CARD_LEVEL} hits={[doc]} header={false} privateKey={privateKey} />;
}

// --- Side panel (max poles, ellipse toggle, color legend) -------------------------

function ColorLegend({
  minAge,
  maxAge,
  hasAges,
  colors,
}: {
  minAge: number;
  maxAge: number;
  hasAges: boolean;
  colors: AgeColors;
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
            background: `linear-gradient(to bottom, ${colors.old}, ${colors.young})`,
            border: "1px solid var(--er-edge)",
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
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ background: colors.unknown }}
          />
          Unknown Age
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ background: colors.selected }}
          />
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
  colors,
}: {
  maxPoles: number;
  setMaxPoles: (n: number) => void;
  showEllipses: boolean;
  setShowEllipses: (show: boolean) => void;
  minAge: number;
  maxAge: number;
  hasAges: boolean;
  colors: AgeColors;
}) {
  const section = "border-b border-edge";
  const heading = "mb-1 text-[13px] font-bold text-ink";
  return (
    <aside className="w-[180px] shrink-0 overflow-y-auto border-l border-edge bg-surface">
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
              showEllipses
                ? "bg-node text-white"
                : "border border-gray-300 bg-surface text-gray-600",
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
                : "border border-gray-300 bg-surface text-gray-600",
            )}
          >
            Hide
          </button>
        </div>
      </div>
      <div style={{ padding: "0.25em 1em 0.5em" }}>
        <h5 className={heading}>Color Legend</h5>
        <ColorLegend minAge={minAge} maxAge={maxAge} hasAges={hasAges} colors={colors} />
      </div>
    </aside>
  );
}

// --- Poles map sub-tab: detail bar + map + side panel -------------------------------

function PolesMapView({
  query,
  ranges,
  bbox,
  config,
  contribution,
  privateKey,
}: PluginSubTabContext) {
  const [selected, setSelected] = useState<number | null>(null);
  const [maxPoles, setMaxPoles] = useState(DEFAULT_MAX_POLES);
  const [showEllipses, setShowEllipses] = useState(true);

  const pconfig = polesConfig(config);
  const colors: AgeColors = { ...DEFAULT_AGE_COLORS, ...pconfig.age_color };

  const polesQuery = useQuery({
    queryKey: ["plugin", "poles", "search", query, ranges, bbox, maxPoles, contribution],
    queryFn: () =>
      api<SearchPageData>("/search/poles", {
        params: {
          query: query || undefined,
          size: maxPoles,
          range: ranges.length > 0 ? ranges : undefined,
          bbox: bbox || undefined,
          contribution,
          private_key: contribution ? privateKey : undefined,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the colors by value
  const ageScale = useMemo(() => makeAgeScale(poles, colors), [poles, JSON.stringify(colors)]);

  // Reset selection when the pole set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the list identity changes
  useEffect(() => {
    setSelected(null);
  }, [poles]);

  // The first pole until another is chosen, so the detail card always shows one.
  const current = selected !== null && selected < poles.length ? selected : 0;
  const selectedPole = poles[current];
  const canPrev = current > 0;
  const canNext = current < poles.length - 1;

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
      {/* Row 1 — the selected pole's card, as a Summaries row */}
      <div
        className="flex shrink-0 items-center gap-[10px] border-b border-edge bg-surface"
        style={{ padding: "4px 10px" }}
      >
        {chevronButton("left", !canPrev, () => setSelected(current - 1))}
        <div className="min-w-0 flex-1 overflow-x-auto">
          {selectedPole && <PoleCard hit={selectedPole.hit} privateKey={privateKey} />}
        </div>
        {chevronButton("right", !canNext, () => setSelected(current + 1))}
      </div>

      {/* Row 2 — map + side panel */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {boundaries.error && <ErrorMessage error={boundaries.error} className="m-2" />}
          <div className="min-h-0 flex-1">
            <PolesMap
              poles={poles}
              ageScale={ageScale}
              boundaries={boundaries.data ?? null}
              plateColor={pconfig.plate_boundary_color ?? "#990000"}
              selectedColor={colors.selected}
              showEllipses={showEllipses}
              selected={current}
              onSelect={setSelected}
            />
          </div>
        </div>
        <SidePanel
          maxPoles={maxPoles}
          setMaxPoles={setMaxPoles}
          showEllipses={showEllipses}
          setShowEllipses={setShowEllipses}
          minAge={ageScale.minAge}
          maxAge={ageScale.maxAge}
          hasAges={ageScale.hasAges}
          colors={colors}
        />
      </div>
    </div>
  );
}

// --- Plugin module -------------------------------------------------------------------

const polesPlugin: PluginModule = {
  // The detail card's own tiles (only on its level; every other cell is core's).
  gridCell({ column, hit, level, config }) {
    if (level.table !== POLES_LEVEL.table || !CARD_TILES.has(column.key)) return null;
    const width = column.width;
    switch (column.key) {
      case "pole_map": {
        const color = polesConfig(config).age_color?.selected ?? DEFAULT_AGE_COLORS.selected;
        return <PoleMapTile hit={hit} color={color} width={width} />;
      }
      case "pole":
        return <PoleTile hit={hit} width={width} />;
      case "pole_age":
        return <AgeTile hit={hit} width={width} />;
      default:
        return <DirectionTile hit={hit} width={width} />;
    }
  },
  // Legacy home page: a full-width "Poles / View" tiny card under the primary cards.
  homeCards(config) {
    const pconfig = polesConfig(config);
    if (!pconfig.base_level) return [];
    return [
      {
        key: "poles",
        title: "Poles\nView",
        to: "/search",
        search: { level: pconfig.base_level, view: "Poles" },
      },
    ];
  },
  // A contribution's poles on the same map, in its modal.
  contributionTabs(config) {
    const pconfig = polesConfig(config);
    if (!pconfig.base_level) return [];
    return [
      {
        key: "poles",
        label: "Poles",
        countTable: pconfig.table ?? "poles",
        render: ({ id, privateKey, config: node }) => (
          <PolesMapView
            hits={[]}
            level={POLES_LEVEL}
            config={node}
            privateKey={privateKey}
            query=""
            ranges={[]}
            contribution={id}
          />
        ),
      },
    ];
  },
  // Poles is a sub-tab of its base level (Locations), added after `after_sub_tab`.
  levelSubTabs(level, config) {
    const pconfig = polesConfig(config);
    if (!pconfig.base_level || pconfig.base_level !== level.name) return [];
    return [
      {
        name: "Poles",
        countTable: pconfig.table ?? "poles",
        render: (ctx) => <PolesMapView {...ctx} />,
      },
    ];
  },
};

export default polesPlugin;
