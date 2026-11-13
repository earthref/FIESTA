import { type UseQueryResult, useQueries, useQuery } from "@tanstack/react-query";
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
import { ErrorMessage } from "@/components/error-message";
import { MapThumbnail } from "@/components/map-thumbnail";
import { Cell, contributionId, NoDataCell } from "@/components/result-item";
import { SummaryGrid } from "@/components/summary-grid";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useOpenContribution } from "@/lib/contribution-modal";
import { usePagedItems } from "@/lib/paged";
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

// The map draws every matching pole, fetched MAP_PAGE at a time (the search's
// largest page) with only the fields it needs, up to OpenSearch's from + size
// window; the grid under it fetches the full docs of the rows in view.
const MAP_PAGE = 1000;
const MAX_POLES = 10_000;
const GRID_PAGE = 25;
const MAP_FIELDS = [
  "summary.poles.pole_lat",
  "summary.poles.pole_lon",
  "summary.poles.age",
  "summary.poles._geometry",
  "summary.contribution.id",
  "summary.locations.location",
];
// The grid's sticky header and a thumbnail row (SummaryGrid's estimate): the
// map leaves room for the header and two rows under it, down to MIN_MAP (its
// toolbar included), when the grid shrinks to what is left, at least a row.
const GRID_HEADER = 33;
const GRID_ROW = 129;
const MIN_MAP = 300;
// The map row's height over its map's: the toolbar (~28-30px), the paddings and
// border, less the side padding and border the map's width loses. The map is
// at most as tall as it is wide.
const MAP_CHROME = 36;
// The search field the default Pole A95 filter sets (the sidebar's control).
const ALPHA95_FIELD = "summary.poles.pole_alpha95";

interface PolesPluginConfig {
  base_level?: string;
  after_sub_tab?: string;
  table?: string;
  has_plate_boundaries?: boolean;
  plate_boundary_color?: string;
  age_color?: Partial<AgeColors>;
  default_alpha95_max?: number | null;
  default_alpha95_above?: number;
}

function polesConfig(config: NodeConfig): PolesPluginConfig {
  return (config.plugins.poles ?? {}) as PolesPluginConfig;
}

// --- The grid: a pole per Summaries row ----------------------------------------------

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
// grid fills in the rest from its location row.
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

/** The hit as the grid reads it: `_all` completed from the location row,
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

// The grid's tiles: the core Summaries tiles plus the plugin's own (rendered by
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

/** The pole on the whole globe, centred on it, with its uncertainty outline
 * (none on a doc indexed before the rings: `fiesta rebuild`). */
function PoleMapTile({ hit, color, width }: { hit: SearchResult; color: string; width: number }) {
  const [pole] = useMemo(() => polesFromHits([hit]), [hit]);
  const markers = useMemo(
    () => (pole ? [{ lat: pole.lat, lon: pole.lon, color }] : []),
    [pole, color],
  );
  const rings = useMemo(() => (pole?.ring ? [{ points: pole.ring, color }] : []), [pole, color]);
  const dots = useMemo(() => (pole?.vgps ? [{ points: pole.vgps, color }] : []), [pole, color]);
  if (!pole) return <NoDataCell label="Pole" width={width} />;
  return (
    <Cell width={width} style={{ height: 104 }}>
      <MapThumbnail
        markers={markers}
        rings={rings}
        dots={dots}
        label={
          pole.vgps
            ? "Map of the pole, its uncertainty outline and its VGPs"
            : "Map of the pole and its uncertainty outline"
        }
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

// --- Side panel (ellipse toggle, color legend) ------------------------------------

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
          className="flex flex-col justify-between text-[13px] text-gray-600"
          style={{ height: 150 }}
        >
          {labels.map((label, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5-tick legend
            <span key={i}>{label || "—"}</span>
          ))}
        </div>
      </div>
      <div className="mt-2 space-y-1 text-[13px] text-gray-600">
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

const SECTION_STYLE = { padding: "0.25em 1em 0.5em" };
const HEADING = "mb-1 text-[13px] font-bold text-ink";

/** A side-panel section's Show / Hide pair. */
function ShowHide({
  title,
  show,
  setShow,
}: {
  title: string;
  show: boolean;
  setShow: (show: boolean) => void;
}) {
  return (
    <div className="border-b border-edge" style={SECTION_STYLE}>
      <h5 className={HEADING}>{title}</h5>
      <div className="flex gap-1">
        {[true, false].map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={show === value}
            onClick={() => setShow(value)}
            className={cx(
              "flex-1 rounded-sm px-2 py-1 text-[13px] font-medium",
              show === value
                ? "bg-node text-white"
                : "border border-gray-300 bg-surface text-gray-600",
            )}
          >
            {value ? "Show" : "Hide"}
          </button>
        ))}
      </div>
    </div>
  );
}

