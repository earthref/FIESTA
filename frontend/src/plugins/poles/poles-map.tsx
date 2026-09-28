import { lazy, Suspense, useMemo } from "react";
import type { MapLine } from "../../components/map/lines-layer";
import { ModeButtons, useSavedMode } from "../../components/map/map-mode";
import type { MapPoint } from "../../components/map/map-points";
import { Spinner } from "../../components/ui/spinner";
import { type AgeScale, boundaryRings, formatAge, type Pole, uncertaintyRing } from "./poles-data";

// MapLibre (~800 KB) loads with the first map.
const MapLibreMap = lazy(() => import("../../components/map/maplibre-map"));

interface PolesMapProps {
  poles: Pole[];
  ageScale: AgeScale;
  boundaries: unknown | null;
  plateColor: string;
  selectedColor: string;
  showEllipses: boolean;
  selected: number | null;
  onSelect: (index: number) => void;
}

/**
 * The poles on the search map's MapLibre views (globe, Mercator, and a globe
 * over either pole, where most poles crowd), with the plate boundaries and
 * each pole's a95 uncertainty ellipse in its age colour. Replaces the legacy
 * pair of echarts-gl globes (view + antipode): the pole views show both
 * hemispheres' poles without one.
 */
export default function PolesMap({
  poles,
  ageScale,
  boundaries,
  plateColor,
  selectedColor,
  showEllipses,
  selected,
  onSelect,
}: PolesMapProps) {
  const [mode, setMode] = useSavedMode("poles-map-mode");

  const points = useMemo<MapPoint[]>(
    () =>
      poles.map((pole, index) => ({
        id: String(index),
        contribution: pole.contributionId,
        name: pole.name,
        label: pole.age !== undefined ? `pole, ${formatAge(pole.age)}` : "pole, unknown age",
        color: index === selected ? selectedColor : ageScale.color(pole.age),
        lat: pole.lat,
        lon: pole.lon,
      })),
    [poles, ageScale, selected, selectedColor],
  );

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

  const lines = useMemo<MapLine[]>(() => {
    if (!showEllipses) return plates;
    const ellipse = (pole: Pole, color: string, width: number): MapLine[] => {
      const coords = uncertaintyRing(pole);
      return coords ? [{ coords, color, width, opacity: 0.9 }] : [];
    };
    const others = poles.flatMap((pole, index) =>
      index === selected ? [] : ellipse(pole, ageScale.color(pole.age), 2),
    );
    // The selected pole's ellipse on top.
    const chosen = selected !== null && poles[selected] ? poles[selected] : null;
    return [...plates, ...others, ...(chosen ? ellipse(chosen, selectedColor, 3) : [])];
  }, [plates, poles, ageScale, showEllipses, selected, selectedColor]);

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <ModeButtons mode={mode} setMode={setMode} />
        <span className="text-gray-600">
          {poles.length.toLocaleString()} {poles.length === 1 ? "pole" : "poles"}
        </span>
      </div>
      <div className="relative min-h-[300px] flex-1 overflow-hidden rounded-sm border border-gray-300">
        <Suspense fallback={<Spinner />}>
          <MapLibreMap
            mode={mode}
            points={points}
            lines={lines}
            pointRadius={5}
            fit
            focusKey={poles}
            onSelect={(id) => onSelect(Number(id))}
          />
        </Suspense>
      </div>
    </div>
  );
}
