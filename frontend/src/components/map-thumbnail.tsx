import { geoOrthographic } from "d3-geo";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../lib/base";
import {
  THUMBNAIL_HEIGHT as HEIGHT,
  THUMBNAIL_POLAR_ROWS as POLAR_ROWS,
  THUMBNAIL_WIDTH as WIDTH,
} from "./map/basemap";
import { type Body, bodiesOf, isBody } from "./map/bodies";

/**
 * Orthographic globe thumbnail centred on the result's markers, drawn from
 * the Esri Ocean basemap that the search page's Map tab uses (as
 * osu-mgr.org's result thumbnails are). Replaces the legacy
 * `svg_map_thumbnail.jsx` globe of 110m countries coloured by climate.
 * Markers on the Moon or Mars are drawn on that body's globe instead.
 */

export interface MapMarker {
  lat: number;
  lon: number;
  // The planetary body it is on, when not Earth.
  body?: Exclude<Body, "earth">;
}

// Each body's basemap as one low-resolution image of the whole body, shared
// by every thumbnail on the page, from the API's cache (/v2/basemap). Earth's
// stops at Web Mercator's limit, so past that the north comes from Esri's
// Arctic version of it and the south is its plain Antarctic ice (as on the
// maps); the other bodies' go to the poles.
const ANTARCTIC_COLOR = "#f1f0eb";
// Without the image (its source unreachable), the globe is plain ocean, or
// the body's grey or red.
const PLAIN_COLOR: Record<Body, string> = { earth: "#8db3e2", moon: "#8e8e8e", mars: "#b86a45" };
const MARKER_COLOR = "#8B5A8E";

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

const basemaps = new Map<Body, Promise<ImageData | null>>();
function loadBasemap(body: Body): Promise<ImageData | null> {
  const cached = basemaps.get(body);
  if (cached) return cached;
  const images =
    body === "earth"
      ? [
          loadImage(apiUrl("/basemap/world")),
          loadImage(apiUrl("/basemap/arctic")).catch(() => null),
        ]
      : [loadImage(apiUrl(`/basemap/${body}`))];
  const loading = Promise.all(images)
    .then(([image, arctic]) => {
      if (!image) return null;
      const canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0, WIDTH, HEIGHT);
      if (body === "earth") {
        if (arctic) context.drawImage(arctic, 0, 0);
        context.fillStyle = ANTARCTIC_COLOR;
        context.fillRect(0, HEIGHT - POLAR_ROWS, WIDTH, POLAR_ROWS);
      }
      return context.getImageData(0, 0, WIDTH, HEIGHT);
    })
    .catch(() => null);
  basemaps.set(body, loading);
  return loading;
}

const RAD = Math.PI / 180;

/** Spherical mean of the markers (average of their unit vectors), so markers
 * straddling the antimeridian centre on themselves. Returns [lon, lat]. */
function sphericalCentroid(markers: MapMarker[]): [number, number] {
  if (markers.length === 0) return [0, 0];
  if (markers.length === 1) return [markers[0].lon, markers[0].lat];
  let [x, y, z] = [0, 0, 0];
  for (const { lat, lon } of markers) {
    x += Math.cos(lat * RAD) * Math.cos(lon * RAD);
    y += Math.cos(lat * RAD) * Math.sin(lon * RAD);
    z += Math.sin(lat * RAD);
  }
  return [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];
}