function SidePanel({
  showEllipses,
  setShowEllipses,
  showVgps,
  setShowVgps,
  minAge,
  maxAge,
  hasAges,
  colors,
}: {
  showEllipses: boolean;
  setShowEllipses: (show: boolean) => void;
  /** Absent when no pole has VGPs (no toggle). */
  showVgps?: boolean;
  setShowVgps: (show: boolean) => void;
  minAge: number;
  maxAge: number;
  hasAges: boolean;
  colors: AgeColors;
}) {
  return (
    <aside className="w-[180px] shrink-0 overflow-y-auto border-l border-edge bg-surface">
      <ShowHide title="Uncertainty Ellipses" show={showEllipses} setShow={setShowEllipses} />
      {showVgps !== undefined && <ShowHide title="VGPs" show={showVgps} setShow={setShowVgps} />}
      <div style={SECTION_STYLE}>
        <h5 className={HEADING}>Color Legend</h5>
        <ColorLegend minAge={minAge} maxAge={maxAge} hasAges={hasAges} colors={colors} />
      </div>
    </aside>
  );
}

// --- Poles map sub-tab: map + side panel over a grid of the poles -------------------

/** The height from `ref`'s top to the bottom of its scrolling ancestor (the
 * search page's view, the contribution modal's tab), kept as either resizes. */
