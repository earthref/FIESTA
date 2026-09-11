import { geoGraticule, geoOrthographic, geoPath } from "d3-geo";
import { useEffect, useMemo, useState } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

/**
 * Orthographic globe thumbnail centred on the result's markers (legacy
 * `common/components/svg_map_thumbnail.jsx`): blue sphere, faint graticule,
 * land coloured by a coarse climate lookup on country name, purple markers.
 * The 110m world atlas (~100 KB) is loaded once, lazily, in its own chunk.
 */

export interface MapMarker {
  lat: number;
  lon: number;
}

type CountriesTopology = Topology<{ countries: GeometryCollection<{ name?: string }> }>;

let worldPromise: Promise<CountriesTopology> | undefined;

function loadWorld(): Promise<CountriesTopology> {
  worldPromise ??= import("world-atlas/countries-110m.json").then(
    (module) => module.default as unknown as CountriesTopology,
  );
  return worldPromise;
}

const ICE = ["Antarctica", "Greenland", "Iceland"];
const DESERT = [
  "Algeria",
  "Libya",
  "Egypt",
  "Saudi Arabia",
  "Chad",
  "Niger",
  "Mali",
  "Mauritania",
  "Sudan",
  "Mongolia",
  "Kazakhstan",
];
const FOREST = [
  "Brazil",
  "Congo",
  "Indonesia",
  "Malaysia",
  "Colombia",
  "Venezuela",
  "Peru",
  "Ecuador",
  "Gabon",
  "Cameroon",
];

function countryColor(name = ""): string {
  if (ICE.some((entry) => name.includes(entry))) return "#f0f8ff";
  if (DESERT.some((entry) => name.includes(entry))) return "#deb887";
  if (FOREST.some((entry) => name.includes(entry))) return "#228B22";
  return "#6B8E23";
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** True when the point is on the hemisphere facing the viewer. */
function onFrontHemisphere(center: MapMarker, point: MapMarker): boolean {
  const lat1 = toRadians(center.lat);
  const lat2 = toRadians(point.lat);
  const dLon = toRadians(point.lon - center.lon);
  const cosAngle =
    Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return cosAngle >= 0;
}

export function MapThumbnail({
  markers,
  width = 100,
  height = 100,
}: {
  markers: MapMarker[];
  width?: number;
  height?: number;
}) {
  const [world, setWorld] = useState<CountriesTopology | null>(null);

  useEffect(() => {
    let alive = true;
    loadWorld()
      .then((data) => {
        if (alive) setWorld(data);
      })
      .catch(() => {
        // Without the atlas the sphere and markers still render.
      });
    return () => {
      alive = false;
    };
  }, []);

  const center = useMemo<MapMarker>(() => {
    if (markers.length === 0) return { lat: 0, lon: 0 };
    return {
      lat: markers.reduce((sum, marker) => sum + marker.lat, 0) / markers.length,
      lon: markers.reduce((sum, marker) => sum + marker.lon, 0) / markers.length,
    };
  }, [markers]);

  const radius = Math.min(width, height) / 2 - 2;
  const projection = useMemo(
    () =>
      geoOrthographic()
        .scale(radius)
        .translate([width / 2, height / 2])
        .rotate([-center.lon, -center.lat]),
    [radius, width, height, center],
  );
  const path = useMemo(() => geoPath(projection), [projection]);
  const countries = useMemo(
    () => (world ? feature(world, world.objects.countries).features : []),
    [world],
  );

  const sphere = path({ type: "Sphere" }) ?? undefined;
  const graticule = path(geoGraticule()()) ?? undefined;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Map of the result locations"
      style={{ display: "block" }}
    >
      <path d={sphere} fill="#4a90e2" />
      <path d={graticule} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
      {countries.map((country, index) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: static atlas features, never reordered
          key={index}
          d={path(country) ?? undefined}
          fill={countryColor(country.properties?.name)}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth={0.2}
        />
      ))}
      {markers.map((marker) => {
        if (!onFrontHemisphere(center, marker)) return null;
        const point = projection([marker.lon, marker.lat]);
        if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
        return (
          <circle
            key={`${marker.lat},${marker.lon}`}
            cx={point[0]}
            cy={point[1]}
            r={3}
            fill="#8B5A8E"
            stroke="white"
            strokeWidth={1}
          />
        );
      })}
      <path d={sphere} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
    </svg>
  );
}

/** Markers from a summary `_geo_point` value: `{lat, lon}`, GeoJSON
 * `{coordinates: [lon, lat]}`, a `"lat,lon"` string, or an array of those. */
export function markersFromGeoPoint(value: unknown): MapMarker[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  const markers: MapMarker[] = [];
  const push = (lat: unknown, lon: unknown) => {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const key = `${latitude},${longitude}`;
    if (seen.has(key)) return;
    seen.add(key);
    markers.push({ lat: latitude, lon: longitude });
  };
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if ("lat" in record && "lon" in record) push(record.lat, record.lon);
      else if (Array.isArray(record.coordinates))
        push(record.coordinates[1], record.coordinates[0]);
    } else if (typeof entry === "string" && entry.includes(",")) {
      const [lat, lon] = entry.split(",");
      push(lat, lon);
    }
  }
  return markers;
}
