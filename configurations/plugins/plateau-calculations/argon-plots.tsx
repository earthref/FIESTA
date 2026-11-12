/**
 * SVG plots of contributed ⁴⁰Ar/³⁹Ar results. Nothing here fits anything:
 * every age, plateau, isochron line and point is the contributor's.
 */
import type { ReactNode } from "react";
import { useTheme } from "@/lib/theme";
import { ageOf, ageText, type Experiment, type IsochronPoint, type Specimen } from "./argon-data";

// The validated categorical order (dataviz reference palette), per theme.
const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const OTHER = "var(--er-plot-muted)";

const ACCENT = "var(--node-ink)";
const accentFill = (percent: number) =>
  `color-mix(in srgb, var(--node-ink) ${percent}%, var(--er-plot-surface))`;
const strongFill = (percent: number) =>
  `color-mix(in srgb, var(--er-plot-strong) ${percent}%, transparent)`;

export function useSeriesColors(count: number): string[] {
  const { theme } = useTheme();
  const palette = SERIES[theme];
  return Array.from({ length: count }, (_, i) => palette[i] ?? OTHER);
}

interface Pad {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const DETAILED_PAD: Pad = { left: 56, right: 14, top: 12, bottom: 40 };
const THUMB_PAD: Pad = { left: 2, right: 2, top: 2, bottom: 2 };

/** Round tick values covering [min, max], and the decimals they need. */
function niceTicks(min: number, max: number, count = 5): { ticks: number[]; decimals: number } {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) {
    ticks.push(Math.abs(tick) < step * 1e-9 ? 0 : tick);
  }
  return { ticks, decimals: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
}

interface Frame {
  x: (value: number) => number;
  y: (value: number) => number;
  pad: Pad;
  innerW: number;
  innerH: number;
}

function frame(
  width: number,
  height: number,
  [xMin, xMax]: [number, number],
  [yMin, yMax]: [number, number],
  detailed?: boolean,
): Frame {
  const pad = detailed ? DETAILED_PAD : THUMB_PAD;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  return {
    pad,
    innerW,
    innerH,
    x: (value) => pad.left + ((value - xMin) / (xMax - xMin || 1)) * innerW,
    y: (value) => pad.top + ((yMax - value) / (yMax - yMin || 1)) * innerH,
  };
}

/** Axis lines, ticks and names, in the theme's plot neutrals. */
function Axes({
  f,
  xDomain,
  yDomain,
  xLabel,
  yLabel,
  height,
}: {
  f: Frame;
  xDomain: [number, number];
  yDomain: [number, number];
  xLabel: string;
  yLabel: string;
  height: number;
}) {
  const xt = niceTicks(...xDomain);
  const yt = niceTicks(...yDomain);
  const bottom = f.pad.top + f.innerH;
  const midY = f.pad.top + f.innerH / 2;
  return (
    <g fontSize={10} fill="var(--er-plot-text)">
      {yt.ticks.map((tick) => (
        <line
          key={`gy-${tick}`}
          x1={f.pad.left}
          x2={f.pad.left + f.innerW}
          y1={f.y(tick)}
          y2={f.y(tick)}
          stroke="var(--er-plot-grid)"
        />
      ))}
      <line
        x1={f.pad.left}
        y1={bottom}
        x2={f.pad.left + f.innerW}
        y2={bottom}
        stroke="var(--er-plot-axis)"
      />
      <line
        x1={f.pad.left}
        y1={f.pad.top}
        x2={f.pad.left}
        y2={bottom}
        stroke="var(--er-plot-axis)"
      />
      {xt.ticks.map((tick) => (
        <text key={`x-${tick}`} x={f.x(tick)} y={bottom + 14} textAnchor="middle">
          {tick.toFixed(xt.decimals)}
        </text>
      ))}
      {yt.ticks.map((tick) => (
        <text key={`y-${tick}`} x={f.pad.left - 6} y={f.y(tick) + 3} textAnchor="end">
          {tick.toFixed(yt.decimals)}
        </text>
      ))}
      <text x={f.pad.left + f.innerW / 2} y={height - 6} textAnchor="middle" fontSize={11}>
        {xLabel}
      </text>
      <text x={12} y={midY} transform={`rotate(-90 12 ${midY})`} textAnchor="middle" fontSize={11}>
        {yLabel}
      </text>
    </g>
  );
}

function Svg({
  width,
  height,
  label,
  clipId,
  f,
  children,
}: {
  width: number;
  height: number;
  label: string;
  clipId: string;
  f: Frame;
  children: ReactNode;
}) {
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="bg-surface">
      <defs>
        <clipPath id={clipId}>
          <rect x={f.pad.left} y={f.pad.top} width={f.innerW} height={f.innerH} />
        </clipPath>
      </defs>
      {children}
    </svg>
  );
}

