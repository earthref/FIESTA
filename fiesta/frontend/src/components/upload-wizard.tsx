/**
 * The upload page (legacy MagIC upload_contribution.jsx): 1. Select files (or
 * an example), 2. Import them sheet by sheet into the data model's tables,
 * 3. Upload into a new private contribution or replace those tables in an
 * existing one. The browser reads the files (SheetJS for spreadsheets); the
 * API normalises the values, merges the tables into a new revision and keeps
 * the original files as its attachments.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { nodeUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { dataModelQuery, unwrapModel } from "../lib/data-model";
import { loadColumnHints, rememberColumns, reviewSheet, SOFT_MATCHES } from "../lib/import-review";
import {
  computeSheet,
  decodeText,
  FORMATS,
  formatLabel,
  guessFormat,
  initialState,
  readBlocks,
  readSheets,
  type Sheet,
  type SheetState,
  sheetBlock,
  singleSourceErrors,
  templateSettings,
} from "../lib/importer";
import {
  conversionReportName,
  isLabFormat,
  type LabConversion,
  type LabFormat,
  type LabFormatKey,
  type LabSettings,
  labExampleFiles,
  labFormatKey,
  labFormatsQuery,
  labKey,
  NO_LAB,
  readLabFile,
  sniffedLab,
  sniffLabFormats,
} from "../lib/lab-formats";
import type {
  ContributionOut,
  DataModel,
  ImportFormat,
  ImportSettings,
  ImportTemplate,
  UploadExample,
  ValidationResult,
} from "../lib/types";
import { mayNeedUpgrade, type UpgradeResult, upgradeText } from "../lib/upgrade";
import { cx, formatBytes } from "../lib/utils";
import { DataImporter, type TemplateActions } from "./data-importer";
import { ErrorMessage } from "./error-message";
import { ImportOverview, type OverviewEntry } from "./import-overview";
import { LabFormatList } from "./lab-format-list";
import { LabConversionPanel } from "./lab-format-options";
import { useLoginModal } from "./login-modal";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon, type IconName, iconName } from "./ui/icon";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { UpgradeReportPanel } from "./upgrade-report";

type Step = 1 | 2 | 3;
type Phase = "idle" | "creating" | "uploading" | "processing" | "done" | "error";

const SEGMENT_BORDER = "var(--er-line)";

// Example cards: two per row on phones, all in one row from sm up.
const EXAMPLE_GRID =
  "grid grid-cols-2 gap-2 sm:[grid-template-columns:repeat(var(--examples),minmax(0,1fr))]";
const exampleColumns = (n: number) => ({ "--examples": n }) as CSSProperties;

const stepDefs: {
  step: Step;
  icon: IconName;
  corner?: IconName;
  title: string;
  description: string;
}[] = [
  {
    step: 1,
    icon: "folder-open",
    title: "Select",
    description: "Click and select or drag and drop files below.",
  },
  {
    step: 2,
    icon: "file-search",
    title: "Import",
    description: "Read the files and check the column headers.",
  },
  {
    step: 3,
    icon: "file-text",
    corner: "plus",
    title: "Upload",
    description: "Append to or create a new contribution.",
  },
];

/** A file being imported: its bytes (kept to upload as the original), how
 * it is read, its sheets and each sheet's importer state. */
interface ImportFile {
  /** Stable across re-reads (the file-type override). */
  id: string;
  name: string;
  bytes: ArrayBuffer;
  format: ImportFormat | LabFormatKey;
  sheets: Sheet[];
  states: SheetState[];
  /** The upgrade of a file written in an older data model (its sheets are
   * the upgraded text's), with the blank defaults it was run with. */
  upgrade: UpgradeResult | null;
  defaults: Record<string, boolean>;
  /** A lab format's server conversion (its sheets are the converted text's),
   * the options the contributor set, and, for a file another file's
   * conversion reads (a CIT specimen file), that file's name. */
  lab: LabConversion | null;
  labOptions: Record<string, unknown>;
  companionOf: string | null;
  error: string | null;
}

