import * as echarts from "echarts";
import "echarts-gl";
import { useEffect, useRef, useState } from "react";
import { siteUrl } from "../../lib/base";
import { type AgeScale, boundaryRings, ellipsePoints, type Pole } from "./poles-data";

interface GlobesProps {
  poles: Pole[];
  ageScale: AgeScale;
  boundaries: unknown | null;
  plateColor: string;
  hasBaseTexture: boolean;
  showEllipses: boolean;
  selected: number | null;
  onSelect: (index: number) => void;
}

const SELECTED_COLOR = "#800080";
const BASE_TEXTURE_URL = siteUrl("/api/plugins/poles/base-texture");

interface Camera {
  alpha: number;
  beta: number;
  distance: number;
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const antipodalView = (c: Camera): Camera => ({
  alpha: wrap180(c.alpha + 180),
  beta: -c.beta,
  distance: c.distance,
});
const antipodalCoord = ([lon, lat]: [number, number]): [number, number] => [
  wrap180(lon + 180),
  -lat,
];

function poleColor(pole: Pole, index: number, ageScale: AgeScale, selected: number | null): string {
  return index === selected ? SELECTED_COLOR : ageScale.color(pole.age);
}

function buildOption(
  poles: Pole[],
  ageScale: AgeScale,
  boundaries: unknown | null,
  plateColor: string,
  hasBaseTexture: boolean,
  showEllipses: boolean,
  selected: number | null,
  camera: Camera,
): echarts.EChartsCoreOption {
  const series: Record<string, unknown>[] = [];

  const rings = boundaryRings(boundaries);
  if (rings.length > 0) {
    series.push({
      type: "lines3D",
      coordinateSystem: "globe",
      polyline: true,
      zlevel: -10,
      silent: true,
      lineStyle: { color: plateColor, opacity: 0.8, width: 2 },
      data: rings.map((ring) => ({ coords: ring })),
    });
  }

  if (showEllipses) {
    const ellipseData = poles
      .map((pole, index) => ({ pole, index }))
      .filter(({ pole }) => pole.alpha95 !== undefined && pole.alpha95 > 0)
      .map(({ pole, index }) => ({
        coords: ellipsePoints(pole.lat, pole.lon, pole.alpha95 as number),
        lineStyle: { color: poleColor(pole, index, ageScale, selected), width: 2, opacity: 0.8 },
      }));
    if (ellipseData.length > 0) {
      series.push({
        type: "lines3D",
        coordinateSystem: "globe",
        polyline: true,
        zlevel: -9,
        silent: true,
        data: ellipseData,
      });
    }
  }

  series.push({
    type: "scatter3D",
    coordinateSystem: "globe",
    zlevel: -8,
    symbol: "circle",
    symbolSize: 12,
    label: { show: false },
    emphasis: { itemStyle: { color: SELECTED_COLOR } },
    data: poles.map((pole, index) => ({
      value: [pole.lon, pole.lat, 0, pole.contributionId ?? "", pole.poleId],
      itemStyle: { color: poleColor(pole, index, ageScale, selected) },
    })),
  });

  return {
    backgroundColor: "#FFF",
    globe: {
      baseTexture: hasBaseTexture ? BASE_TEXTURE_URL : undefined,
      baseColor: hasBaseTexture ? "#fff" : "#e8e4dc",
      shading: "lambert",
      environment: "#FFF",
      light: { ambient: { intensity: 1 }, main: { intensity: 0 } },
      viewControl: {
        autoRotate: false,
        distance: camera.distance,
        alpha: camera.alpha,
        beta: camera.beta,
        rotateSensitivity: 2,
        zoomSensitivity: 2,
      },
    },
    series,
  } as echarts.EChartsCoreOption;
}

function readCamera(chart: echarts.ECharts): Camera | null {
  // biome-ignore lint/suspicious/noExplicitAny: reading echarts-gl globe internals (getModel is private)
  const model = (chart as any).getModel?.();
  const globe = model?.getComponent?.("globe");
  const vc = globe?.option?.viewControl;
  if (vc && typeof vc.alpha === "number" && typeof vc.beta === "number") {
    return {
      alpha: vc.alpha,
      beta: vc.beta,
      distance: typeof vc.distance === "number" ? vc.distance : 200,
    };
  }
  return null;
}

/**
 * Dual synchronized 3D globes (spec): left shows the view, right shows the
 * antipode. Camera roam on either globe drives the other via antipodalView,
 * guarded against feedback with an `updating` ref. Layout flips stacked vs
 * side-by-side based on the container's aspect ratio.
 */
export default function PolesGlobes({
  poles,
  ageScale,
  boundaries,
  plateColor,
  hasBaseTexture,
  showEllipses,
  selected,
  onSelect,
}: GlobesProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const divARef = useRef<HTMLDivElement>(null);
  const divBRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<{ a: echarts.ECharts; b: echarts.ECharts } | null>(null);
  const cameraRef = useRef<Camera>({ alpha: 0, beta: 30, distance: 200 });
  const updatingRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const [stacked, setStacked] = useState(false);

  // Init both charts once; wire roam sync (raw zrender + globeroam) and clicks.
  useEffect(() => {
    if (!divARef.current || !divBRef.current) return;
    const a = echarts.init(divARef.current);
    const b = echarts.init(divBRef.current);
    chartsRef.current = { a, b };

    const applyCamera = (target: echarts.ECharts, cam: Camera) => {
      target.setOption({
        globe: {
          viewControl: { alpha: cam.alpha, beta: cam.beta, distance: cam.distance },
        },
      } as echarts.EChartsCoreOption);
    };

    // Read the source camera and mirror the antipode onto the target for a short
    // window (reconciles distance, which roam may report late).
    const syncFrom = (source: echarts.ECharts, target: echarts.ECharts) => {
      if (updatingRef.current) return;
      const cam = readCamera(source);
      if (!cam) return;
      cameraRef.current = source === chartsRef.current?.a ? cam : antipodalView(cam);
      updatingRef.current = true;
      try {
        applyCamera(target, antipodalView(cam));
      } finally {
        updatingRef.current = false;
      }
    };

    const startSync = (source: echarts.ECharts, target: echarts.ECharts) => {
      const end = Date.now() + 350;
      const tick = () => {
        syncFrom(source, target);
        if (Date.now() < end) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    const bindRoam = (source: echarts.ECharts, target: echarts.ECharts) => {
      const zr = source.getZr();
      zr.on("mousemove", () => startSync(source, target));
      zr.on("mousewheel", () => startSync(source, target));
      zr.on("mouseup", () => startSync(source, target));
      source.on("globeroam", () => startSync(source, target));
    };
    bindRoam(a, b);
    bindRoam(b, a);

    const bindClick = (chart: echarts.ECharts) => {
      chart.on("click", (params: unknown) => {
        const event = params as { seriesType?: string; value?: unknown[] };
        if (event.seriesType === "scatter3D" && Array.isArray(event.value)) {
          const poleId = event.value[4];
          const index = poles.findIndex((pole) => pole.poleId === poleId);
          if (index >= 0) onSelectRef.current(index);
        }
      });
    };
    bindClick(a);
    bindClick(b);

    const resize = () => {
      a.resize();
      b.resize();
    };
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      a.dispose();
      b.dispose();
      chartsRef.current = null;
    };
    // Re-bind click when the pole set changes so index lookup stays correct.
  }, [poles]);

  // Flip layout on aspect ratio (height ≥ width → stacked).
  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const observer = new ResizeObserver(() => {
      setStacked(el.clientHeight >= el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Re-render data/style; `stacked` is listed so the globes resize after a flip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stacked` drives the resize call, not read directly
  useEffect(() => {
    const charts = chartsRef.current;
    if (!charts) return;
    updatingRef.current = true;
    try {
      charts.a.setOption(
        buildOption(
          poles,
          ageScale,
          boundaries,
          plateColor,
          hasBaseTexture,
          showEllipses,
          selected,
          cameraRef.current,
        ),
        { replaceMerge: ["series"] },
      );
      charts.b.setOption(
        buildOption(
          poles,
          ageScale,
          boundaries,
          plateColor,
          hasBaseTexture,
          showEllipses,
          selected,
          antipodalView(cameraRef.current),
        ),
        { replaceMerge: ["series"] },
      );
      charts.a.resize();
      charts.b.resize();
    } finally {
      updatingRef.current = false;
    }
  }, [poles, ageScale, boundaries, plateColor, hasBaseTexture, showEllipses, selected, stacked]);

  // Center the selected pole on the left globe and its antipode on the right.
  useEffect(() => {
    const charts = chartsRef.current;
    if (!charts || selected === null) return;
    const pole = poles[selected];
    if (!pole) return;
    updatingRef.current = true;
    try {
      charts.a.setOption({
        globe: { viewControl: { targetCoord: [pole.lon, pole.lat] } },
      } as echarts.EChartsCoreOption);
      charts.b.setOption({
        globe: { viewControl: { targetCoord: antipodalCoord([pole.lon, pole.lat]) } },
      } as echarts.EChartsCoreOption);
    } finally {
      updatingRef.current = false;
    }
  }, [selected, poles]);

  return (
    <div
      ref={wrapRef}
      className={stacked ? "flex h-full w-full flex-col" : "flex h-full w-full flex-row"}
    >
      <div
        ref={divARef}
        className="min-h-0 min-w-0 flex-1"
        style={
          stacked ? { borderBottom: "1px solid #D4D4D5" } : { borderRight: "1px solid #D4D4D5" }
        }
        role="img"
        aria-label="Globe with virtual geomagnetic poles"
      />
      <div
        ref={divBRef}
        className="min-h-0 min-w-0 flex-1"
        role="img"
        aria-label="Antipodal globe view"
      />
    </div>
  );
}
