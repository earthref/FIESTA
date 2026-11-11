// The search page's filter modals, opened from the sidebar's filter list and
// the summary grid's column headers (2026-11-10; they replace the sidebar's
// accordions and the headers' drop-down menus):
//
// - FacetModal: a facet's values as a list with their counts, a Find box and a
//   sort; values a plugin describes (its facetDescriptions) show definitions
//   and are grouped as the plugin lists them. A column's text box sits above.
// - RangeModal: a numeric filter over its distribution (a histogram of the
//   search's values, linear or log bins, of a chosen count) to brush or click,
//   with min/max boxes.
// - NumericModal: the `numeric` filter's picker of the level's number columns
//   (summary._num.<column>), each then a RangeModal of its own.
// - ExistsModal: the `exists` filter's columns with (or without) data, a tab
//   per table the level's records cover and a With / Without switch.
// - GeoModal: the geospatial area on the search's map, with its bounds as numbers.
//
// Each edits a draft and applies it with Apply, so a long list keeps its order
// while values are picked and the search runs once.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useNodeConfig } from "../lib/config";
import { dataModelQuery, unwrapModel } from "../lib/data-model";
import { plotColors } from "../lib/plot-colors";
import type {
  DataModel,
  DataModelColumn,
  FacetBucket,
  HasColumns,
  NumberColumns,
  SearchFilter,
  SearchHistogram,
  SearchLevel,
  SearchPage,
} from "../lib/types";
import {
  abbreviateNumber,
  buildQuery,
  cx,
  facetTitle,
  parseQueryTokens,
  queryWithout,
  singularize,
} from "../lib/utils";
import { type FacetValueDescription, usePluginFacetDescriptions } from "../plugins";
import { type BrushRange, EChart, type EChartsOption } from "./echart";
import { type Area, WHOLE_GLOBE } from "./map/map-points";
import { type AreaRequest, SearchMap } from "./map/search-map";
import {
  ANY_TABLE,
  Chip,
  formatHas,
  type HasEntry,
  NUMBER_PREFIX,
  parseHas,
  parseRange,
} from "./search-filters";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { Spinner } from "./ui/spinner";

export type SearchParams = Record<
  string,
  string | number | boolean | undefined | (string | number)[]
>;

/** Values a facet modal lists: every value (the sidebar's lists showed 100). */
const FACET_SIZE = 2000;

const inputClass =
  "rounded-sm border border-gray-300 bg-surface px-[0.8em] py-[0.45em] text-[13px] " +
  "placeholder:text-ink-faint focus:border-node focus:outline-hidden";

