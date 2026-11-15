// The Global field tab: one model's 5° grid on a Mollweide map, a year
// slider over the calculation's years with play/pause, colour limits,
// selected sites, a probe, PNG and animated-GIF export (GEOMAGIA's global
// tab and movie export).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { usePlotColors } from "@/lib/plot-colors";
import type { Catalog, CurveResult } from "./field-models-data";
import { save, timestamp } from "./field-models-data";
import { GifEncoder } from "./gif";
import {
  CANVAS,
  canvasToLatLon,
  defaultLimits,
  drawMap,
  FIELDS,
  type FieldKey,
  fieldInfo,
  type GlobalFrame,
  isAcceleration,
  isSigned,
  LIGHT_MAP,
  type MapColors,
  PALETTES,
  sample,
} from "./global-field";

const PLUGIN = "/plugins/field-models";
const SPEEDS = [1000, 500, 250, 150, 100, 50];
const button =
  "rounded-sm border border-gray-300 bg-surface px-2 py-1 text-[13px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const input =
  "w-24 rounded-sm border border-gray-300 bg-surface px-1.5 py-1 text-[13px] text-gray-900";

const frames = new Map<string, GlobalFrame>();

async function fetchFrame(model: string, year: number, signal?: AbortSignal): Promise<GlobalFrame> {
  const key = `${model}:${year}`;
  const cached = frames.get(key);
  if (cached) return cached;
  const frame = await api<GlobalFrame>(`${PLUGIN}/global`, { params: { model, year }, signal });
  frames.set(key, frame);
  if (frames.size > 48) frames.delete(frames.keys().next().value as string);
  return frame;
}

const formatYear = (v: number) =>
  Number(v.toFixed(4)).toLocaleString(undefined, { maximumFractionDigits: 4 });

