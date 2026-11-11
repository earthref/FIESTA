// The search grid's Plot tile for a contribution: one of its plots, drawn
// from the small thumbnail the index keeps per plot type (plugin.py
// `compute_thumbnails`), with the total number of plots in the corner, as the
// legacy grid showed one cached PmagPy PNG and a count. A click opens that
// plot's tab of the contribution.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NoPlotsCell } from "@/components/result-item";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useOpenContribution } from "@/lib/contribution-modal";
import type { SearchPage } from "@/lib/types";
import { abbreviateNumber, getPath } from "@/lib/utils";
import { PLOTS, type PlotType } from "./pmag-plots-data";

interface Zijd {
  name: string;
  n: number[];
  e: number[];
  d: number[];
}
interface EqArea {
  name: string;
  x: number[];
  y: number[];
  up: number[];
}
interface Arai {
  name: string;
  x: number[];
  y: number[];
}
interface Hyst {
  name: string;
  field: number[];
  m: number[];
}
type Thumbnail = Zijd | EqArea | Arai | Hyst;
type Thumbnails = Partial<Record<"zijd" | "eqarea" | "arai" | "hyst", Thumbnail>>;

const RED = "#d62728";
const BLUE = "#1f77b4";
const NET = "#8a8984";
const AXIS = "var(--er-ink-faint)";

/** The contribution's `pmag_plots` doc; the tabs' counts share this query. */
export function pmagPlotsDocQuery(id: string, table: string, privateKey?: string) {
  return {
    queryKey: ["plugin", "pmag-plots", "counts", id, table, privateKey],
    queryFn: () =>
      api<SearchPage>(`/search/${table}`, {
        params: { contribution: id, private_key: privateKey || undefined, size: 1 },
      }),
  };
}

// One draw per page load: a row shows the same plot when it scrolls back into
// view, and a reload may show another.
const SESSION_SEED = Math.random();

