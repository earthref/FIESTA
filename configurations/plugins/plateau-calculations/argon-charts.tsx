/**
 * The age plots beyond the spectrum and isochrons: the companion spectra
 * under it (K/Ca, ⁴⁰Ar*, ³⁸Ar(Cl)/³⁹Ar(K)), the release curve, ranked ages,
 * ideograms and x–y plots (age against a sample's section, J against
 * irradiation position). They draw contributed values; the only arithmetic
 * is presentation (unit conversion, a ratio, the ideogram's summed curves).
 */
import { ageOf, type Experiment, type Step } from "./argon-data";
import {
  ACCENT,
  Axes,
  accentFill,
  ar39Label,
  clipKey,
  DETAILED_PAD,
  frame,
  niceTicks,
  type Pad,
  Svg,
  strongFill,
} from "./argon-plots";

/** A short panel's padding: room for x ticks, not an x name. */
const COMPANION_PAD: Pad = { ...DETAILED_PAD, top: 8, bottom: 20 };

const padded = (lo: number, hi: number, share = 0.05): [number, number] => {
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  return [lo - span * share, hi + span * share];
};

// --- companion spectra -------------------------------------------------------------------

export interface StepSeries {
  key: string;
  /** The y axis's name. */
  label: string;
  value: (step: Step) => number | null;
  sigma?: (step: Step) => number | null;
  /** A log axis when the values span 20× or more. */
  log?: boolean;
  /** A fixed axis floor and ceiling the values extend. */
  span?: [number, number];
}

export const COMPANIONS: StepSeries[] = [
  { key: "k_ca", label: "K/Ca", value: (s) => s.k_ca, sigma: (s) => s.k_ca_sigma, log: true },
  { key: "ar40_rad", label: "⁴⁰Ar* (%)", value: (s) => s.ar40_rad, span: [0, 100] },
  { key: "cl_k", label: "³⁸Ar(Cl)/³⁹Ar(K)", value: (s) => s.cl_k, log: true },
];

export const hasSeries = (experiment: Experiment, series: StepSeries) =>
  experiment.steps.some((step) => series.value(step) != null);

/** A per-step value on the experiment's ³⁹Ar axis, drawn under its age
 * spectrum: a level per step (with its ±σ band), the plateau's steps in the
 * accent colour. */
export function StepValueSpectrum({
  experiment,
  series,
  width,
  height,
  detailed,
}: {
  experiment: Experiment;
  series: StepSeries;
  width: number;
  height: number;
  detailed?: boolean;
}) {
  const plateau = ageOf(experiment, "plateau");
  const listed = new Set(plateau?.steps ?? []);
  const values = experiment.steps.flatMap((step) => {
    const value = series.value(step);
    return value == null ? [] : [{ step, value, sigma: series.sigma?.(step) ?? null }];
  });
  const positives = values.filter((v) => v.value > 0).map((v) => v.value);
  const log =
    series.log === true &&
    positives.length === values.length &&
    positives.length > 0 &&
    Math.max(...positives) / Math.min(...positives) >= 20;
  if (values.length === 0) return null;
  const t = (v: number) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
  // A log axis cannot reach 0, so a band stops at a tenth of its value.
  const floor = (v: number, s: number) => (log ? Math.max(v - s, v / 10) : v - s);
  const lows = values.map((v) => t(v.sigma ? floor(v.value, v.sigma) : v.value));
  const highs = values.map((v) => t(v.sigma ? v.value + v.sigma : v.value));
  let [lo, hi] = padded(Math.min(...lows), Math.max(...highs));
  if (series.span && !log) {
    lo = Math.min(lo, series.span[0]);
    hi = Math.max(hi, series.span[1]);
  }
  const f = frame(
    width,
    height,
    [0, 100],
    [lo, hi],
    detailed,
    detailed ? COMPANION_PAD : undefined,
  );
  const clipId = `argon-${series.key}-${clipKey(experiment.experiment)}-${detailed ? "d" : "t"}`;
  return (
    <Svg
      width={width}
      height={height}
      label={`${series.label} spectrum of ${experiment.experiment}`}
      clipId={clipId}
      f={f}
    >
      {detailed && (
        <Axes
          f={f}
          xDomain={[0, 100]}
          yDomain={[lo, hi]}
          xLabel=""
          yLabel={series.label}
          height={height}
          yLog={log}
        />
      )}
      <g clipPath={`url(#${clipId})`}>
        {values.map(({ step, value, sigma }, i) => {
          const used = step.measurement != null && listed.has(step.measurement);
          const x0 = f.x(step.ar39_start);
          const w = Math.max(0.5, f.x(step.ar39_end) - x0);
          const color = used ? ACCENT : "var(--er-plot-muted)";
          return (
            <g key={`${step.measurement}-${i}`}>
              {sigma != null && sigma > 0 && (
                <rect
                  x={x0}
                  width={w}
                  y={f.y(t(value + sigma))}
                  height={Math.max(0.5, f.y(t(floor(value, sigma))) - f.y(t(value + sigma)))}
                  fill={used ? accentFill(22) : "var(--er-plot-faded)"}
                />
              )}
              <line
                x1={x0}
                x2={x0 + w}
                y1={f.y(t(value))}
                y2={f.y(t(value))}
                stroke={color}
                strokeWidth={detailed ? 2 : 1}
              >
                {detailed && (
                  <title>{`${step.measurement ?? `Step ${i + 1}`}: ${series.label} ${value.toPrecision(4)}${sigma ? ` ± ${sigma.toPrecision(2)}` : ""}`}</title>
                )}
              </line>
            </g>
          );
        })}
      </g>
    </Svg>
  );
}

