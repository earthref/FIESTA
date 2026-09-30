import { useQuery } from "@tanstack/react-query";
import { ErrorMessage } from "../../components/error-message";
import { Cell, contributionId, NoDataCell } from "../../components/result-item";
import { PageSpinner, Spinner } from "../../components/ui/spinner";
import { api } from "../../lib/api";
import { useOpenContribution } from "../../lib/contribution-modal";
import type { NodeConfig, SearchPage, SearchResult } from "../../lib/types";
import { getPath } from "../../lib/utils";
import type { PluginGridCellProps, PluginModule } from "../index";

interface AgeStep {
  step: number | string;
  temperature?: number;
  age: number;
  age_sigma: number;
  cum_ar39: number;
}

interface PlateauInfo {
  plateau_steps: number | (number | string)[];
  plateau_age: number;
  plateau_age_sigma: number;
  mswd: number;
  ar39_percent: number;
}

interface PlateauResponse {
  age_data: AgeStep[];
  plateau: PlateauInfo | null;
}

function experimentNameOf(hit: SearchResult): string | undefined {
  const fromSummary = getPath(hit, "summary.experiments.experiment");
  if (typeof fromSummary === "string" && fromSummary) return fromSummary;
  if (Array.isArray(fromSummary) && fromSummary.length > 0) return String(fromSummary[0]);
  const rows = hit.rows;
  if (Array.isArray(rows) && rows[0] && typeof rows[0] === "object") {
    const experiment = (rows[0] as Record<string, unknown>).experiment;
    if (typeof experiment === "string" && experiment) return experiment;
  }
  return undefined;
}

function plateauStepSet(plateau: PlateauInfo | null): Set<string> {
  if (!plateau || !Array.isArray(plateau.plateau_steps)) return new Set();
  return new Set(plateau.plateau_steps.map(String));
}

