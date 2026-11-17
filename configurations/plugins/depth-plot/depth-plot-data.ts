// Depth plots: the measurements payload, tracks and the scale arithmetic
// (pure; the SVG lives in depth-plot-view.tsx).

import type { NodeConfig } from "@/lib/types";

export type Row = Record<string, unknown>;

/** A plotted track: a measurement column, or a ratio of two. */
export interface TrackDef {
  key: string;
  label: string;
  color: string;
  group: string;
  unit?: string | null;
  /** Starts on a log scale. */
  log: boolean;
  /** Shown before anything is picked. */
  default: boolean;
  ratio?: { numerator: string; denominator: string; log: boolean };
}

export interface SectionSpan {
  section: string;
  top: number;
  bottom: number;
}

export interface CoreData {
  name: string;
  rows: Row[];
  sections: SectionSpan[];
}

export interface Payload {
  cores: CoreData[];
  tracks: TrackDef[];
}

export interface Point {
  depth: number;
  value: number;
  /** The section it was measured in: lines break between sections. */
  section?: string;
}

const str = (value: unknown, fallback: string) =>
  typeof value === "string" && value ? value : fallback;

function trackOf(raw: unknown, group: string): TrackDef | null {
  if (!raw || typeof raw !== "object" || !("key" in raw)) return null;
  const record = raw as Record<string, unknown>;
  const key = String(record.key);
  const ratio =
    typeof record.numerator === "string" && typeof record.denominator === "string"
      ? { numerator: record.numerator, denominator: record.denominator, log: !!record.log }
      : undefined;
  return {
    key,
    label: str(record.label, key),
    color: str(record.color, "var(--node-color)"),
    group: str(record.group, group),
    unit: typeof record.unit === "string" ? record.unit : null,
    log: ratio ? false : !!record.log,
    default: record.default === undefined ? true : !!record.default,
    ratio,
  };
}

/** The node's default tracks (the YAML `series`), for the thumbnails. */
export function seriesDefsOf(config: NodeConfig): TrackDef[] {
  const defs = config.plugins["depth-plot"]?.series_defs;
  if (!Array.isArray(defs)) return [];
  return defs.map((def) => trackOf(def, "Tracks")).filter((t): t is TrackDef => t !== null);
}

