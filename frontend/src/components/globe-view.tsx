import * as echarts from "echarts";
import "echarts-gl";
import { useEffect, useRef } from "react";
import type { MapMarker } from "./map-thumbnail";

/**
 * One interactive 3D globe (echarts-gl) with the given markers, opened from a
 * result card's map thumbnail. Lazy-loaded: echarts-gl is ~1.7 MB, shared
 * with the poles plugin's chunk. The camera starts over the markers' centroid.
 */
export default function GlobeView({
  markers,
  baseTexture,
  color = "#800080",
}: {
  markers: MapMarker[];
  /** Optional equirectangular texture URL; a flat land colour otherwise. */
  baseTexture?: string;
  color?: string;
}) {
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!divRef.current) return;
    const chart = echarts.init(divRef.current);
    const center = markers.length
      ? {
          lat: markers.reduce((sum, m) => sum + m.lat, 0) / markers.length,
          lon: markers.reduce((sum, m) => sum + m.lon, 0) / markers.length,
        }
      : { lat: 0, lon: 0 };
    chart.setOption({
      backgroundColor: "#FFF",
      globe: {
        baseTexture,
        baseColor: baseTexture ? "#fff" : "#e8e4dc",
        shading: "lambert",
        environment: "#FFF",
        light: { ambient: { intensity: 1 }, main: { intensity: 0 } },
        viewControl: {
          autoRotate: false,
          distance: 200,
          // echarts-gl: alpha tilts to the latitude; beta rotates about the
          // vertical axis with longitude 0 facing +90 (found by locating the
          // rendered marker, see docs/legacy-ux-spec.md).
          alpha: center.lat,
          beta: center.lon + 90,
          rotateSensitivity: 2,
          zoomSensitivity: 2,
        },
      },
      series: [
        {
          type: "scatter3D",
          coordinateSystem: "globe",
          symbol: "circle",
          symbolSize: 12,
          itemStyle: { color, borderColor: "#fff", borderWidth: 1 },
          data: markers.map((m) => ({ value: [m.lon, m.lat, 0] })),
        },
      ],
    } as echarts.EChartsCoreOption);
    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
    };
  }, [markers, baseTexture, color]);

  return <div ref={divRef} style={{ width: "100%", height: "100%" }} />;
}