// The globe centred on the markers, drawn pixel by pixel from the basemap,
// with the markers on top.
function drawThumbnail(
  canvas: HTMLCanvasElement,
  markers: MapMarker[],
  width: number,
  height: number,
  image: ImageData | null,
  body: Body,
) {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const [w, h] = [Math.round(width * scale), Math.round(height * scale)];
  const radius = (Math.min(width, height) / 2 - 2) * scale;
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  if (!context) return;
  const [centerLon, centerLat] = sphericalCentroid(markers);
  const projection = geoOrthographic()
    .scale(radius)
    .translate([w / 2, h / 2])
    .rotate([-centerLon, -centerLat]);

  if (image) {
    const out = context.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [dx, dy] = [x + 0.5 - w / 2, y + 0.5 - h / 2];
        if (dx * dx + dy * dy > radius * radius) continue;
        const lonLat = projection.invert?.([x + 0.5, y + 0.5]);
        if (!lonLat) continue;
        const column = ((Math.floor(((lonLat[0] + 180) / 360) * WIDTH) % WIDTH) + WIDTH) % WIDTH;
        const row = Math.min(
          Math.max(Math.floor(((90 - lonLat[1]) / 180) * HEIGHT), 0),
          HEIGHT - 1,
        );
        const from = (row * WIDTH + column) * 4;
        const to = (y * w + x) * 4;
        out.data[to] = image.data[from];
        out.data[to + 1] = image.data[from + 1];
        out.data[to + 2] = image.data[from + 2];
        out.data[to + 3] = 255;
      }
    }
    context.putImageData(out, 0, 0);
  } else {
    context.beginPath();
    context.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
    context.fillStyle = PLAIN_COLOR[body];
    context.fill();
  }

  // Slightly smaller markers when there are many, so they don't merge into
  // a single blob at thumbnail scale.
  const markerRadius = (markers.length > 20 ? 2 : 3) * scale;
  context.fillStyle = MARKER_COLOR;
  context.strokeStyle = "#ffffff";
  context.lineWidth = scale;
  for (const { lat, lon } of markers) {
    // Skip markers on the far hemisphere rather than drawing them through the globe.
    const cosAngle =
      Math.sin(lat * RAD) * Math.sin(centerLat * RAD) +
      Math.cos(lat * RAD) * Math.cos(centerLat * RAD) * Math.cos((lon - centerLon) * RAD);
    if (cosAngle < 0) continue;
    const at = projection([lon, lat]);
    if (!at) continue;
    context.beginPath();
    context.arc(at[0], at[1], markerRadius, 0, 2 * Math.PI);
    context.fill();
    context.stroke();
  }

  // Softens the globe's pixel edge.
  context.beginPath();
  context.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
  context.strokeStyle = "rgba(255,255,255,0.3)";
  context.lineWidth = scale;
  context.stroke();
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The body with the most markers, and those on it.
  const body = bodiesOf(markers)[0] ?? "earth";
  const shown = useMemo(
    () => markers.filter((marker) => (marker.body ?? "earth") === body),
    [markers, body],
  );
  // undefined while the basemap loads; null when it failed.
  const [image, setImage] = useState<ImageData | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setImage(undefined);
    loadBasemap(body).then((data) => {
      if (alive) setImage(data);
    });
    return () => {
      alive = false;
    };
  }, [body]);

  useEffect(() => {
    if (canvasRef.current && image !== undefined) {
      drawThumbnail(canvasRef.current, shown, width, height, image, body);
    }
  }, [shown, width, height, image, body]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={
        body === "earth"
          ? "Map of the result locations"
          : `Map of the result locations on ${body === "moon" ? "the Moon" : "Mars"}`
      }
      style={{ display: "block", width, height }}
    />
  );
}

/** Markers from a summary `_geo_point` value: `{lat, lon}`, GeoJSON
 * `{coordinates: [lon, lat]}`, a `"lat,lon"` string, or an array of those;
 * or a `_body_point` value (`{lat, lon, body}`, or an array of those). */
export function markersFromGeoPoint(value: unknown): MapMarker[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  const markers: MapMarker[] = [];
  const push = (lat: unknown, lon: unknown, body?: unknown) => {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const on = isBody(body) && body !== "earth" ? body : undefined;
    const key = `${latitude},${longitude},${on ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    markers.push({ lat: latitude, lon: longitude, ...(on && { body: on }) });
  };
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if ("lat" in record && "lon" in record) push(record.lat, record.lon, record.body);
      else if (Array.isArray(record.coordinates))
        push(record.coordinates[1], record.coordinates[0]);
    } else if (typeof entry === "string" && entry.includes(",")) {
      const [lat, lon] = entry.split(",");
      push(lat, lon);
    }
  }
  return markers;
}
