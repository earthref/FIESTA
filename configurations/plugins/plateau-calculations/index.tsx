import { type ReactNode, useEffect, useRef } from "react";
import { ErrorMessage } from "@/components/error-message";
import { Cell, contributionId, NoDataCell } from "@/components/result-item";
import { PageSpinner, Spinner } from "@/components/ui/spinner";
import { useOpenContribution } from "@/lib/contribution-modal";
import type { NodeConfig, SearchResult } from "@/lib/types";
import { getPath } from "@/lib/utils";
import type { PluginGridCellProps, PluginModule } from "@/plugins";
import {
  type ArgonData,
  ageOf,
  ageText,
  type ContributedAge,
  type Experiment,
  hasIsochron,
  type Specimen,
  useArgon,
} from "./argon-data";
import { AgeSpectrum, Isochron, SpecimenSpectra, useSeriesColors } from "./argon-plots";

const TAB = "age-spectra";

/** The `plot` param that scrolls the tab to an experiment or a specimen. */
const experimentPlot = (name: string) => `e:${name}`;
const specimenPlot = (name: string) => `s:${name}`;

function nameOf(hit: SearchResult, table: string, column: string): string | undefined {
  const fromSummary = getPath(hit, `summary.${table}.${column}`);
  if (typeof fromSummary === "string" && fromSummary) return fromSummary;
  if (Array.isArray(fromSummary) && fromSummary.length > 0) return String(fromSummary[0]);
  const row = Array.isArray(hit.rows) ? hit.rows[0] : undefined;
  const value =
    row && typeof row === "object" ? (row as Record<string, unknown>)[column] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function levelsOption(config: NodeConfig, key: string): string[] {
  const levels = config.plugins["plateau-calculations"]?.[key];
  return Array.isArray(levels) ? levels.map(String) : [];
}

/** A grid tile: the plot, opening the modal tab at it. */
function PlotTile({
  id,
  privateKey,
  width,
  plot,
  label,
  query,
  render,
}: {
  id: string;
  privateKey?: string;
  width: number;
  plot: string;
  label: string;
  query: ReturnType<typeof useArgon>;
  render: (data: ArgonData) => ReactNode | null;
}) {
  const openContribution = useOpenContribution();
  if (query.isPending) {
    return (
      <Cell width={width}>
        <div className="flex h-[80px] items-center justify-center">
          <Spinner />
        </div>
      </Cell>
    );
  }
  const content = query.data ? render(query.data) : null;
  if (!content) return <NoDataCell label="Plot" width={width} />;
  return (
    <Cell width={width}>
      <button
        type="button"
        onClick={() => openContribution(id, TAB, undefined, { plot, privateKey })}
        aria-label={label}
        className="block cursor-pointer border border-gray-300 hover:border-node focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
      >
        {content}
      </button>
    </Cell>
  );
}

function ExperimentTile(props: {
  id: string;
  experiment: string;
  privateKey?: string;
  width: number;
}) {
  const query = useArgon(props.id, props.privateKey, { experiment: props.experiment });
  return (
    <PlotTile
      {...props}
      plot={experimentPlot(props.experiment)}
      label={`Open the age plots of ${props.experiment}`}
      query={query}
      render={(data) =>
        data.experiments[0] ? (
          <AgeSpectrum experiment={data.experiments[0]} width={props.width - 4} height={80} />
        ) : null
      }
    />
  );
}

function SpecimenTile(props: { id: string; specimen: string; privateKey?: string; width: number }) {
  const query = useArgon(props.id, props.privateKey, { specimen: props.specimen });
  return (
    <PlotTile
      {...props}
      plot={specimenPlot(props.specimen)}
      label={`Open the age plots of specimen ${props.specimen}`}
      query={query}
      render={(data) =>
        data.specimens[0] ? (
          <SpecimenSpectra
            specimen={data.specimens[0]}
            experiments={data.experiments}
            width={props.width - 4}
            height={80}
          />
        ) : null
      }
    />
  );
}

const KIND_LABEL: Record<ContributedAge["kind"], string> = {
  plateau: "Plateau",
  normal_isochron: "Normal isochron",
  inverse_isochron: "Inverse isochron",
  total_fusion: "Total fusion",
  other: "Other",
};

const num = (value: number | null, digits = 2) => (value == null ? "—" : value.toFixed(digits));

/** Every age contributed for the experiment, as the contributor reported it. */
function AgesTable({ experiment }: { experiment: Experiment }) {
  if (experiment.ages.length === 0) {
    return <p className="text-[13px] text-ink-faint">No ages contributed for this experiment.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="text-[12px]">
        <thead>
          <tr className="text-left text-ink-faint">
            {[
              "Method",
              "Age",
              "MSWD",
              "Steps",
              "³⁹Ar (%)",
              "⁴⁰Ar/³⁹Ar",
              "⁴⁰Ar/³⁶Ar",
              "Preferred",
            ].map((heading) => (
              <th key={heading} className="pr-4 font-normal">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {experiment.ages.map((age, i) => (
            <tr key={`${age.method}-${i}`}>
              <td className="pr-4">{age.method ?? KIND_LABEL[age.kind]}</td>
              <td className="pr-4 whitespace-nowrap">
                {ageText(age.age, age.age_sigma, age.age_unit ?? experiment.age_unit)}
              </td>
              <td className="pr-4">{num(age.mswd)}</td>
              <td className="pr-4">{age.n ?? (age.steps.length || "—")}</td>
              <td className="pr-4">{num(age.plateau_width, 1)}</td>
              <td className="pr-4">{num(age.ar40_ar39, 3)}</td>
              <td className="pr-4">{num(age.ar40_ar36 ?? age.trapped_ar40_ar36, 1)}</td>
              <td className="pr-4">{age.preferred == null ? "—" : age.preferred ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the spectrum shows and what it lacks, in words. */
function spectrumNotes(experiment: Experiment): string[] {
  const notes: string[] = [];
  const plateau = ageOf(experiment, "plateau");
  if (!plateau) notes.push("No plateau age contributed.");
  else {
    const names = new Set(experiment.steps.map((s) => s.measurement));
    const missing = plateau.steps.filter((name) => !names.has(name)).length;
    if (plateau.steps.length === 0) notes.push("The plateau's steps are not listed.");
    else if (missing > 0)
      notes.push(
        `${missing} of the plateau's ${plateau.steps.length} listed steps are not among this experiment's measurements.`,
      );
  }
  if (!experiment.ar39_source) notes.push("Step widths are equal: no ³⁹Ar amounts contributed.");
  if (experiment.steps_without_age > 0)
    notes.push(`${experiment.steps_without_age} steps have no contributed age and are left out.`);
  return notes;
}

const ISOCHRON_NAME = { inverse: "Inverse isochron", normal: "Normal isochron" };

/** The isochron's contributed age and what the plot lacks, in words. */
function isochronCaption(experiment: Experiment, kind: "normal" | "inverse"): string {
  const age = ageOf(experiment, kind === "normal" ? "normal_isochron" : "inverse_isochron");
  const points = experiment.steps.some((s) => s[kind]);
  const parts = [ISOCHRON_NAME[kind]];
  if (!age) parts.push("(no isochron age contributed).");
  else {
    parts[0] += `: ${ageText(age.age, age.age_sigma, age.age_unit ?? experiment.age_unit)}`;
    if (age.mswd != null) parts[0] += `, MSWD ${age.mswd.toFixed(2)}`;
    if (age.ar40_ar36 != null)
      parts[0] += `, ⁴⁰Ar/³⁶Ar intercept ${age.ar40_ar36.toFixed(1)}${age.ar40_ar36_sigma != null ? ` ± ${age.ar40_ar36_sigma.toFixed(1)}` : ""}`;
    parts[0] += ".";
  }
  if (points) parts.push("1σ error ellipses; hollow = steps not used.");
  if (age && (age.ar40_ar39 == null || age.ar40_ar36 == null))
    parts.push("No isochron intercepts contributed, so no line.");
  if (!points) parts.push("No corrected isochron ratios contributed, so no points.");
  return parts.join(" ");
}

/** Isochron ages the experiment reports but has nothing to plot for. */
function unplottedIsochrons(experiment: Experiment): string[] {
  return (["inverse", "normal"] as const).flatMap((kind) =>
    ageOf(experiment, kind === "normal" ? "normal_isochron" : "inverse_isochron") &&
    !hasIsochron(experiment, kind)
      ? [
          `${ISOCHRON_NAME[kind]} not plotted: no corrected isochron ratios or intercepts contributed.`,
        ]
      : [],
  );
}

/** A plot and its caption, as wide as the plot (narrower screens scroll it). */
function PlotFigure({
  caption,
  width,
  children,
}: {
  caption: string;
  width: number;
  children: ReactNode;
}) {
  return (
    <figure className="m-0 max-w-full" style={{ width }}>
      <div className="overflow-x-auto">{children}</div>
      <figcaption className="mt-1 text-[12px] text-ink-faint">{caption}</figcaption>
    </figure>
  );
}

function ExperimentPanel({ experiment, selected }: { experiment: Experiment; selected?: boolean }) {
  const ref = useScrollIntoView(selected);
  const plateau = ageOf(experiment, "plateau");
  const notes = spectrumNotes(experiment);
  const plateauCaption = plateau
    ? `Plateau: ${ageText(plateau.age, plateau.age_sigma, plateau.age_unit ?? experiment.age_unit)}` +
      (plateau.mswd != null ? `, MSWD ${plateau.mswd.toFixed(2)}` : "") +
      (plateau.plateau_width != null ? `, ${plateau.plateau_width.toFixed(1)}% ³⁹Ar` : "")
    : "";
  return (
    <section ref={ref} className="mb-6 border-b border-gray-200 pb-4">
      <h4 className="mb-2 text-[13px] font-bold">Experiment {experiment.experiment}</h4>
      {experiment.steps.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No heating steps for this experiment.</p>
      ) : (
        <div className="flex flex-wrap gap-4">
          <PlotFigure width={480} caption={[plateauCaption, ...notes].filter(Boolean).join(" ")}>
            <AgeSpectrum experiment={experiment} width={480} height={300} detailed />
          </PlotFigure>
          {(["inverse", "normal"] as const).map((kind) =>
            hasIsochron(experiment, kind) ? (
              <PlotFigure key={kind} width={300} caption={isochronCaption(experiment, kind)}>
                <Isochron experiment={experiment} kind={kind} width={300} height={300} />
              </PlotFigure>
            ) : null,
          )}
        </div>
      )}
      {experiment.steps.length > 0 &&
        unplottedIsochrons(experiment).map((note) => (
          <p key={note} className="mt-1 text-[12px] text-ink-faint">
            {note}
          </p>
        ))}
      <div className="mt-3">
        <AgesTable experiment={experiment} />
      </div>
    </section>
  );
}

function SpecimenLegend({ experiments }: { experiments: Experiment[] }) {
  const colors = useSeriesColors(experiments.length);
  return (
    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-faint">
      {experiments.map((experiment, i) => {
        const plateau = ageOf(experiment, "plateau");
        return (
          <li key={experiment.experiment} className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-4" style={{ background: colors[i] }} />
            {experiment.experiment}
            {plateau?.age != null &&
              ` (plateau ${ageText(plateau.age, plateau.age_sigma, plateau.age_unit ?? experiment.age_unit)})`}
          </li>
        );
      })}
    </ul>
  );
}

function SpecimenSection({
  specimen,
  experiments,
  plot,
}: {
  specimen: Specimen;
  experiments: Experiment[];
  plot?: string;
}) {
  const ref = useScrollIntoView(plot === specimenPlot(specimen.specimen));
  const details = [specimen.material, specimen.sample && `sample ${specimen.sample}`]
    .filter(Boolean)
    .join(", ");
  return (
    <section ref={ref} className="mb-8">
      <h3 className="mb-1 text-[14px] font-bold">
        Specimen {specimen.specimen}
        {details && <span className="font-normal text-ink-faint"> · {details}</span>}
      </h3>
      <p className="mb-2 text-[13px]">
        Preferred age {ageText(specimen.age, specimen.age_sigma, specimen.age_unit)}
        {specimen.method && ` (${specimen.method})`}
      </p>
      {experiments.length > 1 && (
        <div className="mb-4">
          <PlotFigure
            width={520}
            caption="Its experiments' age spectra; the dashed line and band are the specimen's preferred age."
          >
            <SpecimenSpectra
              specimen={specimen}
              experiments={experiments}
              width={520}
              height={300}
              detailed
            />
          </PlotFigure>
          <SpecimenLegend experiments={experiments} />
        </div>
      )}
      <div className="pl-3">
        {experiments.map((experiment) => (
          <ExperimentPanel
            key={experiment.experiment}
            experiment={experiment}
            selected={plot === experimentPlot(experiment.experiment)}
          />
        ))}
      </div>
    </section>
  );
}

function useScrollIntoView(selected?: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "start" });
  }, [selected]);
  return ref;
}

/** The contribution modal's tab: every specimen and its experiments' plots,
 * then the experiments no specimen lists. */
function AgePlotsTab({ id, privateKey, plot }: { id: string; privateKey?: string; plot?: string }) {
  const query = useArgon(id, privateKey);
  if (query.isPending) return <PageSpinner label="Loading the age data…" />;
  if (query.error) return <ErrorMessage error={query.error} className="m-4" />;
  const byName = new Map(query.data.experiments.map((e) => [e.experiment, e]));
  const listed = new Set(query.data.specimens.flatMap((s) => s.experiments));
  const loose = query.data.experiments.filter((e) => !listed.has(e.experiment));
  return (
    <div className="p-4 sm:p-6">
      {query.data.specimens.map((specimen) => (
        <SpecimenSection
          key={specimen.specimen}
          specimen={specimen}
          experiments={specimen.experiments.flatMap((name) => byName.get(name) ?? [])}
          plot={plot}
        />
      ))}
      {loose.length > 0 && (
        <section>
          {query.data.specimens.length > 0 && (
            <h3 className="mb-2 text-[14px] font-bold">Experiments not listed by a specimen</h3>
          )}
          {loose.map((experiment) => (
            <ExperimentPanel
              key={experiment.experiment}
              experiment={experiment}
              selected={plot === experimentPlot(experiment.experiment)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** The search table the tab counts: the first experiment level's. */
function experimentTable(config: NodeConfig): string | undefined {
  const names = levelsOption(config, "experiment_levels");
  return config.search_levels.find((level) => names.includes(level.name))?.table;
}

const plateauPlugin: PluginModule = {
  contributionTabs(config) {
    const table = experimentTable(config);
    if (!table) return [];
    return [
      {
        key: TAB,
        label: "Age Plots",
        countTable: table,
        render: ({ id, privateKey, plot }) => (
          <AgePlotsTab id={id} privateKey={privateKey} plot={plot} />
        ),
      },
    ];
  },
  // The summary grid's plot tile: an experiment's age spectrum, or a
  // specimen's experiments under its preferred age.
  gridCell(props: PluginGridCellProps) {
    if (props.column.cell !== "plot") return null;
    const id = contributionId(props.hit);
    if (!id) return null;
    const common = { id, privateKey: props.privateKey, width: props.column.width };
    if (levelsOption(props.config, "experiment_levels").includes(props.level.name)) {
      const experiment = nameOf(props.hit, props.level.table, "experiment");
      return experiment ? <ExperimentTile {...common} experiment={experiment} /> : null;
    }
    if (levelsOption(props.config, "specimen_levels").includes(props.level.name)) {
      const specimen = nameOf(props.hit, props.level.table, "specimen");
      return specimen ? <SpecimenTile {...common} specimen={specimen} /> : null;
    }
    return null;
  },
};

export default plateauPlugin;