/** Legacy "ui top attached stackable three steps" bar (min-height 8em per step). */
function StepsBar({ current, onStep }: { current: Step; onStep: (step: Step) => void }) {
  return (
    <ol
      className="flex flex-col rounded-t-sm bg-surface sm:flex-row"
      style={{
        width: "calc(100% + 2px)",
        marginLeft: -1,
        border: `1px solid ${SEGMENT_BORDER}`,
        margin: "0 0 0 -1px",
        padding: 0,
      }}
    >
      {stepDefs.map((def, index) => {
        const active = def.step === current;
        const disabled = def.step > current;
        // Earlier steps are links back (legacy "Step 1. Restart").
        const back = def.step < current;
        const body = (
          <>
            <span
              aria-hidden="true"
              className={cx("leading-none", active ? "text-node-ink" : "text-ink-secondary")}
            >
              <Icon name={def.icon} corner={def.corner} size="big" />
            </span>
            <span className="text-left">
              <span className="block text-[1.1em] font-bold">
                Step {def.step}. {back && def.step === 1 ? "Restart" : def.title}
              </span>
              <span className="block text-[13px]">
                {back && def.step === 1 ? "Progress will be lost." : def.description}
              </span>
            </span>
          </>
        );
        return (
          <li
            key={def.step}
            aria-current={active ? "step" : undefined}
            className="relative flex flex-1"
            style={{
              minHeight: "8em",
              borderLeft: index > 0 ? `1px solid ${SEGMENT_BORDER}` : "none",
              color: disabled ? "rgba(40,40,40,.3)" : "var(--er-ink)",
              background: active ? "var(--er-surface)" : "transparent",
              // FIESTA: a 3px node-color bar marks the active step.
              boxShadow: active ? "inset 0 -3px 0 var(--node-color)" : undefined,
            }}
          >
            {back ? (
              <button
                type="button"
                onClick={() => onStep(def.step)}
                className="flex flex-1 items-center justify-center gap-3 px-4 py-3 hover:bg-node-soft"
              >
                {body}
              </button>
            ) : (
              <span className="flex flex-1 items-center justify-center gap-3 px-4 py-3">
                {body}
              </span>
            )}
            {/* Active pointing-below arrow (site.overrides .ui.steps .active.step.pointing.below),
                in the node color as the bar's notch: the lower half of a rotated square. */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute left-1/2 hidden sm:block"
                style={{
                  top: "100%",
                  width: "1em",
                  height: "1em",
                  transform: "translate(-50%, -50%) rotate(45deg)",
                  background: "var(--node-color)",
                  clipPath: "polygon(100% 0, 100% 100%, 0 100%)",
                  zIndex: 2,
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ExampleCard({
  example,
  action,
  onClick,
}: {
  example: UploadExample;
  action: "upload" | "download";
  onClick: () => void;
}) {
  const [first, second] = example.title.split("\n");
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        action === "upload"
          ? "Click to import this example dataset. You can always delete it later."
          : "Click to download this example dataset before uploading it."
      }
      className="flex flex-col items-center gap-1 rounded-md px-2 py-3 text-center hover:bg-node-soft focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
    >
      <Icon
        name={iconName(example.icon, "file-text")}
        corner={action === "upload" ? "arrow-up" : "arrow-down"}
        size={36}
        className="mb-1.5 text-ink-secondary"
      />
      <span className="text-[13px] font-bold leading-tight text-gray-800">
        {first}
        {second !== undefined && (
          <>
            <br />
            {second}
          </>
        )}
      </span>
      {example.subtitle && <span className="text-[12px] text-gray-500">{example.subtitle}</span>}
    </button>
  );
}

function useTemplateActions(enabled: boolean): TemplateActions {
  const queryClient = useQueryClient();
  const key = ["private", "import-templates"];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<ImportTemplate[]>("/private/import-templates"),
    enabled,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  return {
    templates: data,
    create: async (name: string, settings: ImportSettings) => {
      const made = await api<ImportTemplate>("/private/import-templates", {
        method: "POST",
        json: { name, settings },
      });
      await refresh();
      return made;
    },
    save: async (id: number, settings: ImportSettings) => {
      await api(`/private/import-templates/${id}`, { method: "PUT", json: { settings } });
      await refresh();
    },
    rename: async (id: number, name: string) => {
      await api(`/private/import-templates/${id}`, { method: "PUT", json: { name } });
      await refresh();
    },
    remove: async (id: number) => {
      await api(`/private/import-templates/${id}`, { method: "DELETE" });
      await refresh();
    },
  };
}

/** How a file of the node's text format in an older data model is upgraded
 * before its sheets are read: the model's latest version and the blank
 * defaults the contributor switched. */
interface UpgradeSettings {
  latest: string;
  defaults: Record<string, boolean>;
}

async function readFile(
  id: string,
  name: string,
  bytes: ArrayBuffer,
  format: ImportFormat | LabFormatKey,
  model: DataModel | null,
  templates: Parameters<typeof readSheets>[2],
  upgradeSettings: UpgradeSettings,
  labSettings: LabSettings = NO_LAB,
): Promise<ImportFile> {
  const base = {
    id,
    name,
    bytes,
    format,
    defaults: upgradeSettings.defaults,
    lab: null,
    labOptions: labSettings.options,
    companionOf: labSettings.companionOf,
  };
  if (isLabFormat(format)) {
    const read = await readLabFile(format, { name, bytes }, labSettings);
    return {
      ...base,
      ...read,
      states: read.sheets.map((s) => initialState(s, model)),
      upgrade: null,
    };
  }
  let upgrade: UpgradeResult | null = null;
  if (format === "fiesta" && upgradeSettings.latest) {
    const text = decodeText(bytes);
    if (mayNeedUpgrade(text, model, upgradeSettings.latest)) {
      try {
        const result = await upgradeText(text, { defaults: upgradeSettings.defaults });
        upgrade = result.upgraded ? result : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Upgrading is a contributor action on the server: it needs a login.
        const signedOut = error instanceof ApiError && error.status === 401;
        return {
          ...base,
          sheets: [],
          states: [],
          upgrade: null,
          error: signedOut
            ? `This file is written in an older data model: log in to upgrade it to ${upgradeSettings.latest}.`
            : `Failed to upgrade this file to data model ${upgradeSettings.latest}: ${message}`,
        };
      }
    }
  }
  try {
    const sheets = upgrade?.text
      ? readBlocks(upgrade.text)
      : await readSheets(bytes, format, templates);
    return {
      ...base,
      sheets,
      states: sheets.map((sheet) => initialState(sheet, model)),
      upgrade,
      error: sheets.length ? null : "The file has no tables to import.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      sheets: [],
      states: [],
      upgrade: null,
      error: `Failed to read this file as a ${format === "excel" ? "spreadsheet" : "text file"}: ${message}`,
    };
  }
}

/** The name of an upgraded file's report, kept beside it as an attachment. */
const reportName = (name: string) => `${name.replace(/\.[^.]*$/, "")}-upgrade-report.txt`;

const rowCount = (n: number) => `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;

/** The tables a contribution's current text holds, with their row counts. */
function tableCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sheet of readBlocks(text)) {
    if (sheet.tableName)
      counts[sheet.tableName] = (counts[sheet.tableName] ?? 0) + sheet.rows.length - 2;
  }
  return counts;
}

export function UploadWizard({ initialTarget }: { initialTarget?: number }) {
  const { data: config } = useNodeConfig();
  const { user } = useAuth();
  const { openLogin } = useLoginModal();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(1);
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);
  const [contributionId, setContributionId] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(initialTarget ?? null);
  const [name, setName] = useState("My Contribution");
  const nameId = useId();

  const upload = config?.upload;
  const templates = upload?.excel_templates ?? [];
  // Files in an older data model are upgraded to this version as they are read.
  const latest = config?.data_model_latest ?? "";
  const upgradable = (config?.data_model_versions.length ?? 0) > 1;
  const { data: model = null } = useQuery({
    ...dataModelQuery(config?.data_model_latest ?? ""),
    enabled: !!config?.data_model_latest,
    select: unwrapModel,
  });
  const templateActions = useTemplateActions(!!user);
  // Lab formats the node's plugins convert on the server (lib/lab-formats).
  const { data: labFormats = [] } = useQuery(labFormatsQuery);

  // Contributions an upload can go into: the unpublished ones the user can open.
  const privateQuery = useQuery({
    queryKey: ["private", "contributions"],
    queryFn: () => api<ContributionOut[]>("/private/contributions"),
    enabled: !!user,
  });
  const targets = (privateQuery.data ?? []).filter((c) => !c.is_activated && !c.published_revision);
  const existingQuery = useQuery({
    queryKey: ["private", "content", target],
    queryFn: async () => {
      try {
        return await api<{ revision_id: string | null; text: string }>(
          `/private/contributions/${target}/content`,
        );
      } catch (err) {
        // A contribution created but never uploaded into has no content yet.
        if (err instanceof ApiError && err.status === 404) return { revision_id: null, text: "" };
        throw err;
      }
    },
    enabled: target !== null && step === 3,
    staleTime: 0,
  });

  const contributionQuery = useQuery({
    queryKey: ["private", "contribution", contributionId],
    queryFn: () => api<ContributionOut>(`/private/contributions/${contributionId}`),
    enabled: contributionId !== null && phase === "processing",
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "ready" || status === "failed" ? false : 2000;
    },
  });
  const status = contributionQuery.data?.status;
  useEffect(() => {
    if (phase === "processing" && (status === "ready" || status === "failed")) {
      setPhase("done");
      queryClient.invalidateQueries({ queryKey: ["private", "contributions"] });
    }
  }, [phase, status, queryClient]);

  const validationQuery = useQuery({
    queryKey: ["private", "validation", contributionId],
    queryFn: async () => {
      try {
        return await api<ValidationResult>(`/private/contributions/${contributionId}/validation`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: contributionId !== null && phase === "done",
  });

  // Columns this browser remembers the contributor picking in earlier uploads.
  const nodeKey = config?.key ?? "";
  const hints = useMemo(() => loadColumnHints(nodeKey), [nodeKey]);
  // Every sheet's import and its review, and the blocks of the ready ones.
  const imports = useMemo(
    () =>
      files.map((file) =>
        file.sheets.map((sheet, j) => computeSheet(sheet.rows, file.states[j], model, hints)),
      ),
    [files, model, hints],
  );
  const reviews = useMemo(
    () =>
      files.map((file, i) =>
        file.sheets.map((sheet, j) =>
          reviewSheet(sheet.rows, file.states[j], imports[i][j], model),
        ),
      ),
    [files, imports, model],
  );
  const sheetKey = (i: number, j: number) => `${files[i]?.id}:${files[i]?.format}:${j}`;
  // Cards open once: those needing something start open, the rest closed.
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOpenCards((current) => {
      let changed = false;
      const next = { ...current };
      files.forEach((file, i) => {
        file.sheets.forEach((_, j) => {
          const k = `${file.id}:${file.format}:${j}`;
          const review = reviews[i]?.[j];
          if (review && next[k] === undefined) {
            next[k] = review.status === "fix" || review.status === "review";
            changed = true;
          }
        });
      });
      return changed ? next : current;
    });
  }, [files, reviews]);
  const openCard = (k: string) => {
    setOpenCards((current) => ({ ...current, [k]: true }));
    requestAnimationFrame(() =>
      document.getElementById(`sheet-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  const blocks: { table: string; rows: number; text: string }[] = [];
  let nImportErrors = 0;
  files.forEach((file, i) => {
    if (file.error) nImportErrors++;
    file.sheets.forEach((sheet, j) => {
      const result = imports[i]?.[j];
      if (!result) return;
      nImportErrors += result.nErrors > 0 ? 1 : 0;
      const text = sheetBlock(sheet.rows, file.states[j], result);
      if (text)
        blocks.push({ table: file.states[j].settings.table_name.trim(), rows: result.nRows, text });
    });
  });
  const sourceErrors = singleSourceErrors(
    blocks.map((b) => b.table),
    upload?.single_source_tables ?? [],
  );
  const importReady = blocks.length > 0 && nImportErrors === 0 && sourceErrors.length === 0;

  const addFiles = async (
    picked: { name: string; bytes: ArrayBuffer; format?: ImportFormat }[],
  ) => {
    if (picked.length === 0) return;
    setReading(true);
    setStep(2);
    const sorted = [...picked].sort((a, b) => a.name.localeCompare(b.name));
    // A lab file the server recognises is read as its lab format.
    const sniffed = labFormats.length ? await sniffLabFormats(sorted).catch(() => null) : null;
    const read = await Promise.all(
      sorted.map((f) => {
        const lab = f.format ? null : sniffedLab(f.name, sorted, sniffed);
        return readFile(
          crypto.randomUUID(),
          f.name,
          f.bytes,
          lab?.format ?? f.format ?? guessFormat(f.name, f.bytes),
          model,
          templates,
          { latest, defaults: {} },
          lab?.settings,
        );
      }),
    );
    setFiles(read);
    setReading(false);
  };

  const pickFiles = async (list: FileList | null | undefined) => {
    const picked = Array.from(list ?? []);
    await addFiles(
      await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() }))),
    );
  };

  const exampleBytes = async (example: UploadExample) => {
    const response = await fetch(nodeUrl(`/config/assets/${example.file}`));
    if (!response.ok) throw new Error(`could not fetch the example (${response.status})`);
    return response.arrayBuffer();
  };
  const exampleName = (example: UploadExample) => example.file.split("/").pop() ?? example.file;

  const importExample = async (example: UploadExample) => {
    try {
      await addFiles([
        { name: exampleName(example), bytes: await exampleBytes(example), format: example.format },
      ]);
    } catch (err) {
      setError(err);
    }
  };

  // A lab format's example: read like dropped files, so the server's sniffing
  // picks the format and the files its conversion reads with the first.
  const tryLabExample = async (format: LabFormat) => {
    try {
      await addFiles(await labExampleFiles(format));
    } catch (err) {
      setError(err);
    }
  };

  const downloadLabExample = async (format: LabFormat) => {
    try {
      for (const file of await labExampleFiles(format)) {
        const url = URL.createObjectURL(new Blob([file.bytes]));
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err);
    }
  };

  const downloadExample = async (example: UploadExample) => {
    try {
      const blob = new Blob([await exampleBytes(example)]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exampleName(example);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err);
    }
  };

  // The files a lab file's conversion reads with it (a CIT .sam's specimen files).
  const companionsOf = (file: ImportFile) =>
    files.filter((f) => f.companionOf === file.name).map((f) => ({ name: f.name, bytes: f.bytes }));

  const setFormat = async (i: number, format: ImportFormat | LabFormatKey) => {
    const file = files[i];
    setReading(true);
    const read = await readFile(
      file.id,
      file.name,
      file.bytes,
      format,
      model,
      templates,
      { latest, defaults: file.defaults },
      isLabFormat(format) ? { ...NO_LAB, companions: companionsOf(file) } : NO_LAB,
    );
    setFiles((current) => current.map((f, k) => (k === i ? read : f)));
    setReading(false);
  };

  // A lab file's converter options changed: convert it again.
  const setLabOptions = async (i: number, options: Record<string, unknown>) => {
    const file = files[i];
    if (!isLabFormat(file.format)) return;
    setReading(true);
    const read = await readFile(
      file.id,
      file.name,
      file.bytes,
      file.format,
      model,
      templates,
      { latest, defaults: file.defaults },
      { options, companions: companionsOf(file), companionOf: null },
    );
    setFiles((current) => current.map((f, k) => (k === i ? read : f)));
    setReading(false);
  };

  // A blank default switched in an upgraded file's report: upgrade it again.
  const setDefault = async (i: number, key: string, on: boolean) => {
    const file = files[i];
    setReading(true);
    const read = await readFile(file.id, file.name, file.bytes, file.format, model, templates, {
      latest,
      defaults: { ...file.defaults, [key]: on },
    });
    setFiles((current) => current.map((f, k) => (k === i ? read : f)));
    setReading(false);
  };

  const setSheetState = (i: number, j: number, state: SheetState) =>
    setFiles((current) =>
      current.map((f, k) =>
        k === i ? { ...f, states: f.states.map((s, l) => (l === j ? state : s)) } : f,
      ),
    );

  // Upload-wide shortcuts: accept every suggested (non-exact) match, leave
  // out every unmatched column.
  const softAt = (i: number, j: number) => {
    const r = imports[i][j];
    return r.inColumnNames
      .map((_, c) => c)
      .filter((c) => {
        const kind = r.matches[c];
        return (
          !r.skippedColumns.has(c) && !!kind && SOFT_MATCHES.has(kind) && !!r.outColumnNames[c]
        );
      });
  };
  const unmatchedAt = (i: number, j: number) => {
    const r = imports[i][j];
    const settings = files[i].states[j].settings;
    const columns = model?.tables[settings.table_name.trim()]?.columns;
    if (!columns || settings.exclude_table) return [];
    return r.inColumnNames
      .map((_, c) => c)
      .filter((c) => !r.skippedColumns.has(c) && !columns[r.outColumnNames[c] ?? ""]);
  };
  const eachSheet = (update: (i: number, j: number, state: SheetState) => SheetState) =>
    setFiles((current) =>
      current.map((f, i) => ({ ...f, states: f.states.map((s, j) => update(i, j, s)) })),
    );
  const acceptAllSuggestions = () =>
    eachSheet((i, j, state) => {
      const targets = [...state.targets];
      for (const c of softAt(i, j)) targets[c] = imports[i][j].outColumnNames[c];
      return { ...state, targets };
    });
  const leaveOutAllUnmatched = () =>
    eachSheet((i, j, state) => ({
      ...state,
      excludeColumns: [...new Set([...state.excludeColumns, ...unmatchedAt(i, j)])],
    }));
  // Sheets laid out alike (the same headers) can take one sheet's settings.
  const headersKey = (i: number, j: number) => imports[i]?.[j]?.inColumnNames.join("\t") ?? "";
  const sameHeadersAs = (i: number, j: number) => {
    const wanted = headersKey(i, j);
    const found: string[] = [];
    files.forEach((f, a) => {
      f.sheets.forEach((_, b) => {
        if ((a !== i || b !== j) && headersKey(a, b) === wanted) found.push(`${a}:${b}`);
      });
    });
    return found;
  };
  const applyToSameHeaders = (i: number, j: number) => {
    const from = files[i].states[j];
    const others = new Set(sameHeadersAs(i, j));
    eachSheet((a, b, state) =>
      others.has(`${a}:${b}`)
        ? {
            ...state,
            settings: { ...from.settings },
            targets: [...from.targets],
            excludeColumns: [...from.excludeColumns],
            guessed: {},
            dismissed: [...(from.dismissed ?? [])],
          }
        : state,
    );
  };

  // Sheets whose columns were set by hand and kept in no template: offered
  // as templates before continuing.
  const [templateNames, setTemplateNames] = useState<Record<string, string>>({});
  const [skipTemplates, setSkipTemplates] = useState(false);
  const unsavedSheets: { i: number; j: number; label: string }[] = [];
  files.forEach((file, i) => {
    file.sheets.forEach((sheet, j) => {
      const state = file.states[j];
      const result = imports[i]?.[j];
      if (!result || state.settings.exclude_table || state.templateId || result.nErrors > 0) return;
      if (result.matches.includes("manual") || state.excludeColumns.length > 0)
        unsavedSheets.push({ i, j, label: sheet.label || file.name });
    });
  });
  const saveTemplate = async (i: number, j: number) => {
    const name = templateNames[sheetKey(i, j)]?.trim();
    if (!name) return;
    try {
      const made = await templateActions.create(
        name,
        templateSettings(files[i].states[j], imports[i][j]),
      );
      setSheetState(i, j, { ...files[i].states[j], templateId: made.id });
    } catch (err) {
      setError(err);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    pickFiles(event.dataTransfer.files);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    pickFiles(event.target.files);
    event.target.value = "";
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      let id = target;
      let expected: string | null = null;
      if (id === null) {
        setPhase("creating");
        const created = await api<ContributionOut>("/private/contributions", { method: "POST" });
        id = created.id;
        if (name.trim()) {
          await api(`/private/contributions/${id}/name`, {
            method: "PUT",
            json: { name: name.trim() },
          });
        }
      } else {
        // The revision whose tables step 3 showed: the save is refused if
        // the contribution changed since.
        expected = existingQuery.data?.revision_id ?? null;
      }
      setContributionId(id);
      setPhase("uploading");
      const formData = new FormData();
      formData.append(
        "data",
        new Blob([blocks.map((b) => b.text).join("\n>>>>>>>>>>\n")], { type: "text/plain" }),
        "import.txt",
      );
      for (const file of files) {
        formData.append("originals", new Blob([file.bytes]), file.name);
        if (file.upgrade?.report_text)
          formData.append("originals", new Blob([file.upgrade.report_text]), reportName(file.name));
        if (file.lab?.report_text)
          formData.append(
            "originals",
            new Blob([file.lab.report_text]),
            conversionReportName(file.name),
          );
      }
      const headers: Record<string, string> = { "Idempotency-Key": crypto.randomUUID() };
      if (expected) headers["If-Match"] = expected;
      await api<ContributionOut>(`/private/contributions/${id}/import`, {
        method: "POST",
        formData,
        headers,
      });
      // Columns picked by hand are suggested in this browser's next upload.
      const picks: { table: string; header: string; column: string }[] = [];
      files.forEach((file, i) => {
        file.sheets.forEach((_, j) => {
          const result = imports[i][j];
          const table = file.states[j].settings.table_name.trim();
          result.inColumnNames.forEach((header, c) => {
            const column = result.outColumnNames[c];
            if (column && result.matches[c] === "manual" && !result.skippedColumns.has(c))
              picks.push({ table, header, column });
          });
        });
      });
      rememberColumns(nodeKey, picks);
      setPhase("processing");
    },
    onError: (err) => {
      setError(err);
      setPhase("error");
    },
  });

  const reset = () => {
    setStep(1);
    setFiles([]);
    setPhase("idle");
    setError(null);
    setContributionId(null);
    setTarget(initialTarget ?? null);
  };

  const busy = phase === "creating" || phase === "uploading" || phase === "processing";
  const existing = existingQuery.data ? tableCounts(existingQuery.data.text) : {};
  const uploadedTables = new Map<string, number>();
  for (const b of blocks) uploadedTables.set(b.table, (uploadedTables.get(b.table) ?? 0) + b.rows);
  const key = config?.key ?? "";

  // The overview's lines, one per sheet of every readable file.
  const sheetTitle = (i: number, j: number) => {
    const file = files[i];
    const label = file.sheets[j]?.label;
    return file.sheets.length > 1 || (label && file.format === "excel")
      ? `${file.name} › ${label || `Table ${j + 1}`}`
      : file.name;
  };
  const entries: OverviewEntry[] = [];
  let nSoft = 0;
  let nUnmatched = 0;
  files.forEach((file, i) => {
    file.sheets.forEach((_, j) => {
      const result = imports[i]?.[j];
      const review = reviews[i]?.[j];
      if (!result || !review) return;
      const table = file.states[j].settings.table_name.trim();
      entries.push({
        key: sheetKey(i, j),
        title: sheetTitle(i, j),
        table,
        known: !!model?.tables[table],
        result,
        review,
      });
      if (!file.states[j].settings.exclude_table) {
        nSoft += softAt(i, j).length;
        nUnmatched += unmatchedAt(i, j).length;
      }
    });
  });
  const nToFix = entries.filter((e) => e.review.status === "fix").length;
  const nToReview = entries.reduce((n, e) => n + e.review.nReview, 0);
  // Files the contributor should read about: unreadable, upgraded with a
  // guessed version, warnings, errors or blank defaults to choose, or
  // converted from a lab format with warnings, defaults or hints.
  const fileProblems = files.filter((f) => {
    const report = f.upgrade?.report;
    return (
      !!f.error ||
      (!!report &&
        (report.guessed ||
          report.defaults.some((d) => d.count > 0) ||
          report.notes.some((n) => n.level !== "info"))) ||
      !!f.lab?.notes.some((n) => n.level !== "info" || n.kind !== "converter")
    );
  }).length;

  return (
    <div className="upload-contribution">
      <StepsBar current={step} onStep={(s) => (s === 1 ? reset() : setStep(s))} />
      {/* ui attached message container (bg white) */}
      <div
        className="rounded-b-sm bg-surface"
        style={{
          width: "calc(100% + 2px)",
          margin: "0 0 0 -1px",
          border: `1px solid ${SEGMENT_BORDER}`,
          borderTop: "none",
          padding: "1em",
        }}
      >
        {step === 1 && (
          <>
            {/* FIESTA: one drop target (legacy split it into "Click and select" OR
                "Drag and drop"); the whole area opens the file picker. */}
            <button
              type="button"
              aria-describedby="upload-dropzone-hint"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cx(
                "upload-dropzone flex w-full cursor-pointer flex-col items-center gap-3 rounded-[10px] border-2 border-dashed px-6 py-8 text-center transition-colors",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                dragging
                  ? "border-node bg-[color-mix(in_srgb,var(--node-color)_12%,transparent)]"
                  : "border-[color-mix(in_srgb,var(--node-color)_40%,transparent)] bg-[color-mix(in_srgb,var(--node-color)_4%,transparent)] hover:bg-[color-mix(in_srgb,var(--node-color)_8%,transparent)]",
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--node-color)_14%,transparent)] text-node-ink"
              >
                <Icon name="drop-files" size={34} />
              </span>
              <span className="block text-[1.07rem] font-bold text-gray-800">
                Drop files here, or{" "}
                <span className="text-node-ink underline underline-offset-2">browse</span>
              </span>
              {config && (
                <span id="upload-dropzone-hint" className="block text-xs text-gray-500">
                  {key} text files, tab- or comma-delimited tables (.txt, .tsv, .csv) or Excel
                  workbooks (.xlsx, one table per sheet); data model version{" "}
                  {config.data_model_latest}
                  {labFormats.length > 0 && (
                    <>
                      <br />
                      Lab instrument files too:{" "}
                      {labFormats
                        .slice(0, 4)
                        .map((f) => f.label.replace(/ File\b.*$/, ""))
                        .join(", ")}
                      {labFormats.length > 4 && ` and ${labFormats.length - 4} more (see below)`}
                    </>
                  )}
                </span>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={onFileChange}
              aria-hidden="true"
              tabIndex={-1}
            />
            {error !== null && <ErrorMessage error={error} />}
            {upload && upload.examples.length > 0 && (
              <>
                <hr className="my-4 border-gray-200" />
                <h4 className="mb-2 text-[13px] font-bold text-gray-800">
                  Or try importing one of these example files:
                </h4>
                <div className={EXAMPLE_GRID} style={exampleColumns(upload.examples.length)}>
                  {upload.examples.map((example) => (
                    <ExampleCard
                      key={example.file}
                      example={example}
                      action="upload"
                      onClick={() => importExample(example)}
                    />
                  ))}
                </div>
                <hr className="my-4 border-gray-200" />
                <h4 className="mb-2 text-[13px] font-bold text-gray-800">
                  Or first download the file to preview the contents and make changes before
                  uploading:
                </h4>
                <div className={EXAMPLE_GRID} style={exampleColumns(upload.examples.length)}>
                  {upload.examples.map((example) => (
                    <ExampleCard
                      key={example.file}
                      example={example}
                      action="download"
                      onClick={() => downloadExample(example)}
                    />
                  ))}
                </div>
              </>
            )}
            {labFormats.length > 0 && (
              <>
                <hr className="my-4 border-gray-200" />
                <LabFormatList
                  formats={labFormats}
                  nodeKey={key}
                  onTry={tryLabExample}
                  onDownload={downloadLabExample}
                />
              </>
            )}
            {upgradable && (
              <p className="mt-3 text-[13px] text-gray-600">
                Files in an older {key} data model version are upgraded to version {latest} as they
                are read, and the import step shows what changed. To upgrade a file without
                uploading it, use the{" "}
                <Link to="/Upgrade" className="text-node-ink underline">
                  Upgrade page
                </Link>
                .
              </p>
            )}
          </>
        )}

        {step === 2 && (
          <div>
            <h3 className="mb-2 text-[1.1em] font-bold text-gray-800">
              Reading and translating the {files.length === 1 ? "file" : "files"} for uploading:
            </h3>
            {reading && <Spinner className="h-5 w-5" label="Reading…" />}
            {!reading && entries.length > 0 && (
              <ImportOverview
                entries={entries}
                nFiles={files.length}
                fileProblems={fileProblems}
                onOpen={openCard}
                onAcceptAll={acceptAllSuggestions}
                onLeaveOutUnmatched={leaveOutAllUnmatched}
                nSoft={nSoft}
                nUnmatched={nUnmatched}
              />
            )}
            {files.map((file, i) => (
              <div key={file.id} className="border-t border-gray-200 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon
                    name={file.format === "excel" ? "file-excel" : "file-text"}
                    size="large"
                    className="text-ink-secondary"
                  />
                  <span className="break-all font-bold text-gray-900">{file.name}</span>
                  <Badge>{formatBytes(file.bytes.byteLength)}</Badge>
                  {file.error && <Badge variant="danger">1 Read Error</Badge>}
                </div>
                <label className="mt-2 flex items-center gap-2 text-[13px]">
                  <span className="shrink-0 font-semibold text-gray-700">Import File Type</span>
                  <select
                    className="rounded-md border border-gray-300 bg-surface px-2 py-1.5 text-[13px]"
                    value={file.format}
                    onChange={(event) =>
                      setFormat(i, event.target.value as ImportFormat | LabFormatKey)
                    }
                  >
                    {FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {formatLabel(format, key)}
                      </option>
                    ))}
                    {labFormats.length > 0 && (
                      <optgroup label="Lab Instrument Formats">
                        {labFormats.map((format) => (
                          <option key={format.key} value={labFormatKey(format.key)}>
                            {format.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                {isLabFormat(file.format) && (
                  <LabConversionPanel
                    format={labFormats.find((f) => f.key === labKey(file.format as LabFormatKey))}
                    result={file.lab}
                    options={file.labOptions}
                    companionOf={file.companionOf}
                    onOptions={(options) => setLabOptions(i, options)}
                    busy={reading}
                  />
                )}
                {file.upgrade && (
                  <UpgradeReportPanel
                    result={file.upgrade}
                    modelName={`${key} Data Model`}
                    onDefault={(name, on) => setDefault(i, name, on)}
                    busy={reading}
                  />
                )}
                {file.error ? (
                  <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-800">
                    {file.error}
                  </p>
                ) : (
                  file.sheets.map((sheet, j) => {
                    const k = sheetKey(i, j);
                    const result = imports[i]?.[j];
                    const review = reviews[i]?.[j];
                    if (!result || !review) return null;
                    return (
                      <DataImporter
                        key={k}
                        anchor={`sheet-${k}`}
                        sheet={sheet}
                        title={sheetTitle(i, j)}
                        state={file.states[j]}
                        onChange={(state) => setSheetState(i, j, state)}
                        model={model}
                        templates={templateActions}
                        result={result}
                        review={review}
                        open={openCards[k] ?? false}
                        onToggle={() => setOpenCards((c) => ({ ...c, [k]: !(c[k] ?? false) }))}
                        sameHeaders={sameHeadersAs(i, j).length}
                        onApplyToSameHeaders={() => applyToSameHeaders(i, j)}
                      />
                    );
                  })
                )}
              </div>
            ))}
            {sourceErrors.map((message) => (
              <p
                key={message}
                className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-800"
              >
                {message}
              </p>
            ))}
            {user && !skipTemplates && importReady && unsavedSheets.length > 0 && (
              <div className="mt-4 rounded-md border border-gray-200 px-3 py-2 text-[13px]">
                <p className="text-gray-800">
                  You set columns by hand in{" "}
                  {unsavedSheets.length === 1 ? "this table" : `${unsavedSheets.length} tables`}.
                  Save the settings as a template for your next file laid out the same way?
                </p>
                {unsavedSheets.map(({ i, j, label }) => {
                  const k = sheetKey(i, j);
                  return (
                    <div key={k} className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="min-w-40 font-semibold text-gray-700">{label}</span>
                      <Input
                        aria-label={`Template name for ${label}`}
                        className="w-56 py-1 text-[13px]"
                        placeholder="Template name"
                        value={templateNames[k] ?? ""}
                        onChange={(event) =>
                          setTemplateNames((names) => ({ ...names, [k]: event.target.value }))
                        }
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!templateNames[k]?.trim()}
                        onClick={() => saveTemplate(i, j)}
                      >
                        Save template
                      </Button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="mt-1.5 text-[12px] text-gray-500 underline"
                  onClick={() => setSkipTemplates(true)}
                >
                  No thanks
                </button>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={reset}>
                Start over
              </Button>
              <Button onClick={() => setStep(3)} disabled={!importReady || reading}>
                Continue
              </Button>
              {!reading && entries.length > 0 && (
                <span className="text-[13px] text-gray-600">
                  {nToFix > 0 || sourceErrors.length > 0
                    ? `Fix ${nToFix + sourceErrors.length} ${
                        nToFix + sourceErrors.length === 1 ? "table" : "tables"
                      } to continue.`
                    : nToReview > 0
                      ? `${nToReview} ${nToReview === 1 ? "item" : "items"} to review: you can continue without them, and validation runs after the upload.`
                      : ""}
                </span>
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            {phase === "idle" && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center gap-2 text-[13px]">
                    <span className="shrink-0 font-semibold text-gray-700">Upload To</span>
                    <select
                      className="min-w-0 flex-1 rounded-md border border-gray-300 bg-surface px-2 py-2 text-[13px]"
                      value={target ?? ""}
                      onChange={(event) =>
                        setTarget(event.target.value === "" ? null : Number(event.target.value))
                      }
                    >
                      <option value="">A New Private Contribution</option>
                      {targets.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name || `Contribution ${c.id}`} ({c.id})
                        </option>
                      ))}
                    </select>
                  </label>
                  {target === null && (
                    <div className="flex items-center gap-2 text-[13px]">
                      <label htmlFor={nameId} className="shrink-0 font-semibold text-gray-700">
                        Name
                      </label>
                      <Input
                        id={nameId}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                  )}
                </div>
                <table className="mt-4 text-[13px]">
                  <thead>
                    <tr className="text-left text-gray-500">
                      <th className="pr-6 font-medium">Table</th>
                      <th className="pr-6 font-medium">Uploading</th>
                      {target !== null && <th className="font-medium">In the contribution now</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {[...uploadedTables].map(([table, rows]) => (
                      <tr key={table}>
                        <td className="pr-6 font-semibold">{table}</td>
                        <td className="pr-6">{rowCount(rows)}</td>
                        {target !== null && (
                          <td>
                            {existing[table] !== undefined
                              ? `${rowCount(existing[table])}, replaced`
                              : "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                    {target !== null &&
                      Object.entries(existing)
                        .filter(([table]) => !uploadedTables.has(table))
                        .map(([table, rows]) => (
                          <tr key={table} className="text-gray-500">
                            <td className="pr-6">{table}</td>
                            <td className="pr-6">—</td>
                            <td>{rowCount(rows)}, kept</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
                {target !== null && existingQuery.isLoading && (
                  <Spinner className="mt-2 h-4 w-4" label="Reading the contribution…" />
                )}
                {existingQuery.error && <ErrorMessage error={existingQuery.error} />}
                <p className="mt-4 text-sm text-gray-600">
                  {target === null
                    ? "Uploading creates a new private contribution in your workspace."
                    : "Uploading replaces the tables listed above in the selected contribution and keeps its other tables; its earlier revision stays in its history."}{" "}
                  The data are validated automatically and the original files are kept with the
                  contribution; nothing is published until you activate it.
                </p>
                {!user && (
                  <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    You need to{" "}
                    <button type="button" onClick={openLogin} className="font-medium underline">
                      log in
                    </button>{" "}
                    before uploading.
                  </p>
                )}
                <div className="mt-5 flex gap-2">
                  <Button variant="secondary" onClick={() => setStep(2)}>
                    Back
                  </Button>
                  <Button
                    onClick={() => uploadMutation.mutate()}
                    disabled={
                      !user ||
                      !importReady ||
                      (target !== null && (existingQuery.isLoading || !!existingQuery.error))
                    }
                  >
                    Upload
                  </Button>
                </div>
              </>
            )}

            {busy && (
              <div className="flex flex-col items-center gap-3 py-6">
                <Spinner
                  className="h-6 w-6"
                  label={
                    phase === "creating"
                      ? "Creating private contribution…"
                      : phase === "uploading"
                        ? "Uploading…"
                        : `Processing (${status ?? "queued"})…`
                  }
                />
                {phase === "processing" && (
                  <p className="text-xs text-gray-500">
                    Your data are being parsed, validated, and summarized. This can take a moment.
                  </p>
                )}
              </div>
            )}

            {phase === "error" && (
              <div>
                <ErrorMessage error={error} />
                <div className="mt-4 flex gap-2">
                  <Button variant="secondary" onClick={() => setPhase("idle")}>
                    Back
                  </Button>
                  <Button variant="secondary" onClick={reset}>
                    Start over
                  </Button>
                </div>
              </div>
            )}

            {phase === "done" && (
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Badge variant={status === "ready" ? "success" : "danger"}>{status}</Badge>
                  <span className="text-sm text-gray-700">
                    Contribution {contributionId}{" "}
                    {status === "ready" ? "was uploaded and processed." : "failed to process."}
                  </span>
                </div>
                {validationQuery.data && (
                  <p className="mb-3 text-sm text-gray-600">
                    Validation:{" "}
                    {validationQuery.data.is_valid ? (
                      <span className="font-medium text-green-700">passed</span>
                    ) : (
                      <span className="font-medium text-red-700">failed</span>
                    )}{" "}
                    — {validationQuery.data.errors.length} error(s),{" "}
                    {validationQuery.data.warnings.length} warning(s). Full results are available in
                    your private workspace.
                  </p>
                )}
                <div className="flex gap-2">
                  <Link to="/Private">
                    <Button>Open private workspace</Button>
                  </Link>
                  <Button variant="secondary" onClick={reset}>
                    Upload more files
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