export default function GlobalMaps({
  result,
  catalog,
  inclinationMode,
  filePrefix,
  onYear,
}: {
  result: CurveResult;
  catalog: Catalog;
  inclinationMode: "incl" | "delta_incl";
  filePrefix: string;
  onYear: (year: number | null) => void;
}) {
  const models = useMemo(() => [...new Set(result.series.map((s) => s.model))], [result]);
  const [model, setModel] = useState(models[0]);
  const [field, setField] = useState<FieldKey>("intensity");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(250);
  const [showSites, setShowSites] = useState(true);
  const [limits, setLimits] = useState<Record<string, [number, number]>>({});
  const [frame, setFrame] = useState<GlobalFrame | null>(null);
  const [status, setStatus] = useState("");
  const [probe, setProbe] = useState("Move over the map to inspect coordinates and field values.");
  const [movie, setMovie] = useState<AbortController | null>(null);
  const [movieStatus, setMovieStatus] = useState("");
  const [lowText, setLowText] = useState("");
  const [highText, setHighText] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const pc = usePlotColors();
  const colors: MapColors = useMemo(
    () => ({
      background: pc.surface,
      title: pc.text,
      text: pc.text,
      outline: pc.axis,
      coast: pc.strong,
    }),
    [pc],
  );

  useEffect(() => {
    if (!models.includes(model)) setModel(models[0]);
  }, [models, model]);
  useEffect(() => {
    if (field === "incl" || field === "delta_incl") setField(inclinationMode);
  }, [inclinationMode, field]);

  // The calculation's years, clipped to the model's interval.
  const years = useMemo(() => {
    const m = catalog.models[model];
    if (!m) return [];
    const first = Math.max(result.start_year, m.start);
    const last = Math.min(result.end_year, m.end);
    const count = Math.ceil((last - first) / result.step) + 1;
    return Array.from({ length: count }, (_, i) => Math.min(first + i * result.step, last));
  }, [catalog, model, result]);
  const year = years[Math.min(index, years.length - 1)];
  const group = fieldInfo(field).group;
  const sites = useMemo(
    () => (showSites ? (result.site_groups?.[group] ?? []) : []),
    [showSites, result.site_groups, group],
  );
  const limitKey = `${model}:${field}`;
  const currentLimits = (f: GlobalFrame) => limits[limitKey] ?? defaultLimits(f, field);

  // Draw the current year; keep one request in flight.
  const paint = useCallback(
    (f: GlobalFrame, fast = false) => {
      if (!canvas.current) return;
      const bounds = limits[`${f.model}:${field}`] ?? defaultLimits(f, field);
      drawMap(canvas.current, f, { key: field, limits: bounds, sites, colors, fast });
      setLowText(String(bounds[0]));
      setHighText(String(bounds[1]));
      setStatus(`${f.model} · ${formatYear(f.year)} · ${sites.length} selected site locations`);
      onYear(f.year);
    },
    [field, limits, sites, colors, onYear],
  );

  useEffect(() => {
    if (year === undefined || !model) return;
    const controller = new AbortController();
    setStatus("Calculating global field…");
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetchFrame(model, year, controller.signal)
      .then((f) => {
        if (controller.signal.aborted) return;
        setFrame(f);
        paint(f, playing && speed < 250);
        if (playing) {
          timer = setTimeout(
            () => setIndex((i) => (i + 1) % years.length),
            Math.max(0, speed - (performance.now() - started)),
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setPlaying(false);
          setStatus(e instanceof Error ? e.message : "The global field could not be calculated.");
        }
      });
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [model, year, playing, speed, years.length, paint]);

  useEffect(() => () => onYear(null), [onYear]);

  const applyLimits = () => {
    if (!frame) return;
    setPlaying(false);
    const low = Number(lowText);
    const high = Number(highText);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
      setStatus("Colour maximum must be greater than minimum, with a finite range.");
      return;
    }
    if (isSigned(field)) {
      const bound = Math.max(Math.abs(low), Math.abs(high));
      if (bound === 0) {
        setStatus("The signed colour limit must be nonzero.");
        return;
      }
      setLimits((l) => ({ ...l, [limitKey]: [-bound, bound] }));
    } else setLimits((l) => ({ ...l, [limitKey]: [low, high] }));
  };

  const savePng = () => {
    if (!canvas.current || !frame) return;
    setPlaying(false);
    canvas.current.toBlob((blob) => {
      if (blob)
        save(blob, `${filePrefix}_${frame.model}_${field}_${frame.year}_${timestamp()}.png`);
    }, "image/png");
  };

  const exportMovie = async () => {
    if (!frame || movie) return;
    setPlaying(false);
    const controller = new AbortController();
    setMovie(controller);
    const stamp = timestamp();
    try {
      const bounds = currentLimits(frame);
      const offscreen = document.createElement("canvas");
      offscreen.width = CANVAS.width;
      offscreen.height = CANVAS.height;
      const context = offscreen.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("This browser cannot draw the movie.");
      const encoder = new GifEncoder(CANVAS.width, CANVAS.height, PALETTES[field], speed);
      for (const [i, y] of years.entries()) {
        controller.signal.throwIfAborted();
        setMovieStatus(`Preparing frame ${i + 1} of ${years.length} · Year ${y}`);
        const f = await fetchFrame(model, y, controller.signal);
        drawMap(offscreen, f, { key: field, limits: bounds, sites, colors: LIGHT_MAP });
        encoder.add(context);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const name = `${filePrefix}_${model}_${field}_${stamp}.gif`;
      save(encoder.finish(), name);
      setMovieStatus(`Downloaded ${name} (${years.length} frames).`);
    } catch (e) {
      setMovieStatus(
        controller.signal.aborted
          ? "Movie export cancelled."
          : e instanceof Error
            ? e.message
            : "The movie could not be exported.",
      );
    } finally {
      setMovie(null);
    }
  };

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!frame) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * CANVAS.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * CANVAS.height;
    const c = canvasToLatLon(x, y);
    if (!c) {
      setProbe("Move over the map to inspect coordinates and field values.");
      return;
    }
    const value = sample(frame, field, c[0], c[1]);
    const text = isAcceleration(field)
      ? value.toPrecision(4)
      : value.toFixed(field === "radial" ? 3 : 2);
    setProbe(`${c[0].toFixed(2)}°N, ${c[1].toFixed(2)}°E · ${text} ${fieldInfo(field).unit}`);
  };

  const fields = FIELDS.filter(
    (f) => f.key !== (inclinationMode === "incl" ? "delta_incl" : "incl"),
  );

  return (
    <section className="min-w-0 rounded-sm border border-gray-300 bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-3 py-2">
        <h4 className="text-[14px] font-bold text-gray-900">Global field</h4>
        <label className="flex items-center gap-1">
          Model
          <select
            className="rounded-sm border border-gray-300 bg-surface px-1.5 py-1"
            value={model}
            onChange={(e) => {
              setPlaying(false);
              const previous = year;
              const next = e.target.value;
              setModel(next);
              const m = catalog.models[next];
              const first = Math.max(result.start_year, m.start);
              setIndex(Math.max(0, Math.round((previous - first) / result.step)));
            }}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Field
          <select
            className="rounded-sm border border-gray-300 bg-surface px-1.5 py-1"
            value={field}
            onChange={(e) => setField(e.target.value as FieldKey)}
          >
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showSites}
            onChange={(e) => setShowSites(e.target.checked)}
          />
          Show selected sites
        </label>
      </header>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          className={button}
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={playing}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className={button}
          onClick={() => {
            setPlaying(false);
            setIndex((i) => (i - 1 + years.length) % years.length);
          }}
        >
          ◀
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, years.length - 1)}
          value={Math.min(index, years.length - 1)}
          aria-label="Year"
          className="w-64 grow"
          onChange={(e) => {
            setPlaying(false);
            setIndex(Number(e.target.value));
          }}
        />
        <button
          type="button"
          className={button}
          onClick={() => {
            setPlaying(false);
            setIndex((i) => (i + 1) % years.length);
          }}
        >
          ▶
        </button>
        <span className="w-20 font-bold text-gray-800">
          {year !== undefined ? formatYear(year) : "—"}
        </span>
        <label className="flex items-center gap-1">
          Frame
          <select
            className="rounded-sm border border-gray-300 bg-surface px-1.5 py-1"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s} ms
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="px-3">
        <canvas
          ref={canvas}
          width={CANVAS.width}
          height={CANVAS.height}
          className="h-auto w-full max-w-[1200px]"
          onPointerMove={onMove}
          aria-label={`${fieldInfo(field).name} for ${model}, year ${year}, Mollweide projection`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-gray-600">{probe}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 px-3 py-2">
        <label className="flex items-center gap-1">
          Colour min
          <input
            className={input}
            type="number"
            step="any"
            value={lowText}
            onChange={(e) => setLowText(e.target.value)}
            onBlur={applyLimits}
          />
        </label>
        <label className="flex items-center gap-1">
          max
          <input
            className={input}
            type="number"
            step="any"
            value={highText}
            onChange={(e) => setHighText(e.target.value)}
            onBlur={applyLimits}
          />
        </label>
        <button
          type="button"
          className={button}
          onClick={() =>
            setLimits((l) => {
              const { [limitKey]: _, ...rest } = l;
              return rest;
            })
          }
        >
          Reset colours
        </button>
        <button type="button" className={button} onClick={savePng} disabled={!frame}>
          PNG
        </button>
        <button
          type="button"
          className={button}
          onClick={() => void exportMovie()}
          disabled={!frame || Boolean(movie)}
        >
          GIF movie
        </button>
        {movie && (
          <button type="button" className={button} onClick={() => movie.abort()}>
            Cancel
          </button>
        )}
        <span className="text-gray-500">{movieStatus || status}</span>
      </div>
    </section>
  );
}
