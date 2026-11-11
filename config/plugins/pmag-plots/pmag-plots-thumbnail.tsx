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
  /** The group's level ("Specimens"); missing on thumbnails indexed before it. */
  level?: string;
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
// The node's color, lightened in dark mode as the tile's surface darkens.
const NODE = "var(--node-ink)";

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

/** The plot tab's key for a thumbnail's plot (pmag-plots-view `plotItems`): an
 * equal-area group's "<level>:<name>", else the specimen's name (which the
 * tab also matches against the start of a hysteresis loop's key). */
function plotKeyOf(thumbnail: Thumbnail): string {
  return "level" in thumbnail && thumbnail.level
    ? `${thumbnail.level}:${thumbnail.name}`
    : thumbnail.name;
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
          fill={t.up[i] ? "var(--er-surface)" : NODE}
          stroke={NODE}
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
      <path d={path(points)} fill="none" stroke={NODE} strokeWidth={1} />
    </>
  );
}

const DRAW: Record<keyof Thumbnails, (t: Thumbnail) => ReactNode> = {
  zijd: (t) => <ZijdPlot t={t as Zijd} />,
  eqarea: (t) => <EqAreaPlot t={t as EqArea} />,
  arai: (t) => <AraiPlot t={t as Arai} />,
  hyst: (t) => <HystPlot t={t as Hyst} />,
};

/** GET /plugins/pmag-plots/thumbnails/{id}: one record's plot counts and thumbnails. */
interface RecordPlots {
  counts: Record<string, number>;
  thumbnails: Thumbnails;
}

const spinner = (width: number) => (
  <NoPlotsCell width={width}>
    <div className="flex h-[98px] items-center justify-center">
      <Spinner />
    </div>
  </NoPlotsCell>
);

/** The Plot tile of a contribution (`table` "contribution") or of one of its
 * locations, sites, samples or specimens (`name`). A contribution's thumbnails
 * come with its `pmag_plots` doc; a record's, and those of a contribution
 * indexed before thumbnails existed, from the plugin's route, which computes
 * them from the file once. */
export function PmagPlotThumbnail({
  id,
  table,
  name,
  docTable,
  plotTypes,
  privateKey,
  width,
}: {
  id: string;
  table: string;
  name?: string;
  docTable: string;
  plotTypes: PlotType[];
  privateKey?: string;
  width: number;
}) {
  const openContribution = useOpenContribution();
  const isContribution = table === "contribution";
  const doc = useQuery({
    ...pmagPlotsDocQuery(id, docTable, privateKey),
    select: (page: SearchPage) => page.results[0] ?? null,
    enabled: isContribution,
  });
  const docBlock = getPath(doc.data, "summary.pmag_plots") as Record<string, unknown> | undefined;
  const docThumbnails = getPath(docBlock, "_geometry.thumbnails") as Thumbnails | undefined;
  const totalOf = (counts: Record<string, unknown> | undefined) =>
    plotTypes.reduce((sum, type) => sum + Number(counts?.[type] ?? 0), 0);
  const fromRoute = !isContribution || (doc.isSuccess && totalOf(docBlock) > 0 && !docThumbnails);
  const record = useQuery({
    queryKey: ["plugin", "pmag-plots", "thumbnails", id, table, name, privateKey],
    queryFn: () =>
      api<RecordPlots>(`/plugins/pmag-plots/thumbnails/${id}`, {
        params: { table, name: name || undefined, private_key: privateKey || undefined },
      }),
    enabled: fromRoute,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if ((isContribution && doc.isPending) || (fromRoute && record.isPending)) return spinner(width);

  // The route's answer when asked; a contribution whose route failed keeps its doc's count.
  const counts = record.data?.counts ?? (isContribution ? docBlock : undefined);
  const thumbnails = record.data?.thumbnails ?? docThumbnails ?? {};
  const total = totalOf(counts);
  if (!counts || total === 0) return <NoPlotsCell width={width} />;

  const drawable = (Object.keys(DRAW) as (keyof Thumbnails)[]).filter(
    (type) => thumbnails[type] && plotTypes.includes(type),
  );
  const type = pick(drawable, `${id}:${table}:${name ?? ""}`);
  const thumbnail = type && thumbnails[type];
  // Counts without a thumbnail (it failed to draw): the first tab with plots opens.
  const tab = type ?? plotTypes.find((t) => Number(counts[t] ?? 0) > 0) ?? plotTypes[0];
  const plots = `${total.toLocaleString()} plot${total === 1 ? "" : "s"}`;
  const label = thumbnail ? `${PLOTS[tab].label} of ${thumbnail.name} · ${plots}` : plots;

  return (
    <NoPlotsCell width={width}>
      <button
        type="button"
        // Opens on this plot, selected (an equal-area group's key is its level and name).
        onClick={() =>
          openContribution(id, PLOTS[tab].key, undefined, {
            plot: thumbnail ? plotKeyOf(thumbnail) : undefined,
            privateKey,
          })
        }
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