// --- release curve -----------------------------------------------------------------------

export const hasReleaseCurve = (experiment: Experiment) =>
  experiment.ar39_source != null &&
  experiment.steps.filter((step) => step.temperature != null).length >= 2;

/** The ³⁹Ar released by each heating step's end, against its temperature. */
export function ReleaseCurve({
  experiment,
  width,
  height,
}: {
  experiment: Experiment;
  width: number;
  height: number;
}) {
  const points = experiment.steps.flatMap((step) =>
    step.temperature == null ? [] : [{ step, t: step.temperature }],
  );
  if (points.length < 2) return null;
  const xDomain = padded(Math.min(...points.map((p) => p.t)), Math.max(...points.map((p) => p.t)));
  const f = frame(width, height, xDomain, [0, 100], true);
  const unit = points.find((p) => p.step.temp_unit)?.step.temp_unit ?? "";
  const clipId = `argon-release-${clipKey(experiment.experiment)}`;
  const path = points.map((p, i) => `${i ? "L" : "M"}${f.x(p.t)},${f.y(p.step.ar39_end)}`).join("");
  return (
    <Svg
      width={width}
      height={height}
      label={`³⁹Ar release of ${experiment.experiment}`}
      clipId={clipId}
      f={f}
    >
      <Axes
        f={f}
        xDomain={xDomain}
        yDomain={[0, 100]}
        xLabel={`Temperature${unit ? ` (${unit})` : ""}`}
        yLabel={ar39Label(experiment)}
        height={height}
      />
      <g clipPath={`url(#${clipId})`}>
        <path d={path} fill="none" stroke={ACCENT} strokeWidth={1.5} />
        {points.map((p, i) => (
          <circle
            key={`${p.step.measurement}-${i}`}
            cx={f.x(p.t)}
            cy={f.y(p.step.ar39_end)}
            r={3}
            fill={accentFill(40)}
            stroke={ACCENT}
          >
            <title>{`${p.step.measurement ?? `Step ${i + 1}`}: ${p.t} ${unit}, ${p.step.ar39_end.toFixed(1)}% ³⁹Ar released`}</title>
          </circle>
        ))}
      </g>
    </Svg>
  );
}

// --- ages compared ------------------------------------------------------------------------

export interface DatedItem {
  name: string;
  age: number;
  sigma: number | null;
}

export interface Reference {
  age: number;
  sigma: number | null;
}

