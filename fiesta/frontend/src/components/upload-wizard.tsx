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
import {
  computeSheet,
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
} from "../lib/importer";
import type {
  ContributionOut,
  DataModel,
  ImportFormat,
  ImportSettings,
  ImportTemplate,
  UploadExample,
  ValidationResult,
} from "../lib/types";
import { cx, formatBytes } from "../lib/utils";
import { DataImporter, type TemplateActions } from "./data-importer";
import { ErrorMessage } from "./error-message";
import { useLoginModal } from "./login-modal";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon, type IconName, isIconName } from "./ui/icon";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

type Step = 1 | 2 | 3;
type Phase = "idle" | "creating" | "uploading" | "processing" | "done" | "error";

const SEGMENT_BORDER = "var(--er-line)";

const stepDefs: { step: Step; icon: IconName; title: string; description: string }[] = [
  {
    step: 1,
    icon: "folder-open",
    title: "Select",
    description: "Click and select or drag and drop files below.",
  },
  {
    step: 2,
    icon: "table",
    title: "Import",
    description: "Read the files and check the column headers.",
  },
  {
    step: 3,
    icon: "upload",
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
  format: ImportFormat;
  sheets: Sheet[];
  states: SheetState[];
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
            <span aria-hidden="true" className="leading-none text-ink-secondary">
              <Icon name={def.icon} size="big" />
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
            {/* Active pointing-below arrow (site.overrides .ui.steps .active.step.pointing.below) */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute left-1/2 hidden bg-surface sm:block"
                style={{
                  top: "calc(100% + 1px)",
                  width: "1.14em",
                  height: "1.14em",
                  transform: "translate(-50%, -50%) rotate(45deg)",
                  borderRight: `1px solid ${SEGMENT_BORDER}`,
                  borderBottom: `1px solid ${SEGMENT_BORDER}`,
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
      <span className="relative text-ink-secondary">
        <Icon name={isIconName(example.icon) ? example.icon : "file-text"} size="big" />
        <span className="absolute -right-2 -bottom-1 rounded-full bg-surface text-node-ink">
          <Icon name={action === "upload" ? "upload" : "download"} size="small" />
        </span>
      </span>
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

async function readFile(
  id: string,
  name: string,
  bytes: ArrayBuffer,
  format: ImportFormat,
  model: DataModel | null,
  templates: Parameters<typeof readSheets>[2],
): Promise<ImportFile> {
  try {
    const sheets = await readSheets(bytes, format, templates);
    return {
      id,
      name,
      bytes,
      format,
      sheets,
      states: sheets.map((sheet) => initialState(sheet, model)),
      error: sheets.length ? null : "The file has no tables to import.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      name,
      bytes,
      format,
      sheets: [],
      states: [],
      error: `Failed to read this file as a ${format === "excel" ? "spreadsheet" : "text file"}: ${message}`,
    };
  }
}

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
  const { data: model = null } = useQuery({
    ...dataModelQuery(config?.data_model_latest ?? ""),
    enabled: !!config?.data_model_latest,
    select: unwrapModel,
  });
  const templateActions = useTemplateActions(!!user);

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

  // Every sheet's import, and the blocks of the ready ones.
  const imports = useMemo(
    () =>
      files.map((file) =>
        file.sheets.map((sheet, j) => computeSheet(sheet.rows, file.states[j], model)),
      ),
    [files, model],
  );
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
    const read = await Promise.all(
      sorted.map((f) =>
        readFile(
          crypto.randomUUID(),
          f.name,
          f.bytes,
          f.format ?? guessFormat(f.name, f.bytes),
          model,
          templates,
        ),
      ),
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

  const setFormat = async (i: number, format: ImportFormat) => {
    const file = files[i];
    const read = await readFile(file.id, file.name, file.bytes, format, model, templates);
    setFiles((current) => current.map((f, k) => (k === i ? read : f)));
  };

  const setSheetState = (i: number, j: number, state: SheetState) =>
    setFiles((current) =>
      current.map((f, k) =>
        k === i ? { ...f, states: f.states.map((s, l) => (l === j ? state : s)) } : f,
      ),
    );

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
      for (const file of files) formData.append("originals", new Blob([file.bytes]), file.name);
      const headers: Record<string, string> = { "Idempotency-Key": crypto.randomUUID() };
      if (expected) headers["If-Match"] = expected;
      await api<ContributionOut>(`/private/contributions/${id}/import`, {
        method: "POST",
        formData,
        headers,
      });
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
            <button
              type="button"
              aria-label="Choose files to upload"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cx(
                "upload-dropzone grid w-full cursor-pointer items-center px-6 py-10 text-center",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                dragging && "bg-node-soft",
              )}
              style={{ gridTemplateColumns: "1fr auto 1fr" }}
            >
              <span className="flex flex-col items-center gap-2">
                <Icon name="folder-open" size="huge" className="text-node-ink" />
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  Click and select
                </span>
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  files to upload.
                </span>
              </span>
              <span
                aria-hidden="true"
                className="mx-6 flex flex-col items-center gap-1 text-[12px] font-bold text-gray-400"
              >
                <span className="h-10 w-px bg-gray-300" />
                OR
                <span className="h-10 w-px bg-gray-300" />
              </span>
              <span className="flex flex-col items-center gap-2">
                <Icon name="external" size="huge" className="text-node-ink" />
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  Drag and drop files
                </span>
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  here to upload.
                </span>
              </span>
            </button>
            {config && (
              <p className="mt-2 text-center text-xs text-gray-400">
                {key} text files, tab- or comma-delimited tables, or Excel workbooks (one table per
                sheet); data model version {config.data_model_latest}
              </p>
            )}
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
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
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
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
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
          </>
        )}

        {step === 2 && (
          <div>
            <h3 className="mb-2 text-[1.1em] font-bold text-gray-800">
              Reading and translating the {files.length === 1 ? "file" : "files"} for uploading:
            </h3>
            {reading && <Spinner className="h-5 w-5" label="Reading…" />}
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
                  {(imports[i] ?? []).filter((r) => r.nErrors > 0).length > 0 && (
                    <Badge variant="danger">
                      {(imports[i] ?? []).filter((r) => r.nErrors > 0).length} Table(s) With Import
                      Errors
                    </Badge>
                  )}
                </div>
                <label className="mt-2 flex items-center gap-2 text-[13px]">
                  <span className="shrink-0 font-semibold text-gray-700">Import File Type</span>
                  <select
                    className="rounded-md border border-gray-300 bg-surface px-2 py-1.5 text-[13px]"
                    value={file.format}
                    onChange={(event) => setFormat(i, event.target.value as ImportFormat)}
                  >
                    {FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {formatLabel(format, key)}
                      </option>
                    ))}
                  </select>
                </label>
                {file.error ? (
                  <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-800">
                    {file.error}
                  </p>
                ) : (
                  file.sheets.map((sheet, j) => (
                    <DataImporter
                      // biome-ignore lint/suspicious/noArrayIndexKey: a file's sheets are positional and re-read together
                      key={`${file.id}-${file.format}-${j}`}
                      sheet={sheet}
                      state={file.states[j]}
                      onChange={(state) => setSheetState(i, j, state)}
                      model={model}
                      templates={templateActions}
                    />
                  ))
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
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" onClick={reset}>
                Start over
              </Button>
              <Button onClick={() => setStep(3)} disabled={!importReady || reading}>
                Continue
              </Button>
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
                        <td className="pr-6">{rows.toLocaleString()} rows</td>
                        {target !== null && (
                          <td>
                            {existing[table] !== undefined
                              ? `${existing[table].toLocaleString()} rows, replaced`
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
                            <td>{rows.toLocaleString()} rows, kept</td>
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
                  <Link to="/private">
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