/** Shared age-spectrum geometry: X = cumulative 39Ar %, Y = age ± 1σ steps. */
function AgeSpectrum({
  data,
  width,
  height,
  detailed,
}: {
  data: PlateauResponse;
  width: number;
  height: number;
  detailed?: boolean;
}) {
  const steps = [...data.age_data].sort((a, b) => a.cum_ar39 - b.cum_ar39);
  if (steps.length === 0) return null;

  const pad = detailed
    ? { left: 48, right: 12, top: 12, bottom: 34 }
    : { left: 2, right: 2, top: 2, bottom: 2 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const ages = steps.flatMap((step) => [step.age - step.age_sigma, step.age + step.age_sigma]);
  if (data.plateau) {
    ages.push(
      data.plateau.plateau_age - data.plateau.plateau_age_sigma,
      data.plateau.plateau_age + data.plateau.plateau_age_sigma,
    );
  }
  let yMin = Math.min(...ages);
  let yMax = Math.max(...ages);
  const yPad = (yMax - yMin || 1) * 0.05;
  yMin -= yPad;
  yMax += yPad;

  const x = (cum: number) => pad.left + (Math.min(100, Math.max(0, cum)) / 100) * innerW;
  const y = (age: number) => pad.top + ((yMax - age) / (yMax - yMin)) * innerH;

  const inPlateau = plateauStepSet(data.plateau);

  let prevCum = 0;
  const rects = steps.map((step) => {
    const x0 = x(prevCum);
    const x1 = x(step.cum_ar39);
    prevCum = step.cum_ar39;
    const isPlateau = inPlateau.has(String(step.step));
    return (
      <rect
        key={`step-${step.step}`}
        x={x0}
        y={y(step.age + step.age_sigma)}
        width={Math.max(0.5, x1 - x0)}
        height={Math.max(0.5, y(step.age - step.age_sigma) - y(step.age + step.age_sigma))}
        fill={isPlateau ? "#e6f2ff" : "#e5e7eb"}
        stroke={isPlateau ? "#0066cc" : "#9ca3af"}
        strokeWidth={detailed ? 1 : 0.5}
      >
        {detailed && (
          <title>
            Step {step.step}
            {step.temperature !== undefined ? ` (${step.temperature}°)` : ""}: {step.age.toFixed(2)}{" "}
            ± {step.age_sigma.toFixed(2)} Ma at {step.cum_ar39.toFixed(1)}% ³⁹Ar
          </title>
        )}
      </rect>
    );
  });

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Age spectrum plot"
      className="bg-white"
    >
      {data.plateau && (
        <rect
          x={pad.left}
          y={y(data.plateau.plateau_age + data.plateau.plateau_age_sigma)}
          width={innerW}
          height={Math.max(
            0.5,
            y(data.plateau.plateau_age - data.plateau.plateau_age_sigma) -
              y(data.plateau.plateau_age + data.plateau.plateau_age_sigma),
          )}
          fill="rgba(100,150,200,0.1)"
        />
      )}
      {rects}
      {data.plateau && (
        <line
          x1={pad.left}
          y1={y(data.plateau.plateau_age)}
          x2={pad.left + innerW}
          y2={y(data.plateau.plateau_age)}
          stroke="#cc3300"
          strokeWidth={detailed ? 1.5 : 1}
        />
      )}
      {detailed && (
        <>
          <line
            x1={pad.left}
            y1={pad.top + innerH}
            x2={pad.left + innerW}
            y2={pad.top + innerH}
            stroke="#6b7280"
          />
          <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + innerH} stroke="#6b7280" />
          {[0, 25, 50, 75, 100].map((tick) => (
            <text
              key={`x-${tick}`}
              x={x(tick)}
              y={pad.top + innerH + 14}
              textAnchor="middle"
              fontSize={10}
              fill="#6b7280"
            >
              {tick}
            </text>
          ))}
          <text
            x={pad.left + innerW / 2}
            y={height - 6}
            textAnchor="middle"
            fontSize={11}
            fill="#374151"
          >
            Cumulative ³⁹Ar (%)
          </text>
          {[yMin + yPad, (yMin + yMax) / 2, yMax - yPad].map((tick) => (
            <text
              key={`y-${tick}`}
              x={pad.left - 6}
              y={y(tick) + 3}
              textAnchor="end"
              fontSize={10}
              fill="#6b7280"
            >
              {tick.toFixed(1)}
            </text>
          ))}
          <text
            x={12}
            y={pad.top + innerH / 2}
            transform={`rotate(-90 12 ${pad.top + innerH / 2})`}
            textAnchor="middle"
            fontSize={11}
            fill="#374151"
          >
            Age (Ma)
          </text>
        </>
      )}
    </svg>
  );
}

function plateauCaption(data: PlateauResponse): string {
  const plateau = data.plateau;
  if (!plateau) return "No plateau identified";
  const steps = Array.isArray(plateau.plateau_steps)
    ? plateau.plateau_steps.length
    : plateau.plateau_steps;
  return `Plateau age: ${plateau.plateau_age.toFixed(2)} ± ${plateau.plateau_age_sigma.toFixed(2)} Ma (MSWD ${plateau.mswd.toFixed(2)}, ${steps} steps, ${plateau.ar39_percent.toFixed(1)}% ³⁹Ar)`;
}