function pick<T>(items: T[], id: string): T | undefined {
  let hash = 0;
  for (const char of `${id}:${SESSION_SEED}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return items[Math.abs(hash) % items.length];
}

const SIZE = 98;
const PAD = 9;

/** Data coordinates (y up) → the tile's pixels, one scale for both axes. */
function frame(xs: number[], ys: number[], square = true) {
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const inner = SIZE - 2 * PAD;
  const sx = inner / (x1 - x0 || 1);
  const sy = inner / (y1 - y0 || 1);
  const [kx, ky] = square ? [Math.min(sx, sy), Math.min(sx, sy)] : [sx, sy];
  const ox = PAD + (inner - (x1 - x0) * kx) / 2;
  const oy = PAD + (inner - (y1 - y0) * ky) / 2;
  return {
    x: (v: number) => ox + (v - x0) * kx,
    y: (v: number) => SIZE - oy - (v - y0) * ky,
  };
}

const path = (points: [number, number][]) =>
  points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

/** Orthogonal projections, North to the right, East and Down plotted
 * downwards: horizontal filled red, vertical open blue (pmagplotlib.plot_zij). */
function ZijdPlot({ t }: { t: Zijd }) {
  const ys = [0, ...t.e.map((v) => -v), ...t.d.map((v) => -v)];
  const f = frame([0, ...t.n], ys);
  const h = t.n.map((n, i): [number, number] => [f.x(n), f.y(-t.e[i])]);
  const v = t.n.map((n, i): [number, number] => [f.x(n), f.y(-t.d[i])]);
  return (
    <>
      <line x1={PAD / 2} x2={SIZE - PAD / 2} y1={f.y(0)} y2={f.y(0)} stroke={AXIS} />
      <line x1={f.x(0)} x2={f.x(0)} y1={PAD / 2} y2={SIZE - PAD / 2} stroke={AXIS} />
      <path d={path(h)} fill="none" stroke={RED} strokeWidth={0.75} />
      <path d={path(v)} fill="none" stroke={BLUE} strokeWidth={0.75} />
      {h.map(([x, y], i) => (
        <circle key={`h${i}`} cx={x} cy={y} r={1.8} fill={RED} />
      ))}
      {v.map(([x, y], i) => (
        <rect
          key={`v${i}`}
          x={x - 1.6}
          y={y - 1.6}
          width={3.2}
          height={3.2}
          fill="var(--er-surface)"
          stroke={BLUE}
        />
      ))}
    </>
  );
}

/** The net's rim and centre, lower-hemisphere directions filled, upper open. */
function EqAreaPlot({ t }: { t: EqArea }) {
  const c = SIZE / 2;
  const r = c - PAD / 2;
  return (
    <>
      <circle cx={c} cy={c} r={r} fill="none" stroke={NET} />
      <path d={`M${c - 3},${c}h6M${c},${c - 3}v6`} stroke={NET} />
      {t.x.map((x, i) => (
        <circle
          key={i}
          cx={c + x * r}
          cy={c - t.y[i] * r}
          r={2}
          fill={t.up[i] ? "var(--er-surface)" : BLUE}
          stroke={BLUE}
        />
      ))}
    </>
  );
}

/** NRM remaining against pTRM gained, from the origin. */
function AraiPlot({ t }: { t: Arai }) {
  const f = frame([0, ...t.x], [0, ...t.y], false);
  const points = t.x.map((x, i): [number, number] => [f.x(x), f.y(t.y[i])]);
  return (
    <>
      <path d={`M${f.x(0)},${PAD / 2}V${f.y(0)}H${SIZE - PAD / 2}`} fill="none" stroke={AXIS} />
      <path d={path(points)} fill="none" stroke={NET} strokeWidth={0.75} />
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.8} fill={RED} />
      ))}
    </>
  );
}

/** The loop as measured, moment over its largest against the applied field. */
function HystPlot({ t }: { t: Hyst }) {
  const f = frame(t.field, [-1, 1, ...t.m], false);
  const points = t.field.map((b, i): [number, number] => [f.x(b), f.y(t.m[i])]);
  return (
    <>
      <line x1={PAD / 2} x2={SIZE - PAD / 2} y1={f.y(0)} y2={f.y(0)} stroke={AXIS} />
      <line x1={f.x(0)} x2={f.x(0)} y1={PAD / 2} y2={SIZE - PAD / 2} stroke={AXIS} />
      <path d={path(points)} fill="none" stroke={BLUE} strokeWidth={1} />
    </>
  );
}

const DRAW: Record<keyof Thumbnails, (t: Thumbnail) => ReactNode> = {
  zijd: (t) => <ZijdPlot t={t as Zijd} />,
  eqarea: (t) => <EqAreaPlot t={t as EqArea} />,
  arai: (t) => <AraiPlot t={t as Arai} />,
  hyst: (t) => <HystPlot t={t as Hyst} />,
};

export function PmagPlotThumbnail({
  id,
  table,
  plotTypes,
  privateKey,
  width,
}: {
  id: string;
  table: string;
  plotTypes: PlotType[];
  privateKey?: string;
  width: number;
}) {
  const openContribution = useOpenContribution();
  const query = useQuery({
    ...pmagPlotsDocQuery(id, table, privateKey),
    select: (page: SearchPage) => page.results[0],
  });
  if (query.isPending) {
    return (
      <NoPlotsCell width={width}>
        <div className="flex h-[98px] items-center justify-center">
          <Spinner />
        </div>
      </NoPlotsCell>
    );
  }
  const block = getPath(query.data, "summary.pmag_plots") as Record<string, unknown> | undefined;
  const total = plotTypes.reduce((sum, type) => sum + Number(block?.[type] ?? 0), 0);
  if (!block || total === 0) return <NoPlotsCell width={width} />;

  const thumbnails = (getPath(block, "_geometry.thumbnails") ?? {}) as Thumbnails;
  const drawable = (Object.keys(DRAW) as (keyof Thumbnails)[]).filter(
    (type) => thumbnails[type] && plotTypes.includes(type),
  );
  const type = pick(drawable, id);
  const thumbnail = type && thumbnails[type];
  // Before a re-index there are counts but no thumbnails: the first tab opens.
  const tab = type ?? plotTypes.find((t) => Number(block[t] ?? 0) > 0) ?? plotTypes[0];
  const plots = `${total.toLocaleString()} plot${total === 1 ? "" : "s"}`;
  const label = thumbnail ? `${PLOTS[tab].label} of ${thumbnail.name} · ${plots}` : plots;

  return (
    <NoPlotsCell width={width}>
      <button
        type="button"
        onClick={() => openContribution(id, PLOTS[tab].key)}
        title={`${label}: open the plots`}
        aria-label={`${label}: open the plots`}
        className="block size-full cursor-pointer text-ink-faint hover:bg-panel-soft focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{ height: SIZE }}
      >
        {thumbnail ? (
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
            {DRAW[type](thumbnail)}
          </svg>
        ) : (
          <span className="text-node-ink">
            <b>{plots}</b>
          </span>
        )}
      </button>
      {thumbnail && (
        <span
          className="pointer-events-none absolute top-0 right-0 border-b border-l bg-surface px-1.5 py-0.5 text-[12px] font-bold text-node-ink"
          style={{ borderColor: "rgba(0,0,0,.1)" }}
        >
          {abbreviateNumber(total)}
        </span>
      )}
    </NoPlotsCell>
  );
}
