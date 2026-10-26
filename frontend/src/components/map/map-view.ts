import type * as maplibregl from "maplibre-gl";

// What MapLibre 5's `map.transform` gave the maps, from v6's public API.

/** The map's size in CSS pixels: its canvas's, which MapLibre sizes to the container. */
export const mapSize = (map: maplibregl.Map) => {
  const canvas = map.getCanvas();
  return { width: canvas.clientWidth, height: canvas.clientHeight };
};

// Locations closer than this (in radians) to where they unproject back to
// are in view.
const OCCLUSION_TOLERANCE = 1e-6;

/**
 * Whether the globe hides a location from the camera. A location on its far
 * side projects to the same pixel as one on its near side, which is where that
 * pixel unprojects to; a location in view unprojects back to itself.
 */
export const isOccluded = (map: maplibregl.Map, lngLat: { lng: number; lat: number }) => {
  const point = map.project(lngLat);
  let back: maplibregl.LngLat;
  try {
    back = map.unproject(point);
  } catch {
    // Zoomed in past the globe's turn into the Mercator map, a pixel off
    // the map has no location.
    return true;
  }
  const rad = Math.PI / 180;
  const [phi0, phi1] = [lngLat.lat * rad, back.lat * rad];
  // The haversine distance, which stays accurate for tiny angles.
  const h =
    Math.sin((phi1 - phi0) / 2) ** 2 +
    Math.cos(phi0) * Math.cos(phi1) * Math.sin(((back.lng - lngLat.lng) * rad) / 2) ** 2;
  return 2 * Math.asin(Math.min(Math.sqrt(h), 1)) > OCCLUSION_TOLERANCE;
};