function usePlateau(id: string, experiment: string, privateKey?: string) {
  return useQuery({
    queryKey: ["plugin", "plateau", id, experiment, privateKey],
    queryFn: () =>
      api<PlateauResponse>(
        `/plugins/plateau-calculations/contributions/${id}/experiments/${encodeURIComponent(experiment)}/plateau`,
        { params: { private_key: privateKey } },
      ),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

function PlateauCell({
  id,
  experiment,
  privateKey,
  width,
}: {
  id: string;
  experiment: string;
  privateKey?: string;
  width: number;
}) {
  const openContribution = useOpenContribution();
  const query = usePlateau(id, experiment, privateKey);

  if (query.isPending) {
    return (
      <Cell width={width}>
        <div className="flex h-[80px] items-center justify-center">
          <Spinner />
        </div>
      </Cell>
    );
  }

  if (query.error || !query.data || query.data.age_data.length === 0) {
    return <NoDataCell label="Plateau" width={width} />;
  }

  return (
    <Cell width={width}>
      <button
        type="button"
        onClick={() => openContribution(id, "age-spectra")}
        aria-label={`Open the age spectra, including ${experiment}`}
        className="block cursor-pointer border border-gray-300 hover:border-node focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
      >
        <AgeSpectrum data={query.data} width={width - 4} height={80} />
      </button>
    </Cell>
  );
}

/** One experiment's detailed age spectrum and plateau, in the modal's tab. */
function PlateauPanel({
  id,
  experiment,
  privateKey,
}: {
  id: string;
  experiment: string;
  privateKey?: string;
}) {
  const query = usePlateau(id, experiment, privateKey);
  return (
    <section className="mb-6 border-b border-gray-200 pb-4">
      <h3 className="mb-2 text-[13px] font-bold">{experiment}</h3>
      {query.isPending ? (
        <Spinner />
      ) : query.error || !query.data || query.data.age_data.length === 0 ? (
        <p className="text-[13px] text-[#AAAAAA]">No age data for this experiment.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <AgeSpectrum data={query.data} width={640} height={420} detailed />
          </div>
          <p className="mt-2 text-[13px] text-gray-700">{plateauCaption(query.data)}</p>
        </>
      )}
    </section>
  );
}

/** The contribution modal's Age Spectra tab: every experiment's spectrum. */
function AgeSpectraTab({
  id,
  privateKey,
  table,
}: {
  id: string;
  privateKey?: string;
  table: string;
}) {
  const experiments = useQuery({
    queryKey: ["plugin", "plateau", "experiments", id, table, privateKey],
    queryFn: () =>
      api<SearchPage>(`/search/${table}`, {
        params: { contribution: id, private_key: privateKey || undefined, size: 1000 },
      }),
    staleTime: 5 * 60 * 1000,
  });
  if (experiments.isPending) return <PageSpinner label="Loading experiments…" />;
  if (experiments.error) return <ErrorMessage error={experiments.error} className="m-4" />;
  const names = [
    ...new Set(experiments.data.results.flatMap((hit) => experimentNameOf(hit) ?? [])),
  ];
  return (
    <div className="p-4 sm:p-6">
      {names.map((experiment) => (
        <PlateauPanel key={experiment} id={id} experiment={experiment} privateKey={privateKey} />
      ))}
    </div>
  );
}

/** The search table of the first level the plugin is enabled on. */
function plateauTable(config: NodeConfig): string | undefined {
  const levels = config.plugins["plateau-calculations"]?.levels;
  const names = Array.isArray(levels) ? levels.map(String) : [];
  return config.search_levels.find((level) => names.includes(level.name))?.table;
}

export const plateauPlugin: PluginModule = {
  contributionTabs(config) {
    const table = plateauTable(config);
    if (!table) return [];
    return [
      {
        key: "age-spectra",
        label: "Age Spectra",
        countTable: table,
        render: ({ id, privateKey }) => (
          <AgeSpectraTab id={id} privateKey={privateKey} table={table} />
        ),
      },
    ];
  },
  // The summary grid's plot tile: the experiment's age spectrum.
  gridCell(props: PluginGridCellProps) {
    if (props.column.cell !== "plot") return null;
    const levels = props.config.plugins["plateau-calculations"]?.levels;
    const enabled = Array.isArray(levels) ? levels.map(String) : [];
    if (!enabled.includes(props.level.name)) return null;
    const experiment = experimentNameOf(props.hit);
    const id = contributionId(props.hit);
    if (!experiment || !id) return null;
    return (
      <PlateauCell
        id={id}
        experiment={experiment}
        privateKey={props.privateKey}
        width={props.column.width}
      />
    );
  },
};
