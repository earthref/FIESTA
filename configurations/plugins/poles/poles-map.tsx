import { lazy, Suspense, useMemo } from "react";
import type { MapLine } from "@/components/map/lines-layer";
import { ModeButtons, useSavedMode } from "@/components/map/map-mode";
import type { MapPoint } from "@/components/map/map-points";
import { Spinner } from "@/components/ui/spinner";
import { type AgeScale, boundaryRings, formatAge, type Pole, uncertaintyRing } from "./poles-data";

// MapLibre (~800 KB) loads with the first map.
const MapLibreMap = lazy(() => import("@/components/map/maplibre-map"));

// The uncertainty outlines' segment budget: each costs ~200 bytes of GPU
// buffer, rebuilt on every selection, so past ~1,000 poles their ~100-vertex
// rings are thinned (to no fewer than MIN_RING_SEGMENTS; still a smooth
// ellipse at map scale).
const RING_SEGMENT_BUDGET = 100_000;
const MIN_RING_SEGMENTS = 12;

const ellipse = (pole: Pole, color: string, width: number, segments?: number): MapLine[] => {
  const coords = uncertaintyRing(pole, segments);
  return coords ? [{ coords, color, width, opacity: 0.9 }] : [];
};

interface PolesMapProps {
  poles: Pole[];
  /** Every match, when the search window cut the poles short (the count). */
  matched?: number;
  ageScale: AgeScale;
  boundaries: unknown | null;
  plateColor: string;
  selectedColor: string;
  showEllipses: boolean;
  /** The selected pole's `index` (its grid row). */
  selected: number | null;
  onSelect: (index: number) => void;
  /** Where to turn or pan the map to (a pole picked in the grid). */
  centerOn?: { lon: number; lat: number } | null;
}

/**
 * The poles on the search map's MapLibre views (globe, Mercator, and a globe
 * over either pole, where most poles crowd), with the plate boundaries and
 * each pole's uncertainty outline in its age colour (its a95 circle or dp/dm
 * ellipse, a ring the backend computed with PmagPy). Replaces the legacy
 * pair of echarts-gl globes (view + antipode): the pole views show both
 * hemispheres' poles without one.
 */
export default function PolesMap({
  poles,
  matched,
  ageScale,
  boundaries,
  plateColor,
  selectedColor,
  showEllipses,
  selected,
  onSelect,
  centerOn,
}: PolesMapProps) {
  const [mode, setMode] = useSavedMode("poles-map-mode");

  // The selected pole last, so it draws on top of the poles around it.
  const points = useMemo<MapPoint[]>(() => {
    const all = poles.map((pole) => ({
      id: String(pole.index),
      contribution: pole.contributionId,
      name: pole.name,
      label: pole.age !== undefined ? `pole, ${formatAge(pole.age)}` : "pole, unknown age",
      color: pole.index === selected ? selectedColor : ageScale.color(pole.age),
      lat: pole.lat,
      lon: pole.lon,
    }));
    const at = selected !== null ? poles.findIndex((pole) => pole.index === selected) : -1;
    return at < 0 ? all : [...all.slice(0, at), ...all.slice(at + 1), all[at]];
  }, [poles, ageScale, selected, selectedColor]);

  const plates = useMemo<MapLine[]>(
    () =>
      boundaryRings(boundaries).map((coords) => ({
        coords,
        color: plateColor,
        width: 1.5,
        opacity: 0.8,
      })),
    [boundaries, plateColor],
  );

  const segments = Math.max(
    MIN_RING_SEGMENTS,
    Math.floor(RING_SEGMENT_BUDGET / Math.max(poles.length, 1)),
  );
  // Every pole's ellipse in its age colour (not rebuilt on selection).
  const ellipses = useMemo<MapLine[]>(
    () => poles.flatMap((pole) => ellipse(pole, ageScale.color(pole.age), 2, segments)),
    [poles, ageScale, segments],
  );
  const lines = useMemo<MapLine[]>(() => {
    if (!showEllipses) return plates;
    // The selected pole's ellipse on top, at full resolution.
    const chosen = selected !== null ? poles.find((pole) => pole.index === selected) : undefined;
    return [...plates, ...ellipses, ...(chosen ? ellipse(chosen, selectedColor, 3) : [])];
  }, [plates, ellipses, poles, showEllipses, selected, selectedColor]);

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <ModeButtons mode={mode} setMode={setMode} />
        <span className="text-gray-600">
          {matched !== undefined
            ? `The first ${poles.length.toLocaleString()} of ${matched.toLocaleString()} poles`
            : `${poles.length.toLocaleString()} ${poles.length === 1 ? "pole" : "poles"}`}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm border border-gray-300">
        <Suspense fallback={<Spinner />}>
          <MapLibreMap
            mode={mode}
            points={points}
            lines={lines}
            pointRadius={5}
            fit
            focusKey={poles}
            centerOn={centerOn}
            onSelect={(id) => onSelect(Number(id))}
          />
        </Suspense>
      </div>
    </div>
  );
}
