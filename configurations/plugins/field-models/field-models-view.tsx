// The Field Models view: GEOMAGIA's field-model pages as a search sub-tab.
// Pick models, locations (manual or the search's site locations, optionally
// their medians) and years; plot intensity/VADM, declination and
// inclination/ΔI with uncertainty bands, ensembles and the search's
// measurements; animate the global field; export the predictions.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as echarts from "echarts/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EChart } from "@/components/echart";
import { ErrorMessage } from "@/components/error-message";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { usePlotColors } from "@/lib/plot-colors";
import type { NodeConfig, SearchScope } from "@/lib/types";
import { cx } from "@/lib/utils";
import {
  COMPONENTS,
  type Component,
  chartStatus,
  curveOption,
  modelColor,
} from "./field-models-charts";
import {
  ageWindow,
  type Catalog,
  type CurveRequest,
  type CurveResult,
  dataUrlBytes,
  type EnsembleResponse,
  type FieldModelsConfig,
  measurements as measurementsFrom,
  mergeEnsembles,
  predictionFiles,
  regionColors,
  save,
  siteRows,
  timestamp,
  valueFields,
  zip,
} from "./field-models-data";
import GlobalMaps from "./global-maps";

interface SearchValues {
  total: number;
  fields: string[];
  rows: (number | string | null)[][];
  truncated?: boolean;
}

export interface FieldModelsViewProps {
  node: NodeConfig;
  config: FieldModelsConfig;
  query: string;
  ranges: string[];
  bbox?: string;
  scope?: SearchScope;
}

const PLUGIN = "/plugins/field-models";
const EMPTY = new Set<string>();
const label = "text-[13px] font-bold text-gray-700";
const input =
  "w-24 rounded-sm border border-gray-300 bg-surface px-1.5 py-1 text-[13px] text-gray-900";
const smallButton =
  "rounded-sm border border-gray-300 bg-surface px-2 py-1 text-[13px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50";

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message);
    try {
      const parsed = JSON.parse(message);
      if (parsed?.detail) return String(parsed.detail);
    } catch {
      /* not JSON */
    }
    return message;
  }
  return String(error);
}