/** The reference age's band and dashed line, horizontal or vertical. */
function ReferenceMark({
  reference,
  f,
  vertical,
  detailed,
}: {
  reference: Reference;
  f: ReturnType<typeof frame>;
  vertical?: boolean;
  detailed?: boolean;
}) {
  const lo = reference.age - (reference.sigma ?? 0);
  const hi = reference.age + (reference.sigma ?? 0);
  const right = f.pad.left + f.innerW;
  const bottom = f.pad.top + f.innerH;
  return vertical ? (
    <g>
      <rect
        x={f.x(lo)}
        width={Math.max(0.5, f.x(hi) - f.x(lo))}
        y={f.pad.top}
        height={f.innerH}
        fill={strongFill(10)}
      />
      <line
        x1={f.x(reference.age)}
        x2={f.x(reference.age)}
        y1={f.pad.top}
        y2={bottom}
        stroke="var(--er-plot-strong)"
        strokeWidth={detailed ? 1.5 : 1}
        strokeDasharray="5 3"
      />
    </g>
  ) : (
    <g>
      <rect
        x={f.pad.left}
        width={f.innerW}
        y={f.y(hi)}
        height={Math.max(0.5, f.y(lo) - f.y(hi))}
        fill={strongFill(10)}
      />
      <line
        x1={f.pad.left}
        x2={right}
        y1={f.y(reference.age)}
        y2={f.y(reference.age)}
        stroke="var(--er-plot-strong)"
        strokeWidth={detailed ? 1.5 : 1}
        strokeDasharray="5 3"
      />
    </g>
  );
}

/** Ages from youngest to oldest, each with its ±σ bar, under a reference age
 * (a specimen's preferred age). */
export function RankedAges({
  items,
  unit,
  reference,
  width,
  height,
  detailed,
  label,
}: {
  items: DatedItem[];
  unit: string;
  reference?: Reference;
  width: number;
  height: number;
  detailed?: boolean;
  label: string;
}) {
  if (items.length === 0) return null;
  const ranked = [...items].sort((a, b) => a.age - b.age);
  const lows = ranked.map((d) => d.age - (d.sigma ?? 0));
  const highs = ranked.map((d) => d.age + (d.sigma ?? 0));
  if (reference) {
    lows.push(reference.age - (reference.sigma ?? 0));
    highs.push(reference.age + (reference.sigma ?? 0));
  }
  const yDomain = padded(Math.min(...lows), Math.max(...highs), 0.08);
  const xDomain: [number, number] = [0.5, ranked.length + 0.5];
  const f = frame(width, height, xDomain, yDomain, detailed);
  const clipId = `argon-ranked-${clipKey(label)}-${detailed ? "d" : "t"}`;
  const step = Math.max(1, Math.ceil(ranked.length / 12));
  const xTicks = {
    ticks: ranked.map((_, i) => i + 1).filter((n) => (n - 1) % step === 0),
    label: (tick: number) => String(tick),
  };
  const cap = Math.min(5, f.innerW / ranked.length / 3);
  return (
    <Svg width={width} height={height} label={label} clipId={clipId} f={f}>
      {detailed && (
        <Axes
          f={f}
          xDomain={xDomain}
          yDomain={yDomain}
          xLabel="Rank (youngest first)"
          yLabel={`Age (${unit})`}
          height={height}
          xTicks={xTicks}
        />
      )}
      <g clipPath={`url(#${clipId})`}>
        {reference && <ReferenceMark reference={reference} f={f} detailed={detailed} />}
        {ranked.map((d, i) => {
          const x = f.x(i + 1);
          const s = d.sigma ?? 0;
          return (
            <g key={`${d.name}-${i}`} stroke={ACCENT} strokeWidth={detailed ? 1.5 : 1}>
              <title>{`${d.name}: ${d.age.toFixed(3)}${d.sigma != null ? ` ± ${d.sigma.toFixed(3)}` : ""} ${unit}`}</title>
              {s > 0 && (
                <>
                  <line x1={x} x2={x} y1={f.y(d.age + s)} y2={f.y(d.age - s)} />
                  <line x1={x - cap} x2={x + cap} y1={f.y(d.age + s)} y2={f.y(d.age + s)} />
                  <line x1={x - cap} x2={x + cap} y1={f.y(d.age - s)} y2={f.y(d.age - s)} />
                </>
              )}
              <circle cx={x} cy={f.y(d.age)} r={detailed ? 3 : 1.5} fill={accentFill(50)} />
            </g>
          );
        })}
      </g>
    </Svg>
  );
}

/** The ideogram's points across its axis: at least GRID, at most MAX_GRID. */
const GRID = 240;
const MAX_GRID = 4000;

/** Bins of equal width across the domain, about √n of them (5–40). */
function histogram(ages: number[], [lo, hi]: [number, number]) {
  const count = Math.max(5, Math.min(40, Math.round(Math.sqrt(ages.length) * 1.5)));
  const width = (hi - lo) / count || 1;
  const bins = Array.from({ length: count }, (_, i) => ({ lo: lo + i * width, n: 0 }));
  for (const age of ages) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((age - lo) / width)));
    bins[i].n += 1;
  }
  return { bins, width };
}