function useAvailableHeight(ref: RefObject<HTMLElement | null>): number | undefined {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = ref.current;
    let scroller = element?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    if (!element || !scroller) return;
    const host = scroller;
    const update = () => {
      const top =
        element.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
      const padding = Number.parseFloat(getComputedStyle(host).paddingBottom) || 0;
      setHeight(Math.floor(host.clientHeight - top - padding));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

type PolesPage = UseQueryResult<SearchPageData>;
const pagesOf = (results: PolesPage[]) => ({
  pages: results.map((result) => result.data),
  error: results.find((result) => result.error)?.error ?? null,
});
const pageTotal = (page: SearchPageData) => page.total;
const pageResults = (page: SearchPageData) => page.results;

function PolesMapView({
  query,
  ranges,
  bbox,
  config,
  contribution,
  privateKey,
  scope,
  setRanges,
}: PluginSubTabContext) {
  // The selected pole: its grid row (a map point's `index`).
  const [selected, setSelected] = useState<number | null>(null);
  // The pole a grid row picked, which the map turns or pans to (a new object
  // per pick, so every pick moves the map, even back to the same pole).
  const [centerOn, setCenterOn] = useState<{ lon: number; lat: number } | null>(null);
  const [showEllipses, setShowEllipses] = useState(true);
  const [showVgps, setShowVgps] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const available = useAvailableHeight(rootRef);
  const [mapWidth, setMapWidth] = useState<number>();
  const mapColumnRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(() => setMapWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const openContribution = useOpenContribution();

  const pconfig = polesConfig(config);
  const colors: AgeColors = { ...DEFAULT_AGE_COLORS, ...pconfig.age_color };

  // A search page arriving here with no filters, over more than
  // `default_alpha95_above` poles, opens on the well-determined ones: it sets
  // the sidebar's Pole A95 filter, which the user can clear. Decided once, on
  // arrival ("undecided" until the first page says how many poles match, then
  // "applying" until the filter reaches the search), so clearing the filters
  // later shows every pole.
  const [defaultPhase, setDefaultPhase] = useState<"undecided" | "applying" | "done">("undecided");
  const alpha95Max = pconfig.default_alpha95_max;
  const unfiltered =
    !query && ranges.length === 0 && !bbox && !contribution && !scope?.mine && !scope?.versions;
  const canDefault = setRanges !== undefined && alpha95Max != null && unfiltered;
  const defaultPending =
    (defaultPhase === "undecided" && canDefault) || defaultPhase === "applying";

  const params = {
    ...scope,
    query: query || undefined,
    range: ranges.length > 0 ? ranges : undefined,
    bbox: bbox || undefined,
    contribution,
    private_key: contribution ? privateKey : undefined,
  };
  const searchKey = ["plugin", "poles", "search", query, ranges, bbox, contribution, scope];
  // The map's poles and the grid's rows are the same search in the same
  // (default) order, so a pole's position is its row.
  const fetchMapPage = (page: number) =>
    api<SearchPageData>("/search/poles", {
      params: { ...params, size: MAP_PAGE, from: page * MAP_PAGE, source: MAP_FIELDS },
    });
  const firstMapPage = useQuery({
    queryKey: [...searchKey, "map", 0],
    queryFn: () => fetchMapPage(0),
    staleTime: 60_000,
  });
  const matched = firstMapPage.data?.total ?? 0;
  const firstLoaded = firstMapPage.data !== undefined;
  useEffect(() => {
    if (defaultPhase === "applying" && !unfiltered) setDefaultPhase("done");
    if (defaultPhase !== "undecided") return;
    if (!canDefault) setDefaultPhase("done");
    else if (firstLoaded) {
      if (matched > (pconfig.default_alpha95_above ?? 1000)) {
        setDefaultPhase("applying");
        setRanges?.([`${ALPHA95_FIELD}::${alpha95Max}`]);
      } else setDefaultPhase("done");
    }
  }, [defaultPhase, unfiltered, canDefault, firstLoaded, matched]);
  const shown = Math.min(matched, MAX_POLES);
  const restMapPages = useQueries({
    queries: Array.from({ length: Math.max(0, Math.ceil(shown / MAP_PAGE) - 1) }, (_, i) => ({
      queryKey: [...searchKey, "map", i + 1],
      queryFn: () => fetchMapPage(i + 1),
      staleTime: 60_000,
      // Not the unfiltered poles the default filter is about to replace.
      enabled: !defaultPending,
    })),
    combine: pagesOf,
  });
  const mapLoaded = firstMapPage.data !== undefined && restMapPages.pages.every(Boolean);

  const grid = usePagedItems({
    queryKey: [...searchKey, "grid"],
    pageSize: GRID_PAGE,
    fetchPage: (page) =>
      api<SearchPageData>("/search/poles", {
        params: { ...params, size: GRID_PAGE, from: page * GRID_PAGE },
      }),
    totalOf: pageTotal,
    itemsOf: pageResults,
    limit: MAX_POLES,
  });
  const rows = useMemo(() => grid.items.map((hit) => hit && cardDocOf(hit)), [grid.items]);

  const boundaries = useQuery({
    queryKey: ["plugin", "poles", "plate-boundaries"],
    queryFn: () => api<unknown>("/plugins/poles/plate-boundaries"),
    enabled: pconfig.has_plate_boundaries === true,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const poles = useMemo<Pole[]>(() => {
    if (!mapLoaded || !firstMapPage.data) return [];
    const hits = [firstMapPage.data, ...restMapPages.pages].flatMap((page) => page?.results ?? []);
    return polesFromHits(hits.slice(0, MAX_POLES));
  }, [mapLoaded, firstMapPage.data, restMapPages.pages]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the colors by value
  const ageScale = useMemo(() => makeAgeScale(poles, colors), [poles, JSON.stringify(colors)]);
  // The VGPs toggle shows only when some pole has VGPs.
  const hasVgps = useMemo(() => poles.some((pole) => pole.vgps), [poles]);

  // A new search clears the selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the list identity changes
  useEffect(() => {
    setSelected(null);
    setCenterOn(null);
  }, [poles]);

  const error = firstMapPage.error ?? restMapPages.error ?? grid.first.error;
  // The map leaves room for the grid's header and two rows under it, and is no
  // taller than it is wide (the rest goes to the grid's rows).
  const mapHeight = Math.min(
    Math.max(MIN_MAP, (available ?? 680) - GRID_HEADER - 2 * GRID_ROW),
    mapWidth !== undefined ? Math.max(MIN_MAP, mapWidth + MAP_CHROME) : Number.POSITIVE_INFINITY,
  );
  const height = Math.max(available ?? 680, mapHeight + GRID_HEADER + GRID_ROW);

  let body: ReactNode;
  if (error) body = <ErrorMessage error={error} className="my-3" />;
  else if (!mapLoaded) body = <PageSpinner label="Loading poles…" />;
  else if (poles.length === 0) {
    body = (
      <p className="py-8 text-center text-[13px] text-gray-500">
        No poles with coordinates for this query.
      </p>
    );
  } else {
    body = (
      <>
        {/* Row 1 — map + side panel */}
        <div className="flex shrink-0" style={{ height: mapHeight }}>
          <div ref={mapColumnRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {boundaries.error && <ErrorMessage error={boundaries.error} className="m-2" />}
            <div className="min-h-0 flex-1">
              <PolesMap
                poles={poles}
                matched={matched > MAX_POLES ? matched : undefined}
                ageScale={ageScale}
                boundaries={boundaries.data ?? null}
                plateColor={pconfig.plate_boundary_color ?? "#990000"}
                selectedColor={colors.selected}
                showEllipses={showEllipses}
                showVgps={hasVgps && showVgps}
                selected={selected}
                onSelect={setSelected}
                centerOn={centerOn}
              />
            </div>
          </div>
          <SidePanel
            showEllipses={showEllipses}
            setShowEllipses={setShowEllipses}
            showVgps={hasVgps ? showVgps : undefined}
            setShowVgps={setShowVgps}
            minAge={ageScale.minAge}
            maxAge={ageScale.maxAge}
            hasAges={ageScale.hasAges}
            colors={colors}
          />
        </div>

        {/* Row 2 — the poles as Summaries rows, scrolling under the map */}
        <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto border-t border-edge">
          <SummaryGrid
            level={CARD_LEVEL}
            hits={rows}
            privateKey={privateKey}
            scrollRef={gridRef}
            overscan={5}
            onRange={grid.onRange}
            onOpen={(doc, index) => {
              // A row's first click selects its pole; a click on the selected
              // row opens its contribution on the location row.
              if (index !== selected) {
                setSelected(index);
                const pole = poles.find((p) => p.index === index);
                if (pole) setCenterOn({ lon: pole.lon, lat: pole.lat });
                return;
              }
              const id = contributionId(doc);
              const hit = grid.items[index];
              if (id) {
                openContribution(id, "locations", hit ? locationRowOf(hit) : undefined, {
                  privateKey,
                });
              }
            }}
            selectedIndex={selected ?? undefined}
          />
        </div>
      </>
    );
  }

  return (
    <div ref={rootRef} className="flex flex-col" style={{ height }}>
      {body}
    </div>
  );
}

// --- Plugin module -------------------------------------------------------------------

const polesPlugin: PluginModule = {
  // The grid's own tiles (only on its level; every other cell is core's).
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