export default function FieldModelsView({
  node,
  config,
  query,
  ranges,
  bbox,
  scope,
}: FieldModelsViewProps) {
  const table = config.table ?? "sites";
  const fields = useMemo(() => valueFields(table, config.columns), [table, config.columns]);
  const catalog = useQuery({
    queryKey: ["plugin", "field-models", "catalog", node.slug],
    queryFn: () => api<Catalog>(`${PLUGIN}/catalog`),
    staleTime: 300_000,
  });
  const values = useQuery({
    queryKey: ["plugin", "field-models", "values", node.slug, query, ranges, bbox, scope],
    queryFn: () =>
      api<SearchValues>(`/search/${table}/values`, {
        params: {
          ...scope,
          field: fields,
          query: query || undefined,
          range: ranges.length ? ranges : undefined,
          bbox: bbox || undefined,
        },
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const sites = useMemo(() => (values.data ? siteRows(values.data.rows) : []), [values.data]);
  const records = useMemo(
    () => (values.data ? measurementsFrom(values.data.rows) : []),
    [values.data],
  );
  const colorsByRegion = useMemo(() => regionColors(records), [records]);

  // --- The form ---------------------------------------------------------------------
  const defaults = config.defaults;
  const [search] = useState(() => ageWindow(ranges, table, config.columns));
  const [models, setModels] = useState<string[]>(defaults.models);
  const [source, setSource] = useState<"database" | "manual" | null>(null);
  const [latitude, setLatitude] = useState(String(defaults.latitude));
  const [longitude, setLongitude] = useState(String(defaults.longitude));
  const [altitude, setAltitude] = useState(String(defaults.altitude));
  const [useMedian, setUseMedian] = useState(false);
  const [startYear, setStartYear] = useState(String(search[0] ?? defaults.start_year));
  const [endYear, setEndYear] = useState(String(search[1] ?? defaults.end_year));
  const [step, setStep] = useState(String(defaults.step));
  const [showLegacy, setShowLegacy] = useState(false);
  const hasSites = sites.length > 0;
  const locationSource = source ?? (hasSites ? "database" : "manual");

  // --- Display ------------------------------------------------------------------------
  const [intensityMode, setIntensityMode] = useState<"intensity" | "vadm">("intensity");
  const [inclinationMode, setInclinationMode] = useState<"incl" | "delta_incl">("incl");
  const [showData, setShowData] = useState(true);
  const [showErrors, setShowErrors] = useState(true);
  const [showEnsemble, setShowEnsemble] = useState(false);
  const [tab, setTab] = useState<"curves" | "global">("curves");
  const [cursorYear, setCursorYear] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Record<string, Set<string>>>({});

  // --- Results ------------------------------------------------------------------------
  const [result, setResult] = useState<CurveResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ensembleStatus, setEnsembleStatus] = useState<string>("");
  const [exportStatus, setExportStatus] = useState<string>("");

  const order = useMemo(
    () => (catalog.data ? Object.keys(catalog.data.models) : []),
    [catalog.data],
  );

  const request = useCallback((): CurveRequest => {
    const body: CurveRequest = {
      models,
      location_source: locationSource,
      altitude: Number(altitude),
      sites: locationSource === "database" ? sites : [],
      use_median: useMedian,
      start_year: Number(startYear),
      end_year: Number(endYear),
      step: Number(step),
    };
    if (locationSource === "manual") {
      body.latitude = Number(latitude);
      body.longitude = Number(longitude);
    }
    return body;
  }, [
    models,
    locationSource,
    altitude,
    sites,
    useMedian,
    startYear,
    endYear,
    step,
    latitude,
    longitude,
  ]);

  const plot = async () => {
    setError(null);
    setEnsembleStatus("");
    if (!models.length) {
      setError("Select at least one field model.");
      return;
    }
    setBusy("Calculating model curves…");
    try {
      const body = request();
      const data = await api<Omit<CurveResult, "request">>(`${PLUGIN}/curves`, { json: body });
      setResult({ ...data, request: body });
      setHidden({});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // Ensemble SDs (when a model's uncertainty comes from its ensemble) and members.
  const ensembleModels = useMemo(
    () =>
      result && catalog.data
        ? result.request.models.filter((m) => catalog.data.models[m]?.ensemble_count)
        : [],
    [result, catalog.data],
  );
  const needsMembers = showEnsemble && result && !result.ensembleMembers;
  const needsSd = showErrors && result && !result.ensembleUncertainty;
  const loadingEnsembles = useRef(false);
  useEffect(() => {
    if (!result || !ensembleModels.length || loadingEnsembles.current) return;
    if (!needsMembers && !needsSd) return;
    const members = Boolean(needsMembers);
    loadingEnsembles.current = true;
    setEnsembleStatus(
      members
        ? "Calculating all supplied ensemble members…"
        : "Calculating uncertainty from the supplied ensembles…",
    );
    api<EnsembleResponse>(`${PLUGIN}/ensembles`, {
      json: { ...result.request, models: ensembleModels, include_members: members },
    })
      .then((response) => {
        setResult((current) =>
          current === result ? mergeEnsembles(result, response, members) : current,
        );
        setEnsembleStatus(
          `${ensembleModels
            .map(
              (m) =>
                `${m}: ${catalog.data?.models[m].ensemble_count} ${catalog.data?.models[m].ensemble_kind} members`,
            )
            .join(" · ")}. Bands show ±1 sample standard deviation.`,
        );
      })
      .catch((e) => {
        setEnsembleStatus(errorText(e));
        if (members) setShowEnsemble(false);
      })
      .finally(() => {
        loadingEnsembles.current = false;
      });
  }, [result, ensembleModels, needsMembers, needsSd, catalog.data]);

  // Re-run with the median toggled, keeping the rest (GEOMAGIA's live toggle).
  const toggleMedian = (next: boolean) => {
    setUseMedian(next);
    if (result?.location_source === "database") {
      const body = { ...result.request, use_median: next };
      setBusy("Calculating model curves…");
      api<Omit<CurveResult, "request">>(`${PLUGIN}/curves`, { json: body })
        .then((data) => setResult({ ...data, request: body }))
        .catch((e) => {
          setError(errorText(e));
          setUseMedian(!next);
        })
        .finally(() => setBusy(null));
    }
  };

  const components: Component[] = [
    COMPONENTS[intensityMode],
    COMPONENTS.decl,
    COMPONENTS[inclinationMode],
  ];

  // --- Exports ------------------------------------------------------------------------
  const exportData = () => {
    if (!result) return;
    const stamp = timestamp();
    const files = predictionFiles(result, stamp, {
      prefix: node.slug,
      site: node.key,
      showEnsemble,
      inclinationMode,
      intensityMode,
      hidden: Object.entries(hidden).flatMap(([plot, set]) => [...set].map((m) => `${plot}:${m}`)),
    });
    save(zip(files), `${node.slug}_model_data_${stamp}.zip`);
    setExportStatus("Downloaded model prediction files and calculation details.");
  };

  const exportGraphs = async () => {
    if (!result) return;
    const stamp = timestamp();
    const figures: Component[] = [
      COMPONENTS.intensity,
      COMPONENTS.vadm,
      COMPONENTS.decl,
      COMPONENTS[inclinationMode],
    ];
    const files = [];
    for (const component of figures) {
      setExportStatus(`Preparing ${component.label} PNG…`);
      const div = document.createElement("div");
      const width = 1200;
      const height = 760;
      Object.assign(div.style, {
        width: `${width}px`,
        height: `${height}px`,
        position: "fixed",
        left: "-10000px",
      });
      document.body.appendChild(div);
      try {
        const chart = echarts.init(div, undefined, { width, height, renderer: "canvas" });
        chart.setOption(
          curveOption(
            {
              result,
              component,
              order,
              hidden: hidden[component.key] ?? EMPTY,
              measurements: showData ? records : null,
              regionColors: colorsByRegion,
              showErrors,
              showEnsemble,
              exportTitle: `${node.key} — ${component.label}`,
            },
            { width, height },
          ),
        );
        files.push({
          name: `${node.slug}_models_${component.key}_${stamp}.png`,
          data: dataUrlBytes(
            chart.getDataURL({ type: "png", pixelRatio: 3, backgroundColor: "#ffffff" }),
          ),
        });
        chart.dispose();
      } finally {
        div.remove();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    save(zip(files), `${node.slug}_model_graphs_${stamp}.zip`);
    setExportStatus(
      `Downloaded four model graphs (Intensity, VADM, Declination and ${inclinationMode === "delta_incl" ? "ΔI" : "Inclination"}).`,
    );
  };

  if (catalog.isLoading) return <PageSpinner label="Loading field models…" />;
  if (catalog.error) return <ErrorMessage error={catalog.error} className="my-3" />;
  const cat = catalog.data as Catalog;
  if (!cat.installed) {
    return (
      <div className="space-y-2 py-8 text-center text-[13px] text-gray-600">
        <p>No field models are installed for {node.key} yet.</p>
        <p className="text-gray-500">
          An operator fetches them from their public sources with the field-models plugin's
          fetch_models.py.
        </p>
      </div>
    );
  }

  const selected = models.filter((m) => cat.models[m]);
  const intervalNote = selected
    .map((m) => `${m}: ${cat.models[m].start} to ${cat.models[m].end}`)
    .join(" · ");

  return (
    <div className="space-y-3 py-2 text-[13px]">
      <section className="rounded-sm border border-gray-300 bg-surface">
        <header className="flex flex-wrap items-baseline gap-x-3 border-b border-gray-200 px-3 py-2">
          <h4 className="text-[14px] font-bold text-gray-900">Field models</h4>
          <span className="text-gray-500">
            Predictions from published spherical-harmonic models; no extrapolation beyond each
            model's interval.
          </span>
        </header>
        <div className="grid grid-cols-1 gap-4 px-3 py-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <fieldset className="min-w-0">
            <legend className={label}>Models</legend>
            <div className="mt-1 max-h-72 space-y-2 overflow-y-auto pr-1">
              {cat.groups.map((group) => {
                const legacy = group.label === "Legacy models";
                if (legacy && !showLegacy && !group.models.some((m) => models.includes(m))) {
                  return (
                    <button
                      key={group.label}
                      type="button"
                      className="text-node-ink underline"
                      onClick={() => setShowLegacy(true)}
                    >
                      Show legacy models ({group.models.length})
                    </button>
                  );
                }
                return (
                  <div key={group.label}>
                    <div className="text-[12px] font-bold text-gray-500">{group.label}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {group.models.map((name) => {
                        const m = cat.models[name];
                        return (
                          <label
                            key={name}
                            className="flex items-center gap-1.5"
                            title={`${m.citation}\nTerms: ${m.terms}`}
                          >
                            <input
                              type="checkbox"
                              checked={models.includes(name)}
                              onChange={(e) =>
                                setModels((prev) =>
                                  e.target.checked
                                    ? [...prev, name]
                                    : prev.filter((n) => n !== name),
                                )
                              }
                            />
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ background: modelColor(name, order) }}
                            />
                            <span className="text-gray-800">{m.label}</span>
                            {m.has_uncertainty && (
                              <span
                                className="text-[11px] text-gray-500"
                                title="Uncertainty available"
                              >
                                ±{m.ensemble_count ? ` (${m.ensemble_count})` : ""}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            {Object.keys(cat.unavailable).length > 0 && (
              <p className="mt-2 text-[12px] text-gray-500">
                Not available (no public source):{" "}
                {Object.entries(cat.unavailable).map(([name, why], i) => (
                  <span key={name} title={why}>
                    {i > 0 && ", "}
                    {name}
                  </span>
                ))}
                .
              </p>
            )}
          </fieldset>
          <div className="min-w-0 space-y-3">
            <fieldset>
              <legend className={label}>Locations</legend>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="field-models-source"
                    checked={locationSource === "database"}
                    disabled={!hasSites}
                    onChange={() => setSource("database")}
                  />
                  Search site locations
                  <span className="text-gray-500">
                    {values.isFetching
                      ? "(updating…)"
                      : `(${sites.length.toLocaleString()} distinct)`}
                  </span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="field-models-source"
                    checked={locationSource === "manual"}
                    onChange={() => setSource("manual")}
                  />
                  Geographic parameters
                </label>
              </div>
              {locationSource === "database" ? (
                <label className="mt-1 flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={useMedian}
                    onChange={(e) => toggleMedian(e.target.checked)}
                  />
                  Use median search locations (one per intensity and direction group)
                </label>
              ) : (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1">
                    Lat °N
                    <input
                      className={input}
                      type="number"
                      step="any"
                      min={-90}
                      max={90}
                      value={latitude}
                      onChange={(e) => setLatitude(e.target.value)}
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    Lon °E
                    <input
                      className={input}
                      type="number"
                      step="any"
                      min={-180}
                      max={360}
                      value={longitude}
                      onChange={(e) => setLongitude(e.target.value)}
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    Alt km
                    <input
                      className={input}
                      type="number"
                      step="any"
                      min={-1}
                      max={100}
                      value={altitude}
                      onChange={(e) => setAltitude(e.target.value)}
                    />
                  </label>
                </div>
              )}
            </fieldset>
            <fieldset>
              <legend className={label}>Years (BCE − / CE +)</legend>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">
                  From
                  <input
                    className={input}
                    type="number"
                    step="any"
                    value={startYear}
                    onChange={(e) => setStartYear(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-1">
                  to
                  <input
                    className={input}
                    type="number"
                    step="any"
                    value={endYear}
                    onChange={(e) => setEndYear(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-1">
                  every
                  <input
                    className={cx(input, "w-16")}
                    type="number"
                    step="any"
                    min={1}
                    value={step}
                    onChange={(e) => setStep(e.target.value)}
                  />
                  years
                </label>
              </div>
              {intervalNote && <p className="mt-1 text-[12px] text-gray-500">{intervalNote}</p>}
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-sm bg-node px-3 py-1.5 text-[13px] font-bold text-white hover:bg-node-dark disabled:opacity-50"
                disabled={Boolean(busy) || !selected.length}
                onClick={plot}
              >
                Plot models
              </button>
              {busy && <span className="text-gray-500">{busy}</span>}
              {values.data?.truncated && (
                <span className="text-gray-500">
                  The search has more than 50,000 sites; the first 50,000 are used.
                </span>
              )}
            </div>
            {error && <p className="text-red-700">{error}</p>}
          </div>
        </div>
      </section>

      {result && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div
              className="inline-flex overflow-hidden rounded-sm border border-gray-300"
              role="tablist"
            >
              {(["curves", "global"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={cx(
                    "px-3 py-1 font-bold",
                    tab === t ? "bg-node text-white" : "bg-surface text-gray-700 hover:bg-gray-50",
                  )}
                  onClick={() => setTab(t)}
                >
                  {t === "curves" ? "Through time" : "Global field"}
                </button>
              ))}
            </div>
            <Toggle
              options={[
                ["intensity", "Intensity"],
                ["vadm", "VADM"],
              ]}
              value={intensityMode}
              onChange={(v) => setIntensityMode(v as "intensity" | "vadm")}
            />
            <Toggle
              options={[
                ["incl", "Inclination"],
                ["delta_incl", "ΔI"],
              ]}
              value={inclinationMode}
              onChange={(v) => setInclinationMode(v as "incl" | "delta_incl")}
            />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showData}
                onChange={(e) => setShowData(e.target.checked)}
                disabled={!records.length}
              />
              Show search measurements
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showErrors}
                onChange={(e) => setShowErrors(e.target.checked)}
              />
              Show model uncertainty
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showEnsemble}
                disabled={!ensembleModels.length}
                onChange={(e) => setShowEnsemble(e.target.checked)}
              />
              Show ensemble
            </label>
            <button type="button" className={smallButton} onClick={exportData}>
              Download model data
            </button>
            <button type="button" className={smallButton} onClick={() => void exportGraphs()}>
              Download graphs
            </button>
          </div>
          <LocationSummary result={result} />
          {(ensembleStatus || exportStatus) && (
            <p className="text-gray-500">
              {[ensembleStatus, exportStatus].filter(Boolean).join(" ")}
            </p>
          )}
          <div className={tab === "curves" ? "space-y-3" : "hidden"}>
            {components.map((component) => (
              <CurveChart
                key={component.key}
                result={result}
                component={component}
                order={order}
                hidden={hidden[component.key] ?? EMPTY}
                setHidden={(set) => setHidden((h) => ({ ...h, [component.key]: set }))}
                measurements={showData ? records : null}
                regionColors={colorsByRegion}
                showErrors={showErrors}
                showEnsemble={showEnsemble}
                cursorYear={cursorYear}
                filePrefix={node.slug}
              />
            ))}
          </div>
          {tab === "global" && (
            <GlobalMaps
              result={result}
              catalog={cat}
              inclinationMode={inclinationMode}
              filePrefix={node.slug}
              onYear={setCursorYear}
            />
          )}
          <Citations result={result} catalog={cat} />
        </>
      )}
    </div>
  );
}

function Toggle({
  options,
  value,
  onChange,
}: {
  options: [string, string][];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-sm border border-gray-300">
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          className={cx(
            "px-2 py-1",
            value === key
              ? "bg-gray-200 font-bold text-gray-900"
              : "bg-surface text-gray-700 hover:bg-gray-50",
          )}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function LocationSummary({ result }: { result: CurveResult }) {
  if (result.location_source !== "database") {
    return (
      <p className="text-gray-600">
        {result.latitude}°N, {result.longitude}°E, {result.altitude} km · {result.start_year} to{" "}
        {result.end_year} every {result.step} years
      </p>
    );
  }
  const parts = (["intensity", "direction"] as const).map((group) => {
    const name = group === "intensity" ? "Intensity/VADM" : "Directions";
    if (result.use_median) {
      const median = result.median_locations?.[group];
      return `${name}: ${median ? `median ${median.latitude.toFixed(4)}°N, ${median.longitude.toFixed(4)}°E` : "no matching locations"}`;
    }
    return `${name}: ${(result.component_location_counts?.[group] ?? 0).toLocaleString()} locations`;
  });
  return (
    <p className="text-gray-600">
      {parts.join(" · ")} · sea level · {result.start_year} to {result.end_year} every {result.step}{" "}
      years
    </p>
  );
}

function Citations({ result, catalog }: { result: CurveResult; catalog: Catalog }) {
  const names = [...new Set(result.series.map((s) => s.model))];
  return (
    <section className="rounded-sm border border-gray-300 bg-surface px-3 py-2 text-[12px] text-gray-600">
      <h4 className="mb-1 text-[13px] font-bold text-gray-800">Models and citations</h4>
      <ul className="space-y-1">
        {names.map((name) => {
          const m = catalog.models[name];
          if (!m) return null;
          return (
            <li key={name}>
              <span className="font-bold text-gray-800">{name}</span> — {m.citation}
              {m.doi && (
                <>
                  {" "}
                  <a
                    className="text-node-ink underline"
                    href={`https://doi.org/${m.doi}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    doi:{m.doi}
                  </a>
                </>
              )}{" "}
              · {m.dataset} · terms: {m.terms} ·{" "}
              <a
                className="text-node-ink underline"
                href={m.source_url}
                target="_blank"
                rel="noreferrer"
              >
                source
              </a>
              {m.interpolated_epochs && <> · {m.coefficient_note}</>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CurveChart({
  result,
  component,
  order,
  hidden,
  setHidden,
  measurements,
  regionColors,
  showErrors,
  showEnsemble,
  cursorYear,
  filePrefix,
}: {
  result: CurveResult;
  component: Component;
  order: string[];
  hidden: Set<string>;
  setHidden: (set: Set<string>) => void;
  measurements: ReturnType<typeof measurementsFrom> | null;
  regionColors: Map<string, string>;
  showErrors: boolean;
  showEnsemble: boolean;
  cursorYear: number | null;
  filePrefix: string;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const colors = usePlotColors();
  const options = useMemo(
    () => ({
      result,
      component,
      order,
      hidden,
      measurements,
      regionColors,
      showErrors,
      showEnsemble,
      cursorYear,
    }),
    [
      result,
      component,
      order,
      hidden,
      measurements,
      regionColors,
      showErrors,
      showEnsemble,
      cursorYear,
    ],
  );
  // curveOption reads the theme's plot colours, so a theme switch rebuilds.
  const build = useCallback(
    (size: { width: number; height: number }) => {
      void colors;
      return curveOption(options, size);
    },
    [options, colors],
  );
  // Legend clicks hide a model or a region; keep them across rebuilds.
  const live = useRef({ hidden, setHidden });
  live.current = { hidden, setHidden };
  useEffect(() => {
    const element = wrapper.current?.querySelector("[_echarts_instance_]") as HTMLElement | null;
    const chart = element ? echarts.getInstanceByDom(element) : undefined;
    if (!chart) return;
    const handler = (event: unknown) => {
      const { selected } = event as { selected: Record<string, boolean> };
      live.current.setHidden(
        new Set(
          Object.entries(selected)
            .filter(([, on]) => !on)
            .map(([n]) => n),
        ),
      );
    };
    chart.on("legendselectchanged", handler);
    return () => {
      chart.off("legendselectchanged", handler);
    };
  });
  const savePng = () => {
    const element = wrapper.current?.querySelector("[_echarts_instance_]") as HTMLElement | null;
    const chart = element ? echarts.getInstanceByDom(element) : undefined;
    if (!chart) return;
    const uri = chart.getDataURL({ type: "png", pixelRatio: 3, backgroundColor: colors.surface });
    save(
      new Blob([dataUrlBytes(uri) as BlobPart], { type: "image/png" }),
      `${filePrefix}_models_${component.key}_${timestamp()}.png`,
    );
  };
  const title =
    component.key === "intensity" || component.key === "vadm"
      ? `${component.label} through time`
      : component.key === "decl"
        ? "Declination through time"
        : `${component.label} through time`;
  return (
    <section className="min-w-0 rounded-sm border border-gray-300 bg-surface">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-200 px-3 py-2">
        <h4 className="text-[14px] font-bold text-gray-900">{title}</h4>
        <span className="text-[12px] text-gray-500">{chartStatus(options)} Drag to zoom.</span>
        <div className="ml-auto">
          <button type="button" className={smallButton} onClick={savePng}>
            PNG
          </button>
        </div>
      </header>
      <div ref={wrapper} className="px-1">
        <EChart build={build} height={460} zoom="xy" label={title} />
      </div>
    </section>
  );
}