/**
 * An ideogram: the sum of each age's normal curve (its ±σ), with the ages as
 * a rug, and optionally their histogram, the curve then scaled to its
 * tallest bin. Ages without a σ are in the rug and histogram only.
 */
export function Ideogram({
  items,
  unit,
  reference,
  width,
  height,
  detailed,
  withHistogram,
  label,
}: {
  items: DatedItem[];
  unit: string;
  reference?: Reference;
  width: number;
  height: number;
  detailed?: boolean;
  withHistogram?: boolean;
  label: string;
}) {
  if (items.length === 0) return null;
  const withSigma = items.filter((d) => d.sigma != null && d.sigma > 0);
  const ages = items.map((d) => d.age);
  // The curves reach 2σ beyond the ages, but no more than half their span.
  const span = Math.max(...ages) - Math.min(...ages) || Math.abs(ages[0]) * 0.1 || 1;
  const reach = (d: DatedItem) => Math.min(2 * (d.sigma ?? 0), span / 2);
  const lows = items.map((d) => d.age - reach(d));
  const highs = items.map((d) => d.age + reach(d));
  if (reference) {
    lows.push(reference.age - (reference.sigma ?? 0));
    highs.push(reference.age + (reference.sigma ?? 0));
  }
  const xDomain = padded(Math.min(...lows), Math.max(...highs));
  // Fine enough to resolve the narrowest curve (4 points per σ), within limits.
  const narrowest = Math.min(...withSigma.map((d) => d.sigma as number));
  const grid = Number.isFinite(narrowest)
    ? Math.max(GRID, Math.min(MAX_GRID, Math.ceil(((xDomain[1] - xDomain[0]) / narrowest) * 4)))
    : GRID;
  const xs = Array.from(
    { length: grid },
    (_, i) => xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / (grid - 1),
  );
  const density = xs.map((x) =>
    withSigma.reduce((sum, d) => {
      const z = (x - d.age) / (d.sigma as number);
      return sum + Math.exp(-0.5 * z * z) / (d.sigma as number);
    }, 0),
  );
  const peak = Math.max(0, ...density);
  const hist = withHistogram ? histogram(ages, xDomain) : null;
  const top = hist ? Math.max(...hist.bins.map((b) => b.n)) : 1;
  const yDomain: [number, number] = [0, top * 1.08];
  const scale = peak > 0 ? top / peak : 0;
  const f = frame(width, height, xDomain, yDomain, detailed);
  const clipId = `argon-ideogram-${clipKey(label)}-${detailed ? "d" : "t"}`;
  const curve =
    peak > 0
      ? xs.map((x, i) => `${i ? "L" : "M"}${f.x(x)},${f.y(density[i] * scale)}`).join("")
      : null;
  const bottom = f.pad.top + f.innerH;
  // Each age's own curve, faintly, while there are few enough to tell apart.
  const singles = !withHistogram && withSigma.length > 1 && withSigma.length <= 30;
  return (
    <Svg width={width} height={height} label={label} clipId={clipId} f={f}>
      {detailed && (
        <Axes
          f={f}
          xDomain={xDomain}
          yDomain={yDomain}
          xLabel={`Age (${unit})`}
          yLabel={hist ? "Count" : "Relative probability"}
          height={height}
        />
      )}
      <g clipPath={`url(#${clipId})`}>
        {reference && <ReferenceMark reference={reference} f={f} vertical detailed={detailed} />}
        {hist?.bins.map((bin) => (
          <rect
            key={bin.lo}
            x={f.x(bin.lo)}
            width={Math.max(0.5, f.x(bin.lo + hist.width) - f.x(bin.lo) - 1)}
            y={f.y(bin.n)}
            height={bottom - f.y(bin.n)}
            fill="var(--er-plot-faded)"
            stroke="var(--er-plot-muted)"
            strokeWidth={0.5}
          >
            {detailed && (
              <title>{`${bin.lo.toPrecision(4)}–${(bin.lo + hist.width).toPrecision(4)} ${unit}: ${bin.n}`}</title>
            )}
          </rect>
        ))}
        {singles &&
          withSigma.map((d, n) => {
            const s = d.sigma as number;
            const path = xs
              .map((x, i) => {
                const z = (x - d.age) / s;
                return `${i ? "L" : "M"}${f.x(x)},${f.y((Math.exp(-0.5 * z * z) / s) * scale)}`;
              })
              .join("");
            return (
              <path
                key={`${d.name}-${n}`}
                d={path}
                fill="none"
                stroke="var(--er-plot-muted)"
                strokeWidth={0.75}
              />
            );
          })}
        {curve && <path d={curve} fill="none" stroke={ACCENT} strokeWidth={detailed ? 2 : 1} />}
        {items.length <= 2000 &&
          items.map((d, i) => (
            <line
              key={`${d.name}-${i}`}
              x1={f.x(d.age)}
              x2={f.x(d.age)}
              y1={bottom}
              y2={bottom - (detailed ? 6 : 3)}
              stroke="var(--er-plot-strong)"
              strokeWidth={0.75}
            >
              {detailed && <title>{`${d.name}: ${d.age.toFixed(3)} ${unit}`}</title>}
            </line>
          ))}
      </g>
    </Svg>
  );
}