const clipKey = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_");

/** The y range of a spectrum: the step ages and the reference band, with
 * error bars allowed a quarter of that span beyond it (and clipped). */
function ageDomain(
  ages: number[],
  sigmas: (number | null)[],
  band?: [number, number],
): [number, number] {
  let lo = Math.min(...ages, ...(band ? [band[0]] : []));
  let hi = Math.max(...ages, ...(band ? [band[1]] : []));
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  const reach = span * 0.25;
  ages.forEach((age, i) => {
    const sigma = sigmas[i] ?? 0;
    lo = Math.min(lo, Math.max(age - sigma, lo - reach));
    hi = Math.max(hi, Math.min(age + sigma, hi + reach));
  });
  const pad = (hi - lo || 1) * 0.05;
  return [lo - pad, hi + pad];
}

const stepLabel = (experiment: Experiment, i: number) => {
  const step = experiment.steps[i];
  const where =
    step.temperature != null ? ` at ${step.temperature} ${step.temp_unit ?? ""}`.trimEnd() : "";
  return `${step.measurement ?? `Step ${i + 1}`}${where}: ${ageText(step.age, step.age_sigma, experiment.age_unit)}, ${step.ar39_start.toFixed(1)}–${step.ar39_end.toFixed(1)}% ³⁹Ar`;
};

const ar39Label = (experiment: Experiment) =>
  experiment.ar39_source ? "Cumulative ³⁹Ar released (%)" : "Steps (equal widths)";

/** An experiment's age spectrum, with its contributed plateau. */
export function AgeSpectrum({
  experiment,
  width,
  height,
  detailed,
}: {
  experiment: Experiment;
  width: number;
  height: number;
  detailed?: boolean;
}) {
  const steps = experiment.steps;
  if (steps.length === 0) return null;
  const plateau = ageOf(experiment, "plateau");
  const listed = new Set(plateau?.steps ?? []);
  const inPlateau = steps.map((step) => step.measurement != null && listed.has(step.measurement));
  const band: [number, number] | undefined =
    plateau?.age != null
      ? [plateau.age - (plateau.age_sigma ?? 0), plateau.age + (plateau.age_sigma ?? 0)]
      : undefined;
  const yDomain = ageDomain(
    steps.map((s) => s.age),
    steps.map((s) => s.age_sigma),
    band,
  );
  const f = frame(width, height, [0, 100], yDomain, detailed);
  // The plateau spans its listed steps, or the whole release when none resolve.
  const spanned = steps.filter((_, i) => inPlateau[i]);
  const bandX = spanned.length
    ? [Math.min(...spanned.map((s) => s.ar39_start)), Math.max(...spanned.map((s) => s.ar39_end))]
    : [0, 100];
  const clipId = `argon-spectrum-${clipKey(experiment.experiment)}-${detailed ? "d" : "t"}`;
  return (
    <Svg
      width={width}
      height={height}
      label={`Age spectrum of ${experiment.experiment}`}
      clipId={clipId}
      f={f}
    >
      {detailed && (
        <Axes
          f={f}
          xDomain={[0, 100]}
          yDomain={yDomain}
          xLabel={ar39Label(experiment)}
          yLabel={`Age (${experiment.age_unit ?? "Ma"})`}
          height={height}
        />
      )}
      <g clipPath={`url(#${clipId})`}>
        {band && (
          <rect
            x={f.x(bandX[0])}
            width={Math.max(0.5, f.x(bandX[1]) - f.x(bandX[0]))}
            y={f.y(band[1])}
            height={Math.max(0.5, f.y(band[0]) - f.y(band[1]))}
            fill={strongFill(10)}
          />
        )}
        {steps.map((step, i) => {
          const sigma = step.age_sigma ?? 0;
          const x0 = f.x(step.ar39_start);
          return (
            <rect
              key={`${step.measurement}-${i}`}
              x={x0}
              width={Math.max(0.5, f.x(step.ar39_end) - x0)}
              y={f.y(step.age + sigma)}
              height={Math.max(1, f.y(step.age - sigma) - f.y(step.age + sigma))}
              fill={inPlateau[i] ? accentFill(22) : "var(--er-plot-faded)"}
              stroke={inPlateau[i] ? ACCENT : "var(--er-plot-muted)"}
              strokeWidth={detailed ? 1 : 0.5}
            >
              {detailed && <title>{stepLabel(experiment, i)}</title>}
            </rect>
          );
        })}
        {plateau?.age != null && (
          <line
            x1={f.x(bandX[0])}
            x2={f.x(bandX[1])}
            y1={f.y(plateau.age)}
            y2={f.y(plateau.age)}
            stroke="var(--er-plot-strong)"
            strokeWidth={detailed ? 2 : 1}
          />
        )}
      </g>
    </Svg>
  );
}

