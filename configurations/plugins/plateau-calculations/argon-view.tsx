/**
 * The contribution modal's three age plot tabs, laid out as pmag-plots lays
 * out MagIC's: the selected plot large, and every plot as a card to pick from
 * (`@/components/plot-grid`). Experiment Age Plots: an experiment's spectrum
 * with its K/Ca, ⁴⁰Ar* and Cl/K spectra, isochrons, release curve and
 * contributed ages. Specimen Age Plots: a specimen's experiments' spectra,
 * ranked ages and ideogram under its preferred age. Contribution Age Plots:
 * the specimens' ages together, against their section, and J against
 * irradiation position.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ErrorMessage } from "@/components/error-message";
import { PlotCard, PlotFilter, PlotLayout, useSize } from "@/components/plot-grid";
import { PageSpinner } from "@/components/ui/spinner";
import { useOpenContribution } from "@/lib/contribution-modal";
import {
  COMPANIONS,
  type DatedItem,
  hasReleaseCurve,
  hasSeries,
  Ideogram,
  RankedAges,
  ReleaseCurve,
  StepValueSpectrum,
  XYErrorPlot,
} from "./argon-charts";
import {
  type ArgonData,
  ageOf,
  ageText,
  type ContributedAge,
  type Experiment,
  experimentAge,
  hasIsochron,
  type Specimen,
  useArgon,
} from "./argon-data";
import { AgeSpectrum, Isochron, SpecimenSpectra, useSeriesColors } from "./argon-plots";
import { inUnit, type SummaryPlot, summaryPlots } from "./argon-summary";

/** The tabs' keys (the `tab` search param); a tile opens one at its plot. */
export const EXPERIMENT_TAB = "experiment-age-plots";
export const SPECIMEN_TAB = "specimen-age-plots";
export const CONTRIBUTION_TAB = "contribution-age-plots";

/** Each tab's selected plot's height with its header, captions and table,
 * which decides whether the cards go beside it or below. */
const LARGE_HEIGHT = { experiment: 1000, specimen: 900, contribution: 560 };
/** The cards' charts: wider than tall, as the spectra are. */
const CARD_MIN_WIDTH = 200;
const CARD_ASPECT = 0.6;

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

/** A plot and its caption, as wide as the plot. */
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
      {children}
      <figcaption className="mt-1 text-[12px] text-ink-faint">{caption}</figcaption>
    </figure>
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

// --- the tabs' plots ---------------------------------------------------------------------

/** One plot of a tab: an experiment's or a specimen's. */
interface Item {
  key: string;
  title: string;
  where: string;
  /** Lower-cased names the filter matches. */
  names: string;
}

const names = (...values: (string | null | undefined)[]) =>
  values.filter(Boolean).join(" ").toLowerCase();

/** The experiments a specimen lists, by name. */
function experimentsOf(specimen: Specimen, byName: Map<string, Experiment>): Experiment[] {
  return specimen.experiments.flatMap((name) => byName.get(name) ?? []);
}

/** The experiments in the specimens' order, then those no specimen lists. */
function orderedExperiments(data: ArgonData): Experiment[] {
  const byName = new Map(data.experiments.map((e) => [e.experiment, e]));
  const listed = data.specimens.flatMap((s) => experimentsOf(s, byName));
  return [...new Set([...listed, ...data.experiments])];
}

const specimenWhere = (specimen: Specimen) =>
  [specimen.material, specimen.sample && `sample ${specimen.sample}`].filter(Boolean).join(", ");

const hasSteps = (experiments: Experiment[]) => experiments.some((e) => e.steps.length > 0);

/** A card's chart, or a note in its place when there is nothing to draw. */
function CardChart({
  size,
  chart,
  note,
}: {
  size: { width: number; height: number };
  chart: ReactNode;
  note: string;
}) {
  return chart ? (
    chart
  ) : (
    <span
      className="flex items-center justify-center text-[12px] text-ink-faint"
      style={{ width: size.width, height: size.height }}
    >
      {note}
    </span>
  );
}

/** The selected plot's frame: its name, where it is from and its place in
 * the list, over `children`, which get the frame's inner width. */