// --- x–y with error bars -------------------------------------------------------------------

export interface XYPoint {
  name: string;
  x: number;
  xSigma?: number | null;
  y: number;
  ySigma?: number | null;
  /** Drawn hollow (an unknown among flux monitors). */
  hollow?: boolean;
}

/** Points with their error bars; `reverseY` puts the smallest y at the top
 * (depth). */
export function XYErrorPlot({
  points,
  xLabel,
  yLabel,
  reverseY,
  width,
  height,
  detailed,
  label,
}: {
  points: XYPoint[];
  xLabel: string;
  yLabel: string;
  reverseY?: boolean;
  width: number;
  height: number;
  detailed?: boolean;
  label: string;
}) {
  if (points.length === 0) return null;
  const xDomain = padded(
    Math.min(...points.map((p) => p.x - (p.xSigma ?? 0))),
    Math.max(...points.map((p) => p.x + (p.xSigma ?? 0))),
    0.08,
  );
  const yDomain = padded(
    Math.min(...points.map((p) => p.y - (p.ySigma ?? 0))),
    Math.max(...points.map((p) => p.y + (p.ySigma ?? 0))),
    0.08,
  );
  // Room on the left for the longest y tick label (J's are 0.001375) and the name.
  const yt = niceTicks(...yDomain);
  const longest = Math.max(...yt.ticks.map((tick) => tick.toFixed(yt.decimals).length));
  const pad = detailed
    ? { ...DETAILED_PAD, left: Math.max(DETAILED_PAD.left, longest * 6 + 30) }
    : undefined;
  const f = frame(
    width,
    height,
    xDomain,
    reverseY ? [yDomain[1], yDomain[0]] : yDomain,
    detailed,
    pad,
  );
  const clipId = `argon-xy-${clipKey(label)}-${detailed ? "d" : "t"}`;
  const r = detailed ? 3.5 : 2;
  return (
    <Svg width={width} height={height} label={label} clipId={clipId} f={f}>
      {detailed && (
        <Axes
          f={f}
          xDomain={xDomain}
          yDomain={yDomain}
          xLabel={xLabel}
          yLabel={yLabel}
          height={height}
        />
      )}
      <g clipPath={`url(#${clipId})`}>
        {points.map((p, i) => (
          <g key={`${p.name}-${i}`} stroke={ACCENT} strokeWidth={1}>
            <title>{`${p.name}: ${xLabel} ${p.x.toPrecision(5)}${p.xSigma ? ` ± ${p.xSigma.toPrecision(2)}` : ""}, ${yLabel} ${p.y.toPrecision(5)}${p.ySigma ? ` ± ${p.ySigma.toPrecision(2)}` : ""}`}</title>
            {p.xSigma ? (
              <line x1={f.x(p.x - p.xSigma)} x2={f.x(p.x + p.xSigma)} y1={f.y(p.y)} y2={f.y(p.y)} />
            ) : null}
            {p.ySigma ? (
              <line x1={f.x(p.x)} x2={f.x(p.x)} y1={f.y(p.y - p.ySigma)} y2={f.y(p.y + p.ySigma)} />
            ) : null}
            <circle
              cx={f.x(p.x)}
              cy={f.y(p.y)}
              r={r}
              fill={p.hollow ? "var(--er-plot-surface)" : accentFill(50)}
            />
          </g>
        ))}
      </g>
    </Svg>
  );
}