function Footer({
  onClear,
  clearDisabled,
  onCancel,
  onApply,
  applyDisabled,
  applyLabel = "Apply",
}: {
  onClear: () => void;
  clearDisabled: boolean;
  onCancel: () => void;
  onApply: () => void;
  applyDisabled?: boolean;
  applyLabel?: string;
}) {
  return (
    <>
      <Button variant="ghost" className="mr-auto" onClick={onClear} disabled={clearDisabled}>
        Clear
      </Button>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button onClick={onApply} disabled={applyDisabled}>
        {applyLabel}
      </Button>
    </>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span
      className="inline-block shrink-0 self-start rounded-full border border-line bg-surface text-center text-[11px] font-bold text-ink"
      style={{ lineHeight: "0.7em", padding: "0.5em", minWidth: "2em", minHeight: "2em" }}
    >
      {abbreviateNumber(n)}
    </span>
  );
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-yellow-200">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

// --- Facets ---------------------------------------------------------------------

export type FacetSpec = { field: string; label: string };

type Described = FacetValueDescription;

/** Each facet's values in the query's `field:"value"` tokens. */
function selectedIn(q: string, facets: FacetSpec[]): Record<string, string[]> {
  const tokens = parseQueryTokens(q).tokens;
  return Object.fromEntries(
    facets.map(({ field }) => [field, tokens.filter(([f]) => f === field).map(([, v]) => v)]),
  );
}

type Row = { key: string; count: number; described?: Described };

/**
 * A facet's values (several facets: a tab each), counted for the search
 * without the facet's own values, so each count is what picking it adds
 * (values of one facet are OR'd). `text` is a grid column's "Contains" box.
 */
export function FacetModal({
  title,
  facets,
  table,
  q,
  paramsFor,
  count,
  text,
  onApply,
  onClose,
}: {
  title: string;
  facets: FacetSpec[];
  table: string;
  q: string;
  /** The search's request params for a query string. */
  paramsFor: (q: string) => SearchParams;
  /** A value's count on the open sub-tab (rows, mapped records); default its records. */
  count?: (bucket: FacetBucket) => number | undefined;
  text?: { label: string; value: string };
  onApply: (next: { q: string; text?: string }) => void;
  onClose: () => void;
}) {
  const initial = useMemo(() => selectedIn(q, facets), [q, facets]);
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState(facets[0]?.field ?? "");
  const [find, setFind] = useState("");
  const [sortBy, setSortBy] = useState<"count" | "name">("count");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [textDraft, setTextDraft] = useState(text?.value ?? "");
  const { data: config } = useNodeConfig();
  const descriptions = usePluginFacetDescriptions(config);

  const params = tab ? paramsFor(queryWithout(q, [tab])) : {};
  const buckets = useQuery({
    queryKey: ["filter-modal-facet", table, tab, params],
    queryFn: () =>
      api<SearchPage>(`/search/${table}`, {
        params: { ...params, size: 1, facet: [tab], facet_size: FACET_SIZE, totals: true },
      }),
    enabled: !!tab,
    staleTime: 60_000,
  });

  const selected = draft[tab] ?? [];
  const selectedSet = new Set(selected);
  const needle = find.trim().toLowerCase();
  const rows = useMemo(() => {
    const counted: Row[] = (buckets.data?.aggregations?.[tab] ?? [])
      .map((bucket) => ({ key: bucket.key, count: (count?.(bucket) ?? bucket.doc_count) || 0 }))
      .filter((row) => row.count > 0);
    // A picked value the search no longer has stays listed, at zero.
    const seen = new Set(counted.map((row) => row.key));
    const all = [
      ...counted,
      ...(draft[tab] ?? []).filter((key) => !seen.has(key)).map((key) => ({ key, count: 0 })),
    ].map((row) => ({ ...row, described: descriptions.get(row.key) }));
    return all
      .filter((row) => !selectedOnly || (draft[tab] ?? []).includes(row.key))
      .filter(
        (row) =>
          !needle ||
          row.key.toLowerCase().includes(needle) ||
          (row.described?.definition ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        sortBy === "name"
          ? a.key.localeCompare(b.key)
          : b.count - a.count || a.key.localeCompare(b.key),
      );
  }, [buckets.data, tab, count, draft, descriptions, selectedOnly, needle, sortBy]);

  // Values a plugin describes are grouped as it lists them; others aren't.
  const grouped = rows.some((row) => row.described);
  const groups = useMemo(() => {
    if (!grouped) return [{ name: "", rows }];
    const byGroup = new Map<string, { name: string; order: number; rows: Row[] }>();
    for (const row of rows) {
      const name = row.described?.group ?? "Other";
      const order = row.described?.order ?? Number.POSITIVE_INFINITY;
      const entry = byGroup.get(name) ?? { name, order, rows: [] };
      entry.rows.push(row);
      byGroup.set(name, entry);
    }
    return [...byGroup.values()].sort((a, b) => a.order - b.order);
  }, [grouped, rows]);

  const toggle = (key: string) =>
    setDraft({
      ...draft,
      [tab]: selectedSet.has(key) ? selected.filter((v) => v !== key) : [...selected, key],
    });
  const picked = Object.values(draft).reduce((n, values) => n + values.length, 0);
  const changed =
    JSON.stringify(draft) !== JSON.stringify(initial) || textDraft !== (text?.value ?? "");
  const apply = () => {
    const fields = facets.map((facet) => facet.field);
    const { tokens, freeText } = parseQueryTokens(queryWithout(q, fields));
    for (const field of fields) for (const value of draft[field] ?? []) tokens.push([field, value]);
    onApply({ q: buildQuery(freeText, tokens), text: text ? textDraft.trim() : undefined });
  };
  const loading = buckets.isPending && !!tab;

  return (
    <Modal
      open
      xl
      onClose={onClose}
      title={title}
      footer={
        <Footer
          onClear={() => {
            setDraft(Object.fromEntries(facets.map(({ field }) => [field, []])));
            setTextDraft("");
          }}
          clearDisabled={picked === 0 && !textDraft}
          onCancel={onClose}
          onApply={apply}
          applyDisabled={!changed}
        />
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink">
        {text && (
          <label className="flex flex-col gap-1">
            <span className="font-bold">Contains</span>
            <input
              type="search"
              value={textDraft}
              onChange={(event) => setTextDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && changed) apply();
              }}
              placeholder={`Filter ${text.label}`}
              className={inputClass}
            />
          </label>
        )}
        {facets.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
            {facets.map((facet) => {
              const n = draft[facet.field]?.length ?? 0;
              const active = facet.field === tab;
              return (
                <button
                  key={facet.field}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(facet.field)}
                  className={cx(
                    "-mb-px cursor-pointer rounded-t-sm border px-3 py-1.5",
                    active
                      ? "border-line border-b-surface bg-surface font-bold"
                      : "border-transparent text-ink-muted hover:text-node-ink",
                  )}
                >
                  {facet.label}
                  {n > 0 && (
                    <span className="ml-1.5 rounded-full bg-node px-[0.45em] text-[10px] font-bold text-white">
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {tab && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={find}
                onChange={(event) => setFind(event.target.value)}
                placeholder={grouped ? "Find a code or description" : "Find a value"}
                aria-label={`Find ${facets.find((f) => f.field === tab)?.label ?? ""} values`}
                className={cx(inputClass, "min-w-48 flex-1")}
              />
              <label className="flex items-center gap-1.5">
                <span className="text-ink-muted">Sort</span>
                <select
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value as "count" | "name")}
                  className="rounded-sm border border-gray-300 bg-surface px-1.5 py-1"
                >
                  <option value="count">Most records</option>
                  <option value="name">A–Z</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selectedOnly}
                  onChange={() => setSelectedOnly(!selectedOnly)}
                  className="h-4 w-4 accent-node"
                />
                Selected only
              </label>
            </div>
            {selected.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {selected.map((key) => (
                  <Chip key={key} label={key} onRemove={() => toggle(key)} />
                ))}
              </div>
            )}
            <div
              className="min-h-40 overflow-y-auto rounded-sm border border-line"
              style={{ maxHeight: "50vh" }}
            >
              {loading && (
                <div className="flex items-center justify-center gap-2 p-6 text-ink-muted">
                  <Spinner /> Loading values…
                </div>
              )}
              {buckets.error && (
                <div className="p-4 text-center text-red-700">Could not load the values.</div>
              )}
              {!loading && !buckets.error && rows.length === 0 && (
                <div className="p-6 text-center font-bold text-ink-muted">
                  {needle || selectedOnly ? "No matches" : "No values for this search"}
                </div>
              )}
              {groups.map((group) => (
                <div key={group.name || "values"}>
                  {group.name && (
                    <div className="sticky top-0 z-10 border-b border-line bg-panel px-3 py-1 text-[12px] font-bold text-ink-muted">
                      {group.name}
                      <span className="ml-1 font-normal">({group.rows.length})</span>
                    </div>
                  )}
                  {group.rows.map((row) => (
                    <label
                      key={row.key}
                      className={cx(
                        "flex cursor-pointer items-start gap-2 border-b border-line/60 px-3 py-1.5 last:border-b-0 hover:bg-node-soft",
                        selectedSet.has(row.key) && "bg-node-soft/60",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSet.has(row.key)}
                        onChange={() => toggle(row.key)}
                        className="mt-[1px] h-4 w-4 shrink-0 cursor-pointer accent-node"
                      />
                      <span
                        className={cx(
                          "shrink-0 break-words",
                          grouped ? "w-36 font-mono text-[12px]" : "min-w-0 flex-1",
                          selectedSet.has(row.key) && "font-bold",
                        )}
                      >
                        <Highlight text={row.key} needle={needle} />
                      </span>
                      {grouped && (
                        <span className="min-w-0 flex-1 text-ink-muted">
                          <Highlight text={row.described?.definition ?? ""} needle={needle} />
                        </span>
                      )}
                      <CountBadge n={row.count} />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="text-[12px] text-ink-muted">
              {rows.length.toLocaleString()} value{rows.length === 1 ? "" : "s"} shown · counts are
              the records each value adds to the search
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// --- Numeric ranges --------------------------------------------------------------

const BIN_CHOICES = [20, 40, 80];
const SCALES: [boolean, string][] = [
  [false, "Linear"],
  [true, "Log"],
];

/** A value to show or type: 4 significant digits, no trailing zeros. */
export const formatValue = (value: number) =>
  Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 1e-3)
    ? value.toExponential(2)
    : String(Number(value.toPrecision(4)));
/** A bin edge as a typed bound: precise enough that the bin stays selected. */
const edgeValue = (value: number) => String(Number(value.toPrecision(6)));
/** Whether a bin is inside [lo, hi], allowing for edgeValue's rounding. */
const within = (bar: { lo: number; hi: number }, lo: number, hi: number) =>
  bar.lo >= lo - 1e-5 * Math.abs(lo) && bar.hi <= hi + 1e-5 * Math.abs(hi);

/**
 * A numeric filter over the search's values: the histogram (the search
 * without this filter's own range) to brush or click, whose bins snap the
 * selection, and min/max boxes. Values show in the filter's units (`scale`).
 */
export function RangeModal({
  filter,
  table,
  ranges,
  paramsFor,
  color,
  onApply,
  onBack,
  onClose,
}: {
  filter: SearchFilter;
  table: string;
  ranges: string[];
  /** The search's request params with these ranges. */
  paramsFor: (ranges: string[]) => SearchParams;
  color: string;
  onApply: (ranges: string[]) => void;
  /** Back to the list it was picked from (the numeric filter's columns). */
  onBack?: () => void;
  onClose: () => void;
}) {
  const field = filter.field ?? "";
  const scale = filter.scale || 1;
  const unit = filter.unit ? ` ${filter.unit}` : "";
  const label = filter.label ?? field;
  const others = useMemo(
    () => ranges.filter((entry) => parseRange(entry).field !== field),
    [ranges, field],
  );
  const stored = ranges.map(parseRange).find((entry) => entry.field === field);
  const shown = (v: string | undefined) => (v ? formatValue(Number(v) / scale) : "");
  const initial = { gte: shown(stored?.gte), lte: shown(stored?.lte) };
  const [draft, setDraft] = useState(initial);
  const [log, setLog] = useState(false);
  const [bins, setBins] = useState(40);

  const params = paramsFor(others);
  const histogram = useQuery({
    queryKey: ["filter-modal-histogram", table, field, params, log, bins],
    queryFn: () =>
      api<SearchHistogram>(`/search/${table}/histogram`, {
        params: { ...params, size: undefined, field, bins, log: log || undefined },
      }),
    staleTime: 60_000,
  });
  const data = histogram.data;
  const bars = useMemo(
    () => (data?.bins ?? []).map((bin) => ({ ...bin, lo: bin.lo / scale, hi: bin.hi / scale })),
    [data, scale],
  );
  const lo = draft.gte === "" ? Number.NEGATIVE_INFINITY : Number(draft.gte);
  const hi = draft.lte === "" ? Number.POSITIVE_INFINITY : Number(draft.lte);
  const anySelection = draft.gte !== "" || draft.lte !== "";
  // Which bins are in the selection (colored; all of them without one).
  const flags = useMemo(
    () => bars.map((bar) => !anySelection || within(bar, lo, hi)),
    [bars, anySelection, lo, hi],
  );
  const selectedCount = bars.reduce((n, bar, i) => n + (flags[i] ? bar.count : 0), 0);
  const valid =
    (draft.gte === "" || Number.isFinite(lo)) &&
    (draft.lte === "" || Number.isFinite(hi)) &&
    (!anySelection || lo <= hi);

  // A brushed band or a clicked bar selects whole bins.
  const selectBins = useCallback(
    (x0: number, x1: number) => {
      const covered = bars.filter((bar) => bar.hi > Math.min(x0, x1) && bar.lo < Math.max(x0, x1));
      if (!covered.length) return;
      setDraft({
        gte: edgeValue(covered[0].lo),
        lte: edgeValue(covered[covered.length - 1].hi),
      });
    },
    [bars],
  );
  const onBrush = useCallback((range: BrushRange) => selectBins(...range.x), [selectBins]);
  const onClick = useCallback(
    (value: unknown) => {
      if (Array.isArray(value)) selectBins(Number(value[0]) + 1e-12, Number(value[1]) - 1e-12);
    },
    [selectBins],
  );

  const xLog = !!data?.log;
  const build = useCallback(() => {
    // Read per build (a canvas takes no CSS variables); EChart rebuilds on a theme switch.
    const colors = plotColors();
    const axisColors = {
      nameTextStyle: { color: colors.text },
      axisLine: { lineStyle: { color: colors.axis } },
      axisTick: { lineStyle: { color: colors.axis } },
      axisLabel: { color: colors.text },
      splitLine: { lineStyle: { color: colors.grid } },
    };
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 16, bottom: 48 },
      tooltip: { trigger: "item", confine: true, textStyle: { fontSize: 12 } },
      xAxis: {
        type: xLog ? "log" : "value",
        name: `${label}${filter.unit ? ` (${filter.unit})` : ""}`,
        nameLocation: "middle",
        nameGap: 30,
        min: bars[0]?.lo,
        max: bars[bars.length - 1]?.hi,
        scale: true,
        ...axisColors,
        axisLabel: { color: colors.text, formatter: (v: number) => formatValue(v) },
        splitLine: { show: false },
      },
      yAxis: { type: "value", name: "Records", minInterval: 1, nameGap: 12, ...axisColors },
      series: [
        {
          type: "custom",
          data: bars.map((bar) => [bar.lo, bar.hi, 0, bar.count]),
          encode: { x: [0, 1], y: [2, 3] },
          renderItem: (
            params: { dataIndex: number },
            chart: { value: (i: number) => number; coord: (p: number[]) => number[] },
          ) => {
            const [x0, y1] = chart.coord([chart.value(0), chart.value(3)]);
            const [x1, y0] = chart.coord([chart.value(1), chart.value(2)]);
            return {
              type: "rect",
              shape: { x: x0 + 0.5, y: y1, width: Math.max(1, x1 - x0 - 1), height: y0 - y1 },
              style: { fill: flags[params.dataIndex] ? color : colors.faded },
            };
          },
          tooltip: {
            formatter: (item: { value: number[] }) =>
              `${formatValue(item.value[0])} – ${formatValue(item.value[1])}${unit}: ${item.value[3].toLocaleString()}`,
          },
        },
      ],
    } as EChartsOption;
  }, [bars, flags, xLog, label, filter.unit, unit, color]);

  const changed = draft.gte !== initial.gte || draft.lte !== initial.lte;
  const apply = () => {
    const store = (v: string) => (v === "" ? "" : String(Number(v) * scale));
    onApply(
      anySelection ? [...others, `${field}:${store(draft.gte)}:${store(draft.lte)}`] : others,
    );
  };
  const rangeInput = (which: "gte" | "lte", placeholder: string) => (
    <input
      type="number"
      value={draft[which]}
      placeholder={placeholder}
      aria-label={`${label} ${which === "gte" ? "minimum" : "maximum"}`}
      onChange={(event) => setDraft({ ...draft, [which]: event.target.value })}
      className={cx(inputClass, "w-32")}
    />
  );
  const extent = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : formatValue(v / scale);

  return (
    <Modal
      open
      xl
      onClose={onClose}
      title={label}
      footer={
        <Footer
          onClear={() => setDraft({ gte: "", lte: "" })}
          clearDisabled={!anySelection}
          onCancel={onClose}
          onApply={apply}
          applyDisabled={!changed || !valid}
        />
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex cursor-pointer items-center gap-1 self-start text-node-ink hover:underline"
          >
            ← All number columns
          </button>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <fieldset className="m-0 inline-flex overflow-hidden rounded-sm border border-gray-300 p-0">
            <legend className="sr-only">Bin scale</legend>
            {SCALES.map(([value, name]) => (
              <button
                key={name}
                type="button"
                aria-pressed={log === value}
                disabled={value && data !== undefined && data.positive_min === null}
                title={value ? "Bins equal in log10 (values above zero)" : "Bins of equal width"}
                onClick={() => setLog(value)}
                className={cx(
                  "cursor-pointer px-2.5 py-1 disabled:cursor-default disabled:opacity-45",
                  log === value ? "bg-node font-bold text-white" : "bg-surface hover:bg-panel",
                )}
              >
                {name}
              </button>
            ))}
          </fieldset>
          <label className="flex items-center gap-1.5">
            <span className="text-ink-muted">Bins</span>
            <select
              value={bins}
              onChange={(event) => setBins(Number(event.target.value))}
              className="rounded-sm border border-gray-300 bg-surface px-1.5 py-1"
            >
              {BIN_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {data && data.counted > 0 && (
            <span className="text-ink-muted">
              {data.counted.toLocaleString()} of {data.total.toLocaleString()} records have a value,{" "}
              {extent(xLog ? data.positive_min : data.min)} to {extent(data.max)}
              {unit}
              {xLog && data.min !== null && data.min <= 0 && " (values ≤ 0 left out)"}
            </span>
          )}
        </div>
        <div className="relative rounded-sm border border-line" style={{ minHeight: 280 }}>
          {histogram.isPending && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-ink-muted">
              <Spinner /> Loading the distribution…
            </div>
          )}
          {histogram.error && (
            <div className="p-6 text-center text-red-700">Could not load the distribution.</div>
          )}
          {data && bars.length === 0 && (
            <div className="p-6 text-center font-bold text-ink-muted">
              No values for this search
            </div>
          )}
          {bars.length > 0 && (
            <EChart
              build={build}
              height={280}
              brush="lineX"
              zoom="x"
              onBrush={onBrush}
              onClick={onClick}
              label={`Distribution of ${label}`}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold">Between</span>
          {rangeInput("gte", data?.min != null ? extent(data.min) : "min")}
          <span>and</span>
          {rangeInput("lte", data?.max != null ? extent(data.max) : "max")}
          {filter.unit && <span className="text-ink-muted">{filter.unit}</span>}
          {anySelection && valid && selectedCount > 0 && (
            <span className="ml-auto text-ink-muted">
              ≈ {selectedCount.toLocaleString()} records in the selected bins
            </span>
          )}
          {!valid && (
            <span className="ml-auto text-red-700">The minimum is above the maximum.</span>
          )}
        </div>
        <p className="text-[12px] text-ink-muted">
          Drag across the histogram or click a bar to select whole bins; type a bound for an exact
          one. Leave a box empty for no limit.
        </p>
      </div>
    </Modal>
  );
}

// --- Number columns (the `numeric` filter's picker) ---------------------------

/** A data-model unit as a label: "Am^2" -> "Am²", Degrees -> °, none for Custom. */
function unitLabel(unit: string | undefined): string | null {
  if (!unit || /^(custom|dimensionless|flag)$/i.test(unit)) return null;
  if (/^degrees?$/i.test(unit)) return "°";
  return unit.replace(/\^2/g, "²").replace(/\^3/g, "³").replace(/\^-1/g, "⁻¹");
}

/** A number column's definition: the level table's, or (the contribution
 * level, whose docs union every level's) the first table's that has it. */
function columnDef(
  model: DataModel | null | undefined,
  table: string,
  column: string,
): DataModelColumn | undefined {
  if (!model) return undefined;
  const own = model.tables[table]?.columns[column];
  if (own) return own;
  return Object.values(model.tables).find((t) => t.columns[column])?.columns[column];
}

/**
 * A number column as a range filter (`summary._num.<column>`): a curated
 * range filter's label, unit and scale when the node has one on that column,
 * else the data model's label and unit (a unit conversion's base unit, years
 * BP, for the columns it converts).
 */
export function useNumberFilter(table: string): (field: string) => SearchFilter {
  const { data: config } = useNodeConfig();
  const { data: model } = useQuery({
    ...dataModelQuery(config?.data_model_latest ?? ""),
    enabled: !!config,
    select: unwrapModel,
  });
  return useCallback(
    (field: string) => {
      const curated = (config?.filters ?? []).find((f) => f.type === "range" && f.field === field);
      if (curated) return curated;
      const column = field.slice(NUMBER_PREFIX.length);
      const def = columnDef(model, table, column);
      return {
        type: "range",
        field,
        label: def?.label ?? column,
        levels: [],
        views: [],
        unit: config?.number_units?.[column] ?? unitLabel(def?.unit),
        scale: 1,
        min: null,
        max: null,
      };
    },
    [config, model, table],
  );
}

/** A range entry's bounds as a chip's text, in the filter's units. */
export function rangeText(filter: SearchFilter, entry: { gte: string; lte: string }): string {
  const scale = filter.scale || 1;
  const shown = (v: string) => (v === "" ? "" : formatValue(Number(v) / scale));
  const unit = filter.unit ? ` ${filter.unit}` : "";
  const [gte, lte] = [shown(entry.gte), shown(entry.lte)];
  return gte && lte ? `${gte} to ${lte}${unit}` : gte ? `≥ ${gte}${unit}` : `≤ ${lte}${unit}`;
}

/**
 * The `numeric` filter's column picker: the level's data-model number
 * columns, each with how many of the search's records have a value (those
 * without any hidden unless asked for), found by label, name or
 * description. Picking one opens its range (`onPick`).
 */
export function NumericModal({
  title,
  table,
  ranges,
  paramsFor,
  onPick,
  onClose,
}: {
  title: string;
  table: string;
  ranges: string[];
  /** The search's request params with these ranges. */
  paramsFor: (ranges: string[]) => SearchParams;
  onPick: (filter: SearchFilter) => void;
  onClose: () => void;
}) {
  const { data: config } = useNodeConfig();
  const { data: model } = useQuery({
    ...dataModelQuery(config?.data_model_latest ?? ""),
    enabled: !!config,
    select: unwrapModel,
  });
  const filterFor = useNumberFilter(table);
  const [find, setFind] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const params = paramsFor(ranges);
  const numbers = useQuery({
    queryKey: ["filter-modal-numbers", table, params],
    queryFn: () =>
      api<NumberColumns>(`/search/${table}/numbers`, { params: { ...params, size: undefined } }),
    staleTime: 60_000,
  });
  const applied = useMemo(
    () => new Map(ranges.map(parseRange).map((entry) => [entry.field, entry])),
    [ranges],
  );

  const needle = find.trim().toLowerCase();
  const all = useMemo(
    () =>
      Object.entries(numbers.data?.columns ?? {}).map(([column, count]) => {
        const def = columnDef(model, table, column);
        const field = `${NUMBER_PREFIX}${column}`;
        return { column, field, count, def, filter: filterFor(field) };
      }),
    [numbers.data, model, table, filterFor],
  );
  const empty = all.filter((row) => row.count === 0 && !applied.has(row.field)).length;
  const rows = all.filter(
    (row) =>
      (showEmpty || row.count > 0 || applied.has(row.field)) &&
      (!needle ||
        row.column.toLowerCase().includes(needle) ||
        (row.def?.label ?? "").toLowerCase().includes(needle) ||
        (row.def?.description ?? "").toLowerCase().includes(needle)),
  );

  return (
    <Modal
      open
      xl
      onClose={onClose}
      title={title}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder="Find a column by name or description"
            aria-label="Find a number column"
            className={cx(inputClass, "min-w-48 flex-1")}
          />
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showEmpty}
              onChange={() => setShowEmpty(!showEmpty)}
              className="h-4 w-4 accent-node"
            />
            Columns without values{empty > 0 ? ` (${empty})` : ""}
          </label>
        </div>
        <div
          className="min-h-40 overflow-y-auto rounded-sm border border-line"
          style={{ maxHeight: "55vh" }}
        >
          {numbers.isPending && (
            <div className="flex items-center justify-center gap-2 p-6 text-ink-muted">
              <Spinner /> Loading the columns…
            </div>
          )}
          {numbers.error && (
            <div className="p-4 text-center text-red-700">Could not load the columns.</div>
          )}
          {numbers.data && rows.length === 0 && (
            <div className="p-6 text-center font-bold text-ink-muted">
              {needle || !showEmpty ? "No matching columns with values" : "No number columns"}
            </div>
          )}
          {rows.map((row) => {
            const entry = applied.get(row.field);
            return (
              <button
                key={row.column}
                type="button"
                onClick={() => onPick(row.filter)}
                title={`Filter by ${row.filter.label ?? row.column}`}
                className={cx(
                  "flex w-full cursor-pointer items-start gap-2 border-b border-line/60 px-3 py-1.5 text-left last:border-b-0 hover:bg-node-soft",
                  entry && "bg-node-soft/60",
                  row.count === 0 && "text-ink-muted",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-bold">
                      <Highlight text={row.def?.label ?? row.column} needle={needle} />
                    </span>
                    <span className="font-mono text-[12px] text-ink-muted">
                      <Highlight text={row.column} needle={needle} />
                    </span>
                    {row.filter.unit && (
                      <span className="text-[12px] text-ink-muted">in {row.filter.unit}</span>
                    )}
                    {entry && (
                      <span className="rounded-sm bg-node-soft px-1.5 text-[12px] font-bold text-node-ink">
                        {rangeText(row.filter, entry)}
                      </span>
                    )}
                  </span>
                  {row.def?.description && (
                    <span className="text-[12px] text-ink-muted">
                      <Highlight text={row.def.description} needle={needle} />
                    </span>
                  )}
                </span>
                <CountBadge n={row.count} />
              </button>
            );
          })}
        </div>
        <div className="text-[12px] text-ink-muted">
          {rows.length.toLocaleString()} column{rows.length === 1 ? "" : "s"} shown · counts are the
          search's records with a value · choose one to filter by its range
        </div>
      </div>
    </Modal>
  );
}

// --- With / without data (the `exists` filter) ------------------------------------

/** The node's latest data model (shared with the data-model pages' fetch). */
export function useLatestDataModel(): DataModel | null | undefined {
  const { data: config } = useNodeConfig();
  const { data: model } = useQuery({
    ...dataModelQuery(config?.data_model_latest ?? ""),
    enabled: !!config,
    select: unwrapModel,
  });
  return model;
}

/** A with/without data tab's name: "Any Table", or the data model's label. */
export function existsTableLabel(model: DataModel | null | undefined, table: string): string {
  if (table === ANY_TABLE) return "Any Table";
  return model?.tables[table]?.label ?? facetTitle(table);
}

/** An applied with/without data entry as a chip's text: "With Sites: int_abs". */
export function hasText(model: DataModel | null | undefined, entry: HasEntry): string {
  return `${entry.without ? "Without" : "With"} ${existsTableLabel(model, entry.table)}: ${entry.column}`;
}

const SENSES: [boolean, string][] = [
  [false, "With data"],
  [true, "Without data"],
];
type ColumnSort = "model" | "count" | "name";

/**
 * The `exists` filter: a tab per table the level's records cover (Any Table
 * first) and a With / Without switch, listing the table's data-model columns
 * with how many of the search's records have (or lack) data in each, counted
 * for the search without this table's own choices. Ticked columns of one
 * table and sense are OR'd; each table and sense is a filter of its own,
 * and they AND (legacy "With … Data" / "Without … Data").
 */
export function ExistsModal({
  title,
  table,
  levelName,
  tabs,
  has,
  paramsFor,
  onApply,
  onClose,
}: {
  title: string;
  /** The search level's table, whose docs are counted. */
  table: string;
  /** The level's name (Sites), for the counts' hover text. */
  levelName: string;
  tabs: string[];
  /** The applied entries ("[!]<table>:<column>"). */
  has: string[];
  /** The search's request params with these entries. */
  paramsFor: (has: string[]) => SearchParams;
  onApply: (has: string[]) => void;
  onClose: () => void;
}) {
  const model = useLatestDataModel();
  const [draft, setDraft] = useState<HasEntry[]>(() => has.map(parseHas));
  // The first tab with a choice, in its sense; else Any Table, With.
  const first = draft.find((entry) => tabs.includes(entry.table));
  const [tab, setTab] = useState(first?.table ?? tabs[0] ?? "");
  const [without, setWithout] = useState(first?.without ?? false);
  const [find, setFind] = useState("");
  const [sortBy, setSortBy] = useState<ColumnSort>("model");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);

  // Counted without this table's own applied entries (either sense).
  const params = paramsFor(has.filter((entry) => parseHas(entry).table !== tab));
  const counts = useQuery({
    queryKey: ["filter-modal-has", table, tab, params],
    queryFn: () =>
      api<HasColumns>(`/search/${table}/has`, {
        params: { ...params, size: undefined, of: tab },
      }),
    enabled: !!tab,
    staleTime: 60_000,
  });

  const picked = useMemo(
    () =>
      new Set(
        draft
          .filter((entry) => entry.table === tab && entry.without === without)
          .map((entry) => entry.column),
      ),
    [draft, tab, without],
  );
  const needle = find.trim().toLowerCase();
  const tableLabel = existsTableLabel(model, tab);
  const records = levelName.toLowerCase();
  const record = singularize(levelName).toLowerCase();
  const all = useMemo(() => {
    const data = counts.data;
    const listed = Object.entries(data?.columns ?? {}).map(([column, n], position) => ({
      column,
      position,
      count: without ? (data?.with_table ?? 0) - n : n,
    }));
    // A ticked column the list lacks (kept from another level) stays, at zero.
    const seen = new Set(listed.map((row) => row.column));
    const extra = [...picked]
      .filter((column) => !seen.has(column))
      .map((column, i) => ({ column, position: listed.length + i, count: 0 }));
    return [...listed, ...extra].map((row) => ({
      ...row,
      def: columnDef(model, tab === ANY_TABLE ? "" : tab, row.column),
    }));
  }, [counts.data, without, picked, model, tab]);
  const empty = all.filter((row) => row.count === 0 && !picked.has(row.column)).length;
  const rows = all
    .filter((row) => showEmpty || row.count > 0 || picked.has(row.column))
    .filter((row) => !selectedOnly || picked.has(row.column))
    .filter(
      (row) =>
        !needle ||
        row.column.toLowerCase().includes(needle) ||
        (row.def?.label ?? "").toLowerCase().includes(needle) ||
        (row.def?.description ?? "").toLowerCase().includes(needle),
    )
    .sort((a, b) =>
      sortBy === "count"
        ? b.count - a.count || a.position - b.position
        : sortBy === "name"
          ? a.column.localeCompare(b.column)
          : a.position - b.position,
    );

  const toggle = (column: string) =>
    setDraft(
      picked.has(column)
        ? draft.filter(
            (entry) =>
              !(entry.table === tab && entry.without === without && entry.column === column),
          )
        : [...draft, { table: tab, column, without }],
    );
  const countOf = (table: string, sense?: boolean) =>
    draft.filter(
      (entry) => entry.table === table && (sense === undefined || entry.without === sense),
    ).length;
  const next = draft.map(formatHas);
  const changed = JSON.stringify([...next].sort()) !== JSON.stringify([...has].sort());
  const hover = (column: string, n: number) =>
    `${n.toLocaleString()} ${n === 1 ? record : records} ${
      without ? (n === 1 ? "does not have" : "do not have") : n === 1 ? "has" : "have"
    } data in the ${column} column of ${
      tab === ANY_TABLE ? "any table" : `the ${tableLabel} table`
    } and ${n === 1 ? "matches" : "match"} your search and other filters`;
  const loading = counts.isPending && !!tab;

  return (
    <Modal
      open
      xl
      onClose={onClose}
      title={title}
      footer={
        <Footer
          onClear={() => setDraft([])}
          clearDisabled={draft.length === 0}
          onCancel={onClose}
          onApply={() => onApply(next)}
          applyDisabled={!changed}
        />
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink">
        {tabs.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
            {tabs.map((name) => {
              const n = countOf(name);
              const active = name === tab;
              return (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(name)}
                  className={cx(
                    "-mb-px cursor-pointer rounded-t-sm border px-3 py-1.5",
                    active
                      ? "border-line border-b-surface bg-surface font-bold"
                      : "border-transparent text-ink-muted hover:text-node-ink",
                  )}
                >
                  {existsTableLabel(model, name)}
                  {n > 0 && (
                    <span className="ml-1.5 rounded-full bg-node px-[0.45em] text-[10px] font-bold text-white">
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {tab && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <fieldset className="m-0 inline-flex overflow-hidden rounded-sm border border-gray-300 p-0">
                <legend className="sr-only">With or without data</legend>
                {SENSES.map(([value, name]) => {
                  const n = countOf(tab, value);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={without === value}
                      title={
                        value
                          ? `${levelName} with the ${tableLabel} table but no data in a ticked column`
                          : `${levelName} with data in a ticked column`
                      }
                      onClick={() => setWithout(value)}
                      className={cx(
                        "cursor-pointer px-2.5 py-1",
                        without === value
                          ? "bg-node font-bold text-white"
                          : "bg-surface hover:bg-panel",
                      )}
                    >
                      {name}
                      {n > 0 && ` (${n})`}
                    </button>
                  );
                })}
              </fieldset>
              <input
                type="search"
                value={find}
                onChange={(event) => setFind(event.target.value)}
                placeholder="Find a column by name or description"
                aria-label={`Find ${tableLabel} columns`}
                className={cx(inputClass, "min-w-48 flex-1")}
              />
              <label className="flex items-center gap-1.5">
                <span className="text-ink-muted">Sort</span>
                <select
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value as ColumnSort)}
                  className="rounded-sm border border-gray-300 bg-surface px-1.5 py-1"
                >
                  <option value="model">Data model order</option>
                  <option value="count">Most records</option>
                  <option value="name">A–Z</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selectedOnly}
                  onChange={() => setSelectedOnly(!selectedOnly)}
                  className="h-4 w-4 accent-node"
                />
                Selected only
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showEmpty}
                  onChange={() => setShowEmpty(!showEmpty)}
                  className="h-4 w-4 accent-node"
                />
                Columns with no records{empty > 0 ? ` (${empty})` : ""}
              </label>
            </div>
            {picked.size > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {[...picked].map((column) => (
                  <Chip
                    key={column}
                    label={hasText(model, { table: tab, column, without })}
                    onRemove={() => toggle(column)}
                  />
                ))}
              </div>
            )}
            <div
              className="min-h-40 overflow-y-auto rounded-sm border border-line"
              style={{ maxHeight: "50vh" }}
            >
              {loading && (
                <div className="flex items-center justify-center gap-2 p-6 text-ink-muted">
                  <Spinner /> Loading the columns…
                </div>
              )}
              {counts.error && (
                <div className="p-4 text-center text-red-700">Could not load the columns.</div>
              )}
              {!loading && !counts.error && rows.length === 0 && (
                <div className="p-6 text-center font-bold text-ink-muted">
                  {needle || selectedOnly ? "No matching columns" : "No columns with records"}
                </div>
              )}
              {rows.map((row) => {
                const on = picked.has(row.column);
                return (
                  <label
                    key={row.column}
                    title={hover(row.def?.label ?? row.column, row.count)}
                    className={cx(
                      "flex cursor-pointer items-start gap-2 border-b border-line/60 px-3 py-1.5 last:border-b-0 hover:bg-node-soft",
                      on && "bg-node-soft/60",
                      row.count === 0 && "text-ink-muted",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(row.column)}
                      className="mt-[1px] h-4 w-4 shrink-0 cursor-pointer accent-node"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className={cx(on && "font-bold")}>
                          <Highlight text={row.def?.label ?? row.column} needle={needle} />
                        </span>
                        <span className="font-mono text-[12px] text-ink-muted">
                          <Highlight text={row.column} needle={needle} />
                        </span>
                      </span>
                      {row.def?.description && (
                        <span className="text-[12px] text-ink-muted">
                          <Highlight text={row.def.description} needle={needle} />
                        </span>
                      )}
                    </span>
                    <CountBadge n={row.count} />
                  </label>
                );
              })}
            </div>
            <div className="text-[12px] text-ink-muted">
              {rows.length.toLocaleString()} column{rows.length === 1 ? "" : "s"} shown · counts are
              the search's {records}{" "}
              {without ? `with the ${tableLabel} table but no data in` : "with data in"} each column
              {tab === ANY_TABLE ? " of any table" : ""}
              {counts.data && tab !== ANY_TABLE
                ? ` (${counts.data.with_table.toLocaleString()} of ${counts.data.total.toLocaleString()} have the table)`
                : ""}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// --- Geospatial -----------------------------------------------------------------

type Bounds = { west: string; south: string; east: string; north: string };
const boundsOf = (area: Area | null): Bounds =>
  area
    ? {
        west: formatValue(area[0]),
        south: formatValue(area[1]),
        east: formatValue(area[2]),
        north: formatValue(area[3]),
      }
    : { west: "", south: "", east: "", north: "" };
const areaOf = (b: Bounds): Area | null => {
  const values = [b.west, b.south, b.east, b.north].map((v) =>
    v.trim() === "" ? Number.NaN : Number(v),
  );
  if (!values.every(Number.isFinite)) return null;
  const [west, south, east, north] = values;
  if (south < -90 || north > 90 || south >= north || east <= west || east - west > 360) return null;
  return [west, south, east, north];
};

/**
 * The geospatial area: the search's records on a map (with a level that has
 * positions) where "Filter by area" adds an area to drag and resize, and its
 * bounds as numbers. Longitudes may run past ±180 across the antimeridian.
 */
export function GeoModal({
  title,
  level,
  query,
  ranges,
  filters,
  has,
  area,
  color,
  onApply,
  onClose,
}: {
  title: string;
  /** Its records are mapped when it has positions. */
  level: SearchLevel;
  query: string;
  ranges?: string[];
  filters?: string[];
  /** The with/without data filter's entries. */
  has?: string[];
  area: Area | null;
  color: string;
  onApply: (area: Area | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Area | null>(area);
  const [bounds, setBounds] = useState<Bounds>(boundsOf(area));
  const [request, setRequest] = useState<AreaRequest | null>(null);
  const fromMap = (next: Area | null) => {
    setDraft(next);
    setBounds(boundsOf(next));
  };
  const typed = (key: keyof Bounds, value: string) => {
    const next = { ...bounds, [key]: value };
    setBounds(next);
    const parsed = areaOf(next);
    if (parsed) setDraft(parsed);
  };
  const empty = Object.values(bounds).every((v) => v.trim() === "");
  const invalid = !empty && !areaOf(bounds);
  const changed = JSON.stringify(draft) !== JSON.stringify(area);
  const boundInput = (key: keyof Bounds, name: string, placeholder: string) => (
    <label className="flex items-center gap-1.5">
      <span className="w-12 text-ink-muted">{name}</span>
      <input
        type="number"
        value={bounds[key]}
        placeholder={placeholder}
        onChange={(event) => typed(key, event.target.value)}
        className={cx(inputClass, "w-28")}
      />
    </label>
  );

  return (
    <Modal
      open
      xl
      onClose={onClose}
      title={title}
      footer={
        <Footer
          onClear={() => fromMap(null)}
          clearDisabled={!draft && empty}
          onCancel={onClose}
          onApply={() => onApply(empty ? null : draft)}
          applyDisabled={invalid || (!changed && !(empty && area))}
        />
      }
    >
      <div className="flex flex-col gap-3 text-[13px] text-ink">
        {level.geo && (
          <div style={{ height: "52vh", minHeight: 320 }}>
            <SearchMap
              level={level}
              query={query}
              ranges={ranges}
              filters={filters}
              has={has}
              area={draft}
              onAreaChange={fromMap}
              areaRequest={request}
              onRequestArea={() => setRequest({})}
              onAreaRequestDone={() => setRequest(null)}
              onSelect={() => {}}
              color={color}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {boundInput("north", "North", "90")}
          {boundInput("south", "South", "-90")}
          {boundInput("west", "West", "-180")}
          {boundInput("east", "East", "180")}
          <button
            type="button"
            onClick={() => fromMap(WHOLE_GLOBE)}
            className="cursor-pointer text-node-ink hover:underline"
          >
            Whole globe
          </button>
        </div>
        {invalid ? (
          <p className="text-red-700">
            Give all four bounds in degrees: South below North (−90 to 90), West below East (East
            may pass 180 to cross the antimeridian).
          </p>
        ) : (
          <p className="text-[12px] text-ink-muted">
            {level.geo
              ? "Use Filter by area on the map, then drag the outline or its corners, or type the bounds."
              : "Type the bounds in degrees."}
          </p>
        )}
      </div>
    </Modal>
  );
}