export function depthOf(row: Row): number | undefined {
  for (const key of ["depth", "core_depth", "depth_m", "composite_depth"]) {
    const n = Number(row[key]);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coreNameOf(row: Row): string {
  for (const key of ["core", "core_name", "hole", "section"]) {
    if (typeof row[key] === "string" && row[key]) return row[key] as string;
  }
  return "Core";
}

function sectionsOf(raw: unknown): SectionSpan[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((span) => span as Record<string, unknown>)
    .filter((span) => Number.isFinite(Number(span?.top)) && Number.isFinite(Number(span?.bottom)))
    .map((span) => ({
      section: String(span.section ?? ""),
      top: Number(span.top),
      bottom: Number(span.bottom),
    }));
}

/** The plugin route's payload; older and other plausible shapes are read
 * defensively (rows only, tracks from the node's defaults). */
export function parsePayload(data: unknown, fallback: TrackDef[]): Payload {
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const tracks = Array.isArray(record?.tracks)
    ? record.tracks.map((t) => trackOf(t, "Tracks")).filter((t): t is TrackDef => t !== null)
    : fallback;
  const ratios = Array.isArray(record?.ratios)
    ? record.ratios.map((r) => trackOf(r, "Ratios")).filter((t): t is TrackDef => t !== null)
    : [];
  for (const ratio of ratios) ratio.group = "Ratios";
  const sections = (record?.sections ?? {}) as Record<string, unknown>;

  const coresField = record?.cores;
  let cores: CoreData[] = [];
  if (coresField && typeof coresField === "object" && !Array.isArray(coresField)) {
    // The plugin's route: `cores` maps each core name to its depth-sorted rows.
    cores = Object.entries(coresField as Record<string, unknown>).map(([name, rows]) => ({
      name: name || "Core",
      rows: Array.isArray(rows) ? (rows as Row[]) : [],
      sections: sectionsOf(sections[name]),
    }));
  } else if (Array.isArray(coresField)) {
    cores = coresField
      .filter((core) => core && typeof core === "object")
      .map((core) => {
        const entry = core as Record<string, unknown>;
        const rows = entry.measurements ?? entry.rows ?? entry.points;
        return {
          name: str(entry.name, str(entry.core, "Core")),
          rows: Array.isArray(rows) ? (rows as Row[]) : [],
          sections: [],
        };
      });
  } else {
    const rows = Array.isArray(data)
      ? (data as Row[])
      : Array.isArray(record?.measurements)
        ? (record.measurements as Row[])
        : [];
    const byCore = new Map<string, Row[]>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const name = coreNameOf(row);
      byCore.set(name, [...(byCore.get(name) ?? []), row]);
    }
    cores = [...byCore.entries()].map(([name, coreRows]) => ({
      name,
      rows: coreRows,
      sections: [],
    }));
  }
  return { cores, tracks: [...tracks, ...ratios] };
}

/** A row's value on a track (a ratio's quotient, or its ln), if any. */
export function trackValue(row: Row, track: TrackDef): number | undefined {
  if (track.ratio) {
    const num = Number(row[track.ratio.numerator]);
    const den = Number(row[track.ratio.denominator]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return undefined;
    if (track.ratio.log) return num > 0 ? Math.log(num / den) : undefined;
    return num / den;
  }
  const value = row[track.key];
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export const isBad = (row: Row) => row._bad === true;

/** A track's points in a depth window, depth-sorted; on a log scale only
 * positive values. */
export function trackPoints(
  rows: Row[],
  track: TrackDef,
  { bad, log, window }: { bad: boolean; log: boolean; window?: [number, number] },
): Point[] {
  const points: Point[] = [];
  for (const row of rows) {
    if (isBad(row) !== bad) continue;
    const depth = depthOf(row);
    if (depth === undefined) continue;
    if (window && (depth < window[0] || depth > window[1])) continue;
    const value = trackValue(row, track);
    if (value === undefined || (log && value <= 0)) continue;
    points.push({
      depth,
      value,
      section: typeof row.section === "string" ? row.section : undefined,
    });
  }
  return points.sort((a, b) => a.depth - b.depth);
}

function quantile(sorted: number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** The value axis' domain: the 2nd–98th percentile (min–max for a short
 * series) so a few spikes do not flatten the track; log10 units on a log
 * scale. */
export function valueDomain(values: number[], log: boolean): [number, number] {
  const scaled = (log ? values.filter((v) => v > 0).map(Math.log10) : values).sort((a, b) => a - b);
  if (scaled.length === 0) return [0, 1];
  const robust = scaled.length >= 50;
  let lo = robust ? quantile(scaled, 0.02) : scaled[0];
  let hi = robust ? quantile(scaled, 0.98) : scaled[scaled.length - 1];
  if (hi - lo <= 0) {
    const pad = Math.abs(lo) * 0.05 || (log ? 0.5 : 1);
    lo -= pad;
    hi += pad;
  }
  return [lo, hi];
}

/** About `count` round ticks within [min, max]. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return [min];
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return ticks;
}

/** Ticks for a log axis whose domain is in log10 units: the powers of ten
 * inside it, or round values when it spans less than a decade. */
export function logTicks(min: number, max: number): number[] {
  const powers: number[] = [];
  for (let e = Math.ceil(min); e <= Math.floor(max); e++) powers.push(e);
  if (powers.length >= 2) return powers;
  return niceTicks(10 ** min, 10 ** max, 3)
    .filter((v) => v > 0)
    .map(Math.log10);
}

export function formatValue(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(1).replace("e+", "e");
  if (abs >= 1e4) return `${+(value / 1000).toPrecision(3)}k`;
  return String(+value.toPrecision(3));
}

/** Runs of points within one section and without a depth gap wider than
 * `factor` times the median step, so the line breaks across missing
 * intervals and section ends. */
export function segments(points: Point[], factor = 5): Point[][] {
  if (points.length < 2) return points.length ? [points] : [];
  const steps = points
    .slice(1)
    .map((p, i) => p.depth - points[i].depth)
    .filter((step) => step > 0)
    .sort((a, b) => a - b);
  const median = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  const gap = median * factor;
  const runs: Point[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const gapped = gap > 0 && points[i].depth - prev.depth > gap;
    if (gapped || points[i].section !== prev.section) runs.push([]);
    runs[runs.length - 1].push(points[i]);
  }
  return runs;
}

/** Splits runs at points far outside the value domain (beyond it by more
 * than `slack` of its span, e.g. a failed scan's zeros): they break the
 * line instead of spiking across the track, and come back apart. */
export function splitOffScale(
  runs: Point[][],
  domain: [number, number],
  log: boolean,
  slack = 0.25,
): { runs: Point[][]; off: Point[] } {
  const far = (domain[1] - domain[0]) * slack;
  const inScale = (value: number) => {
    const scaled = log ? Math.log10(value) : value;
    return scaled >= domain[0] - far && scaled <= domain[1] + far;
  };
  const out: Point[][] = [];
  const off: Point[] = [];
  for (const run of runs) {
    let current: Point[] = [];
    for (const point of run) {
      if (inScale(point.value)) {
        current.push(point);
        continue;
      }
      off.push(point);
      if (current.length) out.push(current);
      current = [];
    }
    if (current.length) out.push(current);
  }
  return { runs: out, off };
}

/** At most two points (the extremes) per pixel row: thousands of points
 * draw as fast as hundreds, spikes kept. */
export function decimate(points: Point[], pixelOf: (depth: number) => number): Point[] {
  if (points.length < 1000) return points;
  const out: Point[] = [];
  let bucket = Number.NaN;
  let lo: Point | null = null;
  let hi: Point | null = null;
  const flush = () => {
    if (!lo || !hi) return;
    if (lo === hi) out.push(lo);
    else out.push(...(lo.depth <= hi.depth ? [lo, hi] : [hi, lo]));
  };
  for (const p of points) {
    const pixel = Math.round(pixelOf(p.depth));
    if (pixel !== bucket) {
      flush();
      bucket = pixel;
      lo = hi = p;
    } else {
      if (lo && p.value < lo.value) lo = p;
      if (hi && p.value > hi.value) hi = p;
    }
  }
  flush();
  return out;
}

/** The point nearest a depth (points depth-sorted). */
export function nearest(points: Point[], depth: number): Point | undefined {
  if (points.length === 0) return undefined;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].depth < depth) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].depth - depth) <= Math.abs(points[hi].depth - depth)
    ? points[lo]
    : points[hi];
}
