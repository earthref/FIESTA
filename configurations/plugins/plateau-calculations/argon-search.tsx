/**
 * The Specimens search level's Age Distribution: every matching specimen's
 * preferred age as a histogram and ideogram. The search is paged with only
 * the age fields (as the poles map pages its search), up to MAX_SPECIMENS.
 */
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { ErrorMessage } from "@/components/error-message";
import { useSize } from "@/components/plot-grid";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import type { SearchPage } from "@/lib/types";
import { getPath } from "@/lib/utils";
import type { PluginSubTabContext } from "@/plugins";
import { Ideogram } from "./argon-charts";
import { commonUnit, inUnit } from "./argon-summary";

const PAGE = 1000;
const MAX_SPECIMENS = 10_000;

/** A summary value: a number, or the first of a list (a specimen's rows). */
function numberOf(value: unknown): number | null {
  const first = Array.isArray(value) ? value[0] : value;
  const n = typeof first === "number" ? first : Number.parseFloat(String(first ?? ""));
  return Number.isFinite(n) ? n : null;
}

function textOf(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first == null || first === "" ? null : String(first);
}

export function AgeDistributionView({
  level,
  query,
  ranges,
  bbox,
  contribution,
  scope,
  privateKey,
}: PluginSubTabContext) {
  const table = level.table;
  const fields = ["specimen", "age", "age_sigma_analytical", "age_unit"].map(
    (name) => `summary.${table}.${name}`,
  );
  const params = {
    ...scope,
    query: query || undefined,
    range: ranges.length > 0 ? ranges : undefined,
    bbox: bbox || undefined,
    contribution,
    private_key: contribution ? privateKey : undefined,
    source: fields,
  };
  const search = useQuery({
    queryKey: [
      "plugin",
      "argon",
      "age-distribution",
      table,
      query,
      ranges,
      bbox,
      contribution,
      scope,
    ],
    queryFn: async () => {
      const first = await api<SearchPage>(`/search/${table}`, {
        params: { ...params, size: PAGE, from: 0 },
      });
      const results = [...first.results];
      const total = Math.min(first.total, MAX_SPECIMENS);
      for (let from = PAGE; from < total; from += PAGE) {
        const page = await api<SearchPage>(`/search/${table}`, {
          params: { ...params, size: PAGE, from },
        });
        results.push(...page.results);
      }
      return { total: first.total, results };
    },
    staleTime: 60_000,
  });
  // Always mounted, so its width is known once the ages arrive.
  const box = useRef<HTMLDivElement>(null);
  const { width } = useSize(box);
  return (
    <div ref={box} className="px-3 py-4">
      {search.isPending ? (
        <PageSpinner label="Loading the specimens' ages…" />
      ) : search.error ? (
        <ErrorMessage error={search.error} className="m-4" />
      ) : (
        <AgeDistribution data={search.data} table={table} width={width} />
      )}
    </div>
  );
}

function AgeDistribution({
  data,
  table,
  width,
}: {
  data: { total: number; results: SearchPage["results"] };
  table: string;
  width: number;
}) {
  const rows = data.results.flatMap((hit) => {
    const age = numberOf(getPath(hit, `summary.${table}.age`));
    if (age == null) return [];
    return [
      {
        name: textOf(getPath(hit, `summary.${table}.specimen`)) ?? "specimen",
        age,
        sigma: numberOf(getPath(hit, `summary.${table}.age_sigma_analytical`)),
        unit: textOf(getPath(hit, `summary.${table}.age_unit`)),
      },
    ];
  });
  const unit = commonUnit(rows.map((r) => r.unit));
  const items = rows.map((r) => ({ name: r.name, ...inUnit(r.age, r.sigma, r.unit, unit) }));
  const fetched = data.results.length;
  const plotWidth = Math.min(width, 900);
  return (
    <>
      <p className="mb-2 text-[13px] text-gray-700">
        {items.length.toLocaleString()} of {data.total.toLocaleString()} matching specimens have a
        preferred age
        {fetched < data.total && ` (the first ${fetched.toLocaleString()} matches are plotted)`}.
      </p>
      {items.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-gray-500">No ages to plot.</p>
      ) : (
        width > 0 && (
          <figure className="m-0" style={{ width: plotWidth }}>
            <Ideogram
              items={items}
              unit={unit}
              width={plotWidth}
              height={420}
              detailed
              withHistogram
              label="Age distribution of the matching specimens"
            />
            <figcaption className="mt-1 text-[12px] text-ink-faint">
              Histogram of the specimens' preferred ages, with their ideogram (each age ± σ as a
              normal curve, summed and scaled to the tallest bin)
              {items.length <= 2000 ? " and the ages as ticks" : ""}.
              {unit === "Ma" && new Set(rows.map((r) => r.unit ?? "Ma")).size > 1
                ? " Ages in other units are converted to Ma."
                : ""}
            </figcaption>
          </figure>
        )
      )}
    </>
  );
}