/** One error ellipse (1σ, with the step's correlation) in pixel space. */
function ellipse(f: Frame, point: IsochronPoint, xSpan: number, ySpan: number) {
  const [x, sx, y, sy, rho] = point;
  const kx = f.innerW / xSpan;
  const ky = f.innerH / ySpan;
  const a = (kx * (sx ?? 0)) ** 2;
  const d = (ky * (sy ?? 0)) ** 2;
  // y grows downward on screen, so the covariance flips sign.
  const b = -(rho ?? 0) * kx * (sx ?? 0) * ky * (sy ?? 0);
  const mean = (a + d) / 2;
  const root = Math.sqrt(((a - d) / 2) ** 2 + b ** 2);
  const angle = (0.5 * Math.atan2(2 * b, a - d) * 180) / Math.PI;
  return {
    cx: f.x(x),
    cy: f.y(y),
    rx: Math.max(1.75, Math.sqrt(mean + root)),
    ry: Math.max(1.75, Math.sqrt(Math.max(0, mean - root))),
    angle,
  };
}

const ISOCHRONS = {
  inverse: {
    x: "³⁹Ar/⁴⁰Ar",
    y: "³⁶Ar/⁴⁰Ar",
    kind: "inverse_isochron" as const,
    name: "Inverse isochron",
  },
  normal: {
    x: "³⁹Ar/³⁶Ar",
    y: "⁴⁰Ar/³⁶Ar",
    kind: "normal_isochron" as const,
    name: "Normal isochron",
  },
};

/** A normal or inverse isochron: the steps' contributed ratios and the line
 * through the contributed intercepts. */
export function Isochron({
  experiment,
  kind,
  width,
  height,
}: {
  experiment: Experiment;
  kind: "normal" | "inverse";
  width: number;
  height: number;
}) {
  const meta = ISOCHRONS[kind];
  const age = ageOf(experiment, meta.kind);
  const points = experiment.steps.flatMap((step, i) => {
    const point = step[kind];
    return point ? [{ point, i, name: step.measurement }] : [];
  });
  const R = age?.ar40_ar39;
  const T = age?.ar40_ar36;
  const hasLine = R != null && T != null && R > 0 && T > 0;
  if (points.length === 0 && !hasLine) return null;
  const listed = new Set(age?.steps ?? []);
  const included = (name: string | null) => listed.size === 0 || (name != null && listed.has(name));

  const xs = points.map(({ point }) => point[0] + (point[1] ?? 0));
  const ys = points.map(({ point }) => point[2] + (point[3] ?? 0));
  let xMax = Math.max(0, ...xs);
  let yMax = Math.max(0, ...ys);
  if (hasLine) {
    if (kind === "inverse") {
      xMax = Math.max(xMax, 1 / R);
      yMax = Math.max(yMax, 1 / T);
    } else {
      xMax = xMax || 1;
      yMax = Math.max(yMax, T + R * xMax);
    }
  }
  xMax = (xMax || 1) * 1.06;
  yMax = (yMax || 1) * 1.06;
  const f = frame(width, height, [0, xMax], [0, yMax], true);
  const line = hasLine
    ? kind === "inverse"
      ? { x1: 0, y1: 1 / T, x2: 1 / R, y2: 0 }
      : { x1: 0, y1: T, x2: xMax, y2: T + R * xMax }
    : null;
  const clipId = `argon-${kind}-${clipKey(experiment.experiment)}`;
  return (
    <Svg
      width={width}
      height={height}
      label={`${meta.name} of ${experiment.experiment}`}
      clipId={clipId}
      f={f}
    >
      <Axes
        f={f}
        xDomain={[0, xMax]}
        yDomain={[0, yMax]}
        xLabel={meta.x}
        yLabel={meta.y}
        height={height}
      />
      <g clipPath={`url(#${clipId})`}>
        {points.map(({ point, i, name }) => {
          const e = ellipse(f, point, xMax, yMax);
          const used = included(name);
          return (
            <ellipse
              key={`${name}-${i}`}
              cx={e.cx}
              cy={e.cy}
              rx={e.rx}
              ry={e.ry}
              transform={`rotate(${e.angle} ${e.cx} ${e.cy})`}
              fill={used ? accentFill(30) : "none"}
              stroke={used ? ACCENT : "var(--er-plot-muted)"}
              strokeWidth={1}
            >
              <title>
                {`${name ?? `Step ${i + 1}`}${used ? "" : " (not used)"}: ${meta.x} ${point[0].toPrecision(4)}, ${meta.y} ${point[2].toPrecision(4)}`}
              </title>
            </ellipse>
          );
        })}
        {line && (
          <line
            x1={f.x(line.x1)}
            y1={f.y(line.y1)}
            x2={f.x(line.x2)}
            y2={f.y(line.y2)}
            stroke="var(--er-plot-strong)"
            strokeWidth={1.5}
          />
        )}
      </g>
    </Svg>
  );
}