function SelectedFrame({
  item,
  position,
  children,
}: {
  item: Item;
  position: string;
  children: (width: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useSize(ref);
  return (
    <section className="rounded-sm border border-gray-300 bg-surface">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-gray-200 px-3 py-2">
        <h4 className="text-[14px] font-bold text-gray-900">{item.title}</h4>
        <span className="text-[12px] text-gray-500">{item.where}</span>
        <span className="ml-auto text-[12px] text-gray-500">{position}</span>
      </header>
      <div className="p-3">
        <div ref={ref}>{width > 0 && children(width)}</div>
      </div>
    </section>
  );
}

/**
 * The tab's state and layout: the filter, the selected item (`?plot=`, or
 * the first shown) and the cards.
 */
function AgePlotGrid({
  items,
  selected,
  onSelect,
  legend,
  filterLabel,
  largeHeight,
  renderLarge,
  renderCard,
}: {
  items: Item[];
  selected?: string;
  onSelect?: (key: string) => void;
  legend: string;
  largeHeight: number;
  filterLabel: string;
  renderLarge: (item: Item, width: number) => ReactNode;
  renderCard: (item: Item, size: { width: number; height: number }) => ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState(selected);
  // A new `?plot=` while the tab is open (another Plot tile clicked).
  useEffect(() => {
    if (selected) setChosen(selected);
  }, [selected]);
  const needle = filter.trim().toLowerCase();
  const shown = needle ? items.filter((item) => item.names.includes(needle)) : items;
  // The chosen plot, or the first shown when it is filtered out.
  const index = Math.max(
    0,
    shown.findIndex((item) => item.key === chosen),
  );
  const current = shown[index];
  const choose = (item: Item) => {
    setChosen(item.key);
    onSelect?.(item.key);
  };
  return (
    <PlotLayout
      header={
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <PlotFilter
              value={filter}
              onChange={(next) => {
                setFilter(next);
                scroller.current?.scrollTo({ top: 0 });
              }}
              label={filterLabel}
              shown={shown.length}
              total={items.length}
            />
          </div>
          <p className="text-[12px] text-gray-500">{legend}</p>
        </>
      }
      large={
        current && (
          <SelectedFrame
            key={current.key}
            item={current}
            position={`${index + 1} of ${shown.length}`}
          >
            {(width) => renderLarge(current, width)}
          </SelectedFrame>
        )
      }
      count={shown.length}
      index={index}
      scrollRef={scroller}
      largeHeight={largeHeight}
      cardMinWidth={CARD_MIN_WIDTH}
      cardAspect={CARD_ASPECT}
      empty={items.length === 0 ? "Nothing to plot." : "No plots match the filter."}
      renderCard={(i, size) => {
        const item = shown[i];
        return (
          <PlotCard
            key={item.key}
            title={item.title}
            tooltip={[item.title, item.where].filter(Boolean).join(" · ")}
            selected={item.key === current?.key}
            onSelect={() => choose(item)}
          >
            {renderCard(item, size)}
          </PlotCard>
        );
      }}
    />
  );
}

/** An experiment drawn large: its spectrum and isochrons, what they lack,
 * and every age contributed for it. */
function ExperimentDetail({ experiment, width }: { experiment: Experiment; width: number }) {
  const plateau = ageOf(experiment, "plateau");
  const notes = spectrumNotes(experiment);
  const plateauCaption = plateau
    ? `Plateau: ${ageText(plateau.age, plateau.age_sigma, plateau.age_unit ?? experiment.age_unit)}` +
      (plateau.mswd != null ? `, MSWD ${plateau.mswd.toFixed(2)}` : "") +
      (plateau.plateau_width != null ? `, ${plateau.plateau_width.toFixed(1)}% ³⁹Ar` : "")
    : "";
  const spectrumWidth = Math.min(width, 640);
  const isochronWidth = Math.min(width, 320);
  const companions = COMPANIONS.filter((series) => hasSeries(experiment, series));
  return (
    <>
      {experiment.steps.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No heating steps for this experiment.</p>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          {/* The spectrum and its companions share the ³⁹Ar axis. */}
          <PlotFigure
            width={spectrumWidth}
            caption={[
              plateauCaption,
              ...notes,
              companions.length > 0 &&
                `Below: each step's contributed ${companions.map((s) => s.label).join(", ")} on the same ³⁹Ar axis${companions.some((s) => s.key === "cl_k") ? " (³⁸Ar(Cl)/³⁹Ar(K) is proportional to Cl/K)" : ""}.`,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <AgeSpectrum experiment={experiment} width={spectrumWidth} height={320} detailed />
            {companions.map((series) => (
              <StepValueSpectrum
                key={series.key}
                experiment={experiment}
                series={series}
                width={spectrumWidth}
                height={120}
                detailed
              />
            ))}
          </PlotFigure>
          {(["inverse", "normal"] as const).map((kind) =>
            hasIsochron(experiment, kind) ? (
              <PlotFigure
                key={kind}
                width={isochronWidth}
                caption={isochronCaption(experiment, kind)}
              >
                <Isochron
                  experiment={experiment}
                  kind={kind}
                  width={isochronWidth}
                  height={isochronWidth}
                />
              </PlotFigure>
            ) : null,
          )}
          {hasReleaseCurve(experiment) && (
            <PlotFigure
              width={isochronWidth}
              caption="Release curve: the ³⁹Ar released by the end of each heating step, against its temperature."
            >
              <ReleaseCurve experiment={experiment} width={isochronWidth} height={isochronWidth} />
            </PlotFigure>
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
    </>
  );
}

/** The unit a specimen's comparison plots use: its own, else its experiments'. */
function specimenUnit(specimen: Specimen, experiments: Experiment[]): string {
  return (
    specimen.age_unit ??
    experiments.map((e) => experimentAge(e)?.age_unit ?? e.age_unit).find(Boolean) ??
    "Ma"
  );
}

/** Each experiment's contributed age (experimentAge), in `unit`. */
function experimentAges(experiments: Experiment[], unit: string): DatedItem[] {
  return experiments.flatMap((e) => {
    const age = experimentAge(e);
    if (age?.age == null) return [];
    return [
      {
        name: e.experiment,
        ...inUnit(age.age, age.age_sigma, age.age_unit ?? e.age_unit, unit),
      },
    ];
  });
}

const specimenReference = (specimen: Specimen, unit: string) =>
  specimen.age != null
    ? inUnit(specimen.age, specimen.age_sigma, specimen.age_unit, unit)
    : undefined;

/** Whether SpecimenThumbnail draws anything: steps, or ages to rank. */
export const hasThumbnail = (experiments: Experiment[]) =>
  hasSteps(experiments) || experiments.some((e) => experimentAge(e)?.age != null);

/** A specimen small (a card, a search grid tile): its experiments' spectra,
 * else (total fusions, no steps) their ages ranked, else nothing. */
export function SpecimenThumbnail({
  specimen,
  experiments,
  width,
  height,
}: {
  specimen: Specimen;
  experiments: Experiment[];
  width: number;
  height: number;
}) {
  if (hasSteps(experiments))
    return (
      <SpecimenSpectra
        specimen={specimen}
        experiments={experiments}
        width={width}
        height={height}
      />
    );
  const unit = specimenUnit(specimen, experiments);
  const ages = experimentAges(experiments, unit);
  if (ages.length === 0) return null;
  return (
    <RankedAges
      items={ages}
      unit={unit}
      reference={specimenReference(specimen, unit)}
      width={width}
      height={height}
      label={`Ranked experiment ages of specimen ${specimen.specimen}`}
    />
  );
}

/** A specimen drawn large: its preferred age, its experiments' spectra under
 * it, their ages ranked and as an ideogram, and a link to each experiment's
 * own plots. */
function SpecimenDetail({
  id,
  specimen,
  experiments,
  width,
}: {
  id: string;
  specimen: Specimen;
  experiments: Experiment[];
  width: number;
}) {
  const openContribution = useOpenContribution();
  const plotWidth = Math.min(width, 720);
  const halfWidth = width >= 2 * 340 + 16 ? Math.min(Math.floor((width - 16) / 2), 440) : plotWidth;
  const drawn = hasSteps(experiments);
  const unit = specimenUnit(specimen, experiments);
  const ages = experimentAges(experiments, unit);
  const reference = specimenReference(specimen, unit);
  return (
    <>
      <p className="mb-2 text-[13px]">
        Preferred age {ageText(specimen.age, specimen.age_sigma, specimen.age_unit)}
        {specimen.method && ` (${specimen.method})`}
      </p>
      {experiments.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No experiments are linked to this specimen.</p>
      ) : !drawn ? (
        <p className="text-[13px] text-ink-faint">Its experiments have no heating steps.</p>
      ) : (
        <PlotFigure
          width={plotWidth}
          caption="Its experiments' age spectra; the dashed line and band are the specimen's preferred age."
        >
          <SpecimenSpectra
            specimen={specimen}
            experiments={experiments}
            width={plotWidth}
            height={340}
            detailed
          />
          <SpecimenLegend experiments={experiments} />
        </PlotFigure>
      )}
      {ages.length > 0 && (
        <div className="mt-4 flex flex-wrap items-start gap-4">
          <PlotFigure
            width={halfWidth}
            caption={`Each experiment's contributed age (its preferred one, else its plateau) ± 1σ, youngest first; the dashed line and band are the specimen's preferred age.${ages.length < experiments.length ? ` ${experiments.length - ages.length} of its experiments have no contributed age.` : ""}`}
          >
            <RankedAges
              items={ages}
              unit={unit}
              reference={reference}
              width={halfWidth}
              height={260}
              detailed
              label={`Ranked experiment ages of specimen ${specimen.specimen}`}
            />
          </PlotFigure>
          <PlotFigure
            width={halfWidth}
            caption={
              ages.some((a) => a.sigma)
                ? "Ideogram: the sum of the experiments' age curves (each age ± σ as a normal curve), each one faint, the ages as ticks."
                : "Ideogram: no σ contributed with these ages, so only their ticks."
            }
          >
            <Ideogram
              items={ages}
              unit={unit}
              reference={reference}
              width={halfWidth}
              height={260}
              detailed
              label={`Ideogram of specimen ${specimen.specimen}`}
            />
          </PlotFigure>
        </div>
      )}
      {experiments.length > 0 && (
        <div className="mt-3 text-[13px]">
          <span className="font-bold text-gray-700">Experiments: </span>
          {experiments.map((experiment, i) => (
            <span key={experiment.experiment}>
              {i > 0 && ", "}
              <button
                type="button"
                className="cursor-pointer text-node-ink underline-offset-2 hover:underline"
                // Within the modal: the search keeps a `private_key` it has,
                // and the owner's own key is never written into the URL.
                onClick={() =>
                  openContribution(id, EXPERIMENT_TAB, undefined, { plot: experiment.experiment })
                }
              >
                {experiment.experiment}
              </button>
            </span>
          ))}
          <span className="text-ink-faint"> (their isochrons and ages)</span>
        </div>
      )}
    </>
  );
}

interface TabProps {
  id: string;
  privateKey?: string;
  plot?: string;
  onPlot?: (plot: string | undefined) => void;
}

/** Experiment Age Plots: an experiment's spectrum, isochrons and ages. */
export function ExperimentAgePlots({ id, privateKey, plot, onPlot }: TabProps) {
  const query = useArgon(id, privateKey);
  const experiments = useMemo(
    () => (query.data ? orderedExperiments(query.data) : []),
    [query.data],
  );
  const byName = useMemo(() => new Map(experiments.map((e) => [e.experiment, e])), [experiments]);
  const sampleOf = useMemo(
    () => new Map(query.data?.specimens.map((s) => [s.specimen, s.sample]) ?? []),
    [query.data],
  );
  const items = useMemo(
    () =>
      experiments.map((e) => ({
        key: e.experiment,
        title: e.experiment,
        where: e.specimen ? `specimen ${e.specimen}` : "",
        names: names(e.experiment, e.specimen, e.specimen && sampleOf.get(e.specimen)),
      })),
    [experiments, sampleOf],
  );
  if (query.isPending) return <PageSpinner label="Loading the age data…" />;
  if (query.error) return <ErrorMessage error={query.error} className="m-4" />;
  return (
    <AgePlotGrid
      items={items}
      selected={plot}
      onSelect={onPlot}
      legend="Age spectrum: each step's contributed age ± σ over the ³⁹Ar it released; the plateau's steps are filled, its age ± σ the band; under it, the steps' K/Ca, ⁴⁰Ar* and Cl/K · isochrons: 1σ error ellipses, hollow = steps not used · release curve: ³⁹Ar released against temperature"
      filterLabel="Filter plots by experiment, specimen or sample"
      largeHeight={LARGE_HEIGHT.experiment}
      renderLarge={(item, width) => {
        const experiment = byName.get(item.key);
        return experiment ? <ExperimentDetail experiment={experiment} width={width} /> : null;
      }}
      renderCard={(item, size) => {
        const experiment = byName.get(item.key);
        return (
          <CardChart
            size={size}
            note="No heating steps"
            chart={
              experiment &&
              hasSteps([experiment]) && (
                <AgeSpectrum experiment={experiment} width={size.width} height={size.height} />
              )
            }
          />
        );
      }}
    />
  );
}

/** Specimen Age Plots: a specimen's experiments under its preferred age. */
export function SpecimenAgePlots({ id, privateKey, plot, onPlot }: TabProps) {
  const query = useArgon(id, privateKey);
  const byName = useMemo(
    () => new Map(query.data?.experiments.map((e) => [e.experiment, e]) ?? []),
    [query.data],
  );
  const specimens = useMemo(
    () => new Map(query.data?.specimens.map((s) => [s.specimen, s]) ?? []),
    [query.data],
  );
  const items = useMemo(
    () =>
      [...specimens.values()].map((s) => ({
        key: s.specimen,
        title: s.specimen,
        where: specimenWhere(s),
        names: names(s.specimen, s.sample, ...s.experiments),
      })),
    [specimens],
  );
  if (query.isPending) return <PageSpinner label="Loading the age data…" />;
  if (query.error) return <ErrorMessage error={query.error} className="m-4" />;
  return (
    <AgePlotGrid
      items={items}
      selected={plot}
      onSelect={onPlot}
      legend="Each experiment's age spectrum in its own colour, then their ages ranked and as an ideogram; the dashed line and band are the specimen's preferred age ± σ"
      filterLabel="Filter plots by specimen, sample or experiment"
      largeHeight={LARGE_HEIGHT.specimen}
      renderLarge={(item, width) => {
        const specimen = specimens.get(item.key);
        return specimen ? (
          <SpecimenDetail
            id={id}
            specimen={specimen}
            experiments={experimentsOf(specimen, byName)}
            width={width}
          />
        ) : null;
      }}
      renderCard={(item, size) => {
        const specimen = specimens.get(item.key);
        const experiments = specimen ? experimentsOf(specimen, byName) : [];
        return (
          <CardChart
            size={size}
            note={experiments.length ? "No heating steps or ages" : "No experiments"}
            chart={
              specimen &&
              hasThumbnail(experiments) && (
                <SpecimenThumbnail
                  specimen={specimen}
                  experiments={experiments}
                  width={size.width}
                  height={size.height}
                />
              )
            }
          />
        );
      }}
    />
  );
}

/** A contribution-wide plot, large (`detailed`) or as a card. */
function SummaryChart({
  plot,
  width,
  height,
  detailed,
}: {
  plot: SummaryPlot;
  width: number;
  height: number;
  detailed?: boolean;
}) {
  return plot.kind === "ages" ? (
    <Ideogram
      items={plot.items}
      unit={plot.unit}
      width={width}
      height={height}
      detailed={detailed}
      withHistogram
      label={plot.title}
    />
  ) : (
    <XYErrorPlot
      points={plot.points}
      xLabel={plot.xLabel}
      yLabel={plot.yLabel}
      reverseY={plot.reverseY}
      width={width}
      height={height}
      detailed={detailed}
      label={plot.title}
    />
  );
}

function summaryCaption(plot: SummaryPlot): string {
  if (plot.kind === "xy") return plot.caption;
  const withSigma = plot.items.filter((d) => d.sigma).length;
  return (
    "Histogram of the specimens' preferred ages, with their ideogram (each age ± σ as a normal curve, summed and scaled to the tallest bin) and the ages as ticks." +
    (withSigma < plot.items.length
      ? ` ${plot.items.length - withSigma} ages have no σ and are in the histogram only.`
      : "")
  );
}

/** How many contribution-wide plots there are (the tab's count). */
export const summaryCount = (data: ArgonData) => summaryPlots(data).length;

/** Contribution Age Plots: the specimens' ages together, against their
 * samples' section, and J against irradiation position. */
export function ContributionAgePlots({ id, privateKey, plot, onPlot }: TabProps) {
  const query = useArgon(id, privateKey);
  const plots = useMemo(() => (query.data ? summaryPlots(query.data) : []), [query.data]);
  const byKey = useMemo(() => new Map(plots.map((p) => [p.key, p])), [plots]);
  const items = useMemo(
    () => plots.map((p) => ({ key: p.key, title: p.title, where: p.where, names: names(p.title) })),
    [plots],
  );
  if (query.isPending) return <PageSpinner label="Loading the age data…" />;
  if (query.error) return <ErrorMessage error={query.error} className="m-4" />;
  return (
    <AgePlotGrid
      items={items}
      selected={plot}
      onSelect={onPlot}
      legend="The contribution's specimens together: their ages as a histogram and ideogram, against their samples' elevation, height or depth, and their J values against irradiation position"
      filterLabel="Filter plots by name"
      largeHeight={LARGE_HEIGHT.contribution}
      renderLarge={(item, width) => {
        const p = byKey.get(item.key);
        if (!p) return null;
        const w = Math.min(width, 720);
        return (
          <PlotFigure width={w} caption={summaryCaption(p)}>
            <SummaryChart plot={p} width={w} height={400} detailed />
          </PlotFigure>
        );
      }}
      renderCard={(item, size) => {
        const p = byKey.get(item.key);
        return (
          <CardChart
            size={size}
            note="Nothing to plot"
            chart={p && <SummaryChart plot={p} width={size.width} height={size.height} />}
          />
        );
      }}
    />
  );
}
