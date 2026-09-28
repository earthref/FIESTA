import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { SearchLevel } from "../../lib/types";
import { singularize } from "../../lib/utils";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import {
  type ApiMapPoint,
  type Area,
  areaAround,
  areaToBbox,
  type MapPoint,
  MODES,
  type Mode,
  pointKey,
  recordsOf,
  toMapPoint,
  WHOLE_GLOBE,
} from "./map-points";

// MapLibre (~800 KB) loads with the first map.
const MapLibreMap = lazy(() => import("./maplibre-map"));

interface MapPointsPage {
  total: number;
  points: ApiMapPoint[];
  truncated?: boolean;
}

// The view mode, remembered in this browser for every search map.
const MODE_KEY = "search-map-mode";
function savedMode(): Mode {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return MODES.some(([value]) => value === mode) ? (mode as Mode) : "globe";
  } catch {
    return "globe";
  }
}

function usePoints(
  level: SearchLevel,
  query: string,
  ranges: string[] | undefined,
  bbox: string | undefined,
  color: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["search-points", level.table, query, ranges, bbox],
    queryFn: () =>
      api<MapPointsPage>(`/search/${level.table}/points`, {
        params: { query: query || undefined, range: ranges, bbox },
      }),
    select: (page) => ({
      ...page,
      points: page.points.flatMap(
        (p) =>
          toMapPoint(p, singularize(level.name).toLowerCase(), color, level.name.toLowerCase()) ??
          [],
      ),
    }),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

/** An area filter asked for (the sidebar's Geospatial filter or the map's
 * button), in a given view (`mode`), and zooming the map to it (`zoomTo`). */
export type AreaRequest = { mode?: Mode; zoomTo?: boolean };

/**
 * The Map tab (ported from osu-mgr.org's search map): every positioned
 * record at this level matching the search, on a globe, a Mercator map or a
 * globe over either pole, over Esri's Ocean basemap. The area filter narrows
 * the search to a box that can be moved and resized on the map; the records
 * it leaves out stay on the map in grey.
 */
export function SearchMap({
  level,
  query,
  ranges,
  area,
  onAreaChange,
  areaRequest,
  onRequestArea,
  onAreaRequestDone,
  onSelect,
  color,
}: {
  level: SearchLevel;
  query: string;
  ranges?: string[];
  area: Area | null;
  onAreaChange: (area: Area | null) => void;
  areaRequest: AreaRequest | null;
  onRequestArea: () => void;
  // Called when a request needs no new area (there is one already).
  onAreaRequestDone: () => void;
  onSelect: (contributionId: string) => void;
  color: string;
}) {
  const [mode, setModeState] = useState<Mode>(savedMode);
  const setMode = (next: Mode) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // private window: the mode just isn't remembered
    }
  };
  // An area the map zooms to (see AreaRequest).
  const [zoomTo, setZoomTo] = useState<Area | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: switches once per request
  useEffect(() => {
    if (areaRequest?.mode && areaRequest.mode !== mode) setMode(areaRequest.mode);
  }, [areaRequest]);

  const inArea = usePoints(level, query, ranges, area ? areaToBbox(area) : undefined, color);
  // With an area, the same search without it, for the grey context points.
  const all = usePoints(level, query, ranges, undefined, color, Boolean(area));
  const points = inArea.data?.points ?? [];
  const context = useMemo<MapPoint[]>(() => {
    if (!area || !all.data) return [];
    // A record, or a location's records in a contribution (whose name is their
    // number, which differs between the two searches).
    const key = (p: MapPoint) => `${p.id}|${p.count === undefined ? p.name : ""}|${pointKey(p)}`;
    const plotted = new Set(points.map(key));
    return all.data.points.filter((p) => !plotted.has(key(p)));
  }, [area, all.data, points]);

  // An area asked for, in the view asked for, once the search's records have
  // loaded (as on osu-mgr.org): around them, or, for an unfiltered search,
  // over the middle of the view (requestViewArea), which leaves the map where
  // it is. With an area already, the request only zooms to it.
  const unfiltered = !query.trim() && !ranges?.length;
  const areaPending =
    Boolean(areaRequest) && (!areaRequest?.mode || areaRequest.mode === mode) && !inArea.isFetching;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the request can be answered
  useEffect(() => {
    if (!areaPending) return;
    if (area) {
      if (areaRequest?.zoomTo) setZoomTo(area);
      onAreaRequestDone();
      return;
    }
    if (unfiltered) return;
    const next = areaAround(points) ?? WHOLE_GLOBE;
    if (areaRequest?.zoomTo) setZoomTo(next);
    onAreaChange(next);
  }, [areaPending, unfiltered]);
  const requestViewArea = areaPending && !area && unfiltered;

  // Records mapped: a contribution is drawn at each of its positions, and a
  // large search's points are locations with a count of records each.
  const mapped =
    level.table === "contribution"
      ? new Set(points.map((p) => p.id)).size
      : points.reduce((sum, p) => sum + recordsOf(p), 0);
  const locations = points.some((p) => p.count !== undefined)
    ? new Set(points.map((p) => pointKey(p))).size
    : undefined;

  // The view re-centres on the points for a new search, not for an area edit.
  const focusKey = JSON.stringify([level.table, query, ranges]);
  // Only show the loading overlay when a refresh is slow.
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!inArea.isFetching) return setShowLoading(false);
    const timer = setTimeout(() => setShowLoading(true), 500);
    return () => clearTimeout(timer);
  }, [inArea.isFetching]);

  const buttonClass = (active: boolean) =>
    active
      ? "border-node bg-node text-white"
      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50";

  return (
    <div className="flex h-full flex-col gap-2 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <div className="inline-flex">
          {MODES.map(([value, label], index) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`border px-2 py-1 font-bold ${buttonClass(mode === value)} ${
                index === 0 ? "rounded-l-sm" : "-ml-px"
              } ${index === MODES.length - 1 ? "rounded-r-sm" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
        {area ? (
          <button
            type="button"
            onClick={() => onAreaChange(null)}
            title="Stop filtering by the area on the map"
            className={`inline-flex items-center gap-1 rounded-sm border px-2 py-1 font-bold ${buttonClass(false)}`}
          >
            <Icon name="close" className="h-3 w-3" />
            Remove area
          </button>
        ) : (
          <button
            type="button"
            onClick={onRequestArea}
            title="Filter to an area you can move and resize on the map"
            className={`inline-flex items-center gap-1 rounded-sm border px-2 py-1 font-bold ${buttonClass(false)}`}
          >
            <Icon name="map-marker" className="h-3 w-3" />
            Filter by area
          </button>
        )}
        {inArea.data && (
          <span className="text-gray-600">
            {mapped.toLocaleString()} mapped {mapped === 1 ? singularize(level.name) : level.name}
            {locations !== undefined && ` at ${locations.toLocaleString()} locations`}
            {inArea.data.truncated && ` (the first of ${inArea.data.total.toLocaleString()})`}
          </span>
        )}
      </div>
      <div className="relative min-h-[300px] flex-1 overflow-hidden rounded-sm border border-gray-300">
        <Suspense fallback={<Spinner />}>
          <MapLibreMap
            mode={mode}
            points={points}
            onSelect={onSelect}
            area={area}
            onAreaChange={onAreaChange}
            requestViewArea={requestViewArea}
            zoomTo={zoomTo}
            focusKey={focusKey}
            context={context}
          />
        </Suspense>
        {showLoading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/40">
            <span className="flex items-center gap-2 rounded-sm bg-white/90 px-3 py-1.5 text-sm shadow">
              <Spinner />
              Loading…
            </span>
          </div>
        ) : (
          !inArea.isFetching &&
          points.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded-sm bg-white/90 px-3 py-1.5 text-sm text-gray-500 shadow">
                {inArea.error
                  ? "The map's records could not be loaded"
                  : "No mapped locations match this search"}
              </span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