/** A specimen's experiments' spectra (stepped lines, one hue each) under its
 * preferred age. */
export function SpecimenSpectra({
  specimen,
  experiments,
  width,
  height,
  detailed,
}: {
  specimen: Specimen;
  experiments: Experiment[];
  width: number;
  height: number;
  detailed?: boolean;
}) {
  const colors = useSeriesColors(experiments.length);
  const drawn = experiments.filter((e) => e.steps.length > 0);
  if (drawn.length === 0) return null;
  const band: [number, number] | undefined =
    specimen.age != null
      ? [specimen.age - (specimen.age_sigma ?? 0), specimen.age + (specimen.age_sigma ?? 0)]
      : undefined;
  const all = drawn.flatMap((e) => e.steps);
  const yDomain = ageDomain(
    all.map((s) => s.age),
    all.map((s) => s.age_sigma),
    band,
  );
  const f = frame(width, height, [0, 100], yDomain, detailed);
  const clipId = `argon-specimen-${clipKey(specimen.specimen)}-${detailed ? "d" : "t"}`;
  const unit = specimen.age_unit ?? drawn[0].age_unit ?? "Ma";
  return (
    <Svg
      width={width}
      height={height}
      label={`Age spectra of specimen ${specimen.specimen}`}
      clipId={clipId}
      f={f}
    >
      {detailed && (
        <Axes
          f={f}
          xDomain={[0, 100]}
          yDomain={yDomain}
          xLabel="Cumulative ³⁹Ar released (%)"
          yLabel={`Age (${unit})`}
          height={height}
        />
      )}
      <g clipPath={`url(#${clipId})`}>
        {band && (
          <rect
            x={f.pad.left}
            width={f.innerW}
            y={f.y(band[1])}
            height={Math.max(0.5, f.y(band[0]) - f.y(band[1]))}
            fill={strongFill(10)}
          />
        )}
        {experiments.map((experiment, n) => {
          if (experiment.steps.length === 0) return null;
          const color = colors[n];
          const path = experiment.steps
            .map(
              (s, i) =>
                `${i === 0 ? "M" : "L"}${f.x(s.ar39_start)},${f.y(s.age)}L${f.x(s.ar39_end)},${f.y(s.age)}`,
            )
            .join("");
          return (
            <g key={experiment.experiment}>
              {experiment.steps.map((s, i) => {
                const sigma = s.age_sigma ?? 0;
                return (
                  <rect
                    key={`${s.measurement}-${i}`}
                    x={f.x(s.ar39_start)}
                    width={Math.max(0.5, f.x(s.ar39_end) - f.x(s.ar39_start))}
                    y={f.y(s.age + sigma)}
                    height={Math.max(0.5, f.y(s.age - sigma) - f.y(s.age + sigma))}
                    fill={color}
                    fillOpacity={0.12}
                  >
                    {detailed && (
                      <title>{`${experiment.experiment} · ${stepLabel(experiment, i)}`}</title>
                    )}
                  </rect>
                );
              })}
              <path d={path} fill="none" stroke={color} strokeWidth={detailed ? 2 : 1} />
            </g>
          );
        })}
        {specimen.age != null && (
          <line
            x1={f.pad.left}
            x2={f.pad.left + f.innerW}
            y1={f.y(specimen.age)}
            y2={f.y(specimen.age)}
            stroke="var(--er-plot-strong)"
            strokeWidth={detailed ? 1.5 : 1}
            strokeDasharray="5 3"
          />
        )}
      </g>
    </Svg>
  );
}
