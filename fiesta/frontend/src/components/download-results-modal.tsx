import { useEffect, useRef, useState } from "react";
import { fetchFile, saveBlob } from "../lib/api";
import { orderedColumns } from "../lib/contribution-grid";
import type { DataModel, SearchLevel } from "../lib/types";
import { ErrorMessage } from "./error-message";
import { useLatestDataModel } from "./filter-modals";
import { Button } from "./ui/button";
import { CountLabel } from "./ui/count-label";
import { Modal } from "./ui/modal";
import { Spinner } from "./ui/spinner";

/** Contribution files a download zips at most (search.py MAX_DOWNLOAD_FILES). */
const MAX_FILES = 100;

type Format = "txt" | "xlsx" | "json";

/** The search a download repeats: the open level's table and its request
 * params (query, ranges, area, column filters, sort, with/without data, scope). */
export interface DownloadSearch {
  table: string;
  params: Record<string, string | number | boolean | undefined | string[]>;
}

/** Legacy SearchDownload (MagIC search_download.jsx): Download Results opens a
 * modal choosing what to download, the matching contributions' files (all of
 * their tables) or the matching rows of one or more levels, and the format. */
export function DownloadResultsModal({
  open,
  onClose,
  nodeKey,
  levels,
  counts,
  search,
}: {
  open: boolean;
  onClose: () => void;
  nodeKey: string;
  /** The search levels, the contribution's first. */
  levels: SearchLevel[];
  /** Each level's matches (undefined while counting), by table. */
  counts: Record<string, number | undefined>;
  search: DownloadSearch;
}) {
  const rowLevels = levels.filter((level) => level.table !== "contribution");
  // Contribution files from the Contributions level, else the open level's rows.
  const [files, setFiles] = useState(search.table === "contribution" || rowLevels.length === 0);
  const [tables, setTables] = useState<string[]>(() =>
    rowLevels.some((level) => level.table === search.table)
      ? [search.table]
      : rowLevels.slice(0, 1).map((level) => level.table),
  );
  const [picked, setFormat] = useState<Format>("txt");
  // Contribution files are text or JSON: a picked Excel falls back to text.
  const format = files && picked === "xlsx" ? "txt" : picked;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const dataModel = useLatestDataModel();
  useEffect(() => () => abort.current?.abort(), []);

  const nContributions = counts.contribution;
  const chosen = files ? ["contribution"] : tables;
  const empty = chosen.every((table) => counts[table] === 0);
  const toggleTable = (table: string) => {
    setFiles(false);
    setTables((now) => (now.includes(table) ? now.filter((t) => t !== table) : [...now, table]));
  };

  const start = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const file = await fetchFile(`/search/${search.table}/download`, {
        signal: controller.signal,
        params: {
          ...search.params,
          files: files || undefined,
          tables: files ? undefined : levels.map((l) => l.table).filter((t) => tables.includes(t)),
          // Excel is built here from the JSON tables.
          format: format === "xlsx" ? "json" : format,
        },
      });
      const fallback = `${nodeKey} Download.${files ? "zip" : format}`;
      if (format === "xlsx") {
        const name = (file.name ?? fallback).replace(/\.json$/, ".xlsx");
        const data = JSON.parse(await file.blob.text()) as Record<string, Record<string, string>[]>;
        saveBlob(await workbook(data, dataModel), name);
      } else {
        saveBlob(file.blob, file.name ?? fallback);
      }
      if (file.truncated) setNote(`The download stopped at ${file.truncated}.`);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught);
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  };

  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
  };

  const formats: { value: Format; label: string; title?: string }[] = [
    { value: "txt", label: files ? `${nodeKey} Text Files` : `${nodeKey} Text File` },
    {
      value: "xlsx",
      label: "Excel Spreadsheet",
      title: files ? "Contribution files download as text or JSON" : undefined,
    },
    { value: "json", label: files ? "JSON Files" : "JSON File" },
  ];
  const formatOff = (value: Format) => files && value === "xlsx";

  return (
    <Modal
      open={open}
      onClose={() => {
        cancel();
        onClose();
      }}
      title="Download Results"
      largeTitle
      footer={
        <div className="flex justify-end gap-2">
          {busy ? (
            <Button variant="danger" onClick={cancel}>
              Cancel Download
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          )}
          <Button onClick={start} disabled={busy || chosen.length === 0 || empty}>
            {busy && <Spinner size="xs" />}
            {busy ? "Preparing…" : files ? "Download Files" : "Download Rows"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4 text-[13px] text-ink">
        <fieldset disabled={busy} className="space-y-1">
          <legend className="mb-1.5 font-bold text-ink-strong">Download</legend>
          <label className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="download-what"
              checked={files}
              onChange={() => setFiles(true)}
              className="accent-[var(--node-color)]"
            />
            <span className={files ? "font-bold" : undefined}>Contribution files</span>
            <span className="text-ink-muted">(including all tables)</span>
            <span className="ml-auto">
              <CountLabel inline>{countText(nContributions)}</CountLabel>
            </span>
          </label>
          {rowLevels.length > 0 && (
            <>
              <label className="flex cursor-pointer items-center gap-2 py-0.5">
                <input
                  type="radio"
                  name="download-what"
                  checked={!files}
                  onChange={() => setFiles(false)}
                  className="accent-[var(--node-color)]"
                />
                <span className={files ? undefined : "font-bold"}>Rows of the tables</span>
              </label>
              <div className="space-y-1 pl-6">
                {rowLevels.map((level) => (
                  <label
                    key={level.table}
                    className="flex cursor-pointer items-center gap-2 py-0.5"
                  >
                    <input
                      type="checkbox"
                      checked={!files && tables.includes(level.table)}
                      onChange={() => toggleTable(level.table)}
                      className="accent-[var(--node-color)]"
                    />
                    <span
                      className={!files && tables.includes(level.table) ? "font-bold" : undefined}
                    >
                      {level.name}
                    </span>
                    <span className="ml-auto">
                      <CountLabel inline>{countText(counts[level.table])}</CountLabel>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>
        <fieldset disabled={busy} className="space-y-1 border-t border-line pt-3">
          <legend className="sr-only">Format</legend>
          <div className="mb-1.5 font-bold text-ink-strong">Format</div>
          {formats.map((option) => (
            <label
              key={option.value}
              title={formatOff(option.value) ? option.title : undefined}
              className={`flex items-center gap-2 py-0.5 ${
                formatOff(option.value) ? "cursor-default opacity-45" : "cursor-pointer"
              }`}
            >
              <input
                type="radio"
                name="download-format"
                value={option.value}
                disabled={formatOff(option.value)}
                checked={format === option.value}
                onChange={() => setFormat(option.value)}
                className="accent-[var(--node-color)]"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p className="border-t border-line pt-3 text-ink-muted">
          {files
            ? `The files of the first ${MAX_FILES} matching contributions, in the search's order, in one zip archive.`
            : "One table per level, each with the matching records' rows."}{" "}
          It may take a few minutes to prepare; the file appears in your browser's downloads.
        </p>
        {files && (nContributions ?? 0) > MAX_FILES && (
          <p className="text-ink-muted">
            {nContributions?.toLocaleString()} contributions match: narrow the search to download
            the others.
          </p>
        )}
        {note && <p className="font-bold">{note}</p>}
        {error !== undefined && <ErrorMessage error={error} />}
      </div>
    </Modal>
  );
}

function countText(count: number | undefined): string {
  return count === undefined ? "…" : count.toLocaleString();
}

/** The tables as an Excel workbook, a sheet per table laid out as legacy
 * ExportContribution.toExcel did: Group / Name / Type / Column header rows
 * (from the data model), then the rows, each after a blank first cell. */
async function workbook(
  tables: Record<string, Record<string, string>[]>,
  model: DataModel | null | undefined,
): Promise<Blob> {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  for (const [table, rows] of Object.entries(tables)) {
    if (rows.length === 0) continue;
    const modelTable = model?.tables[table];
    const present = new Set(rows.flatMap((row) => Object.keys(row)));
    const columns = orderedColumns(modelTable).filter((c) => present.has(c));
    columns.push(...[...present].filter((c) => !columns.includes(c)).sort());
    let previousGroup: string | undefined;
    const groups = columns.map((c) => {
      const group = modelTable?.columns[c]?.group ?? "";
      const shown = group === previousGroup ? "" : group;
      previousGroup = group;
      return shown;
    });
    const data = [
      ["Group: ", ...groups],
      ["Name: ", ...columns.map((c) => modelTable?.columns[c]?.label ?? c)],
      [
        "Type: ",
        ...columns.map((c) => modelTable?.columns[c]?.unit || modelTable?.columns[c]?.type || ""),
      ],
      ["Column: ", ...columns],
      ...rows.map((row) => ["", ...columns.map((c) => row[c] ?? "")]),
    ];
    // Sheet names are at most 31 characters.
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), table.slice(0, 31));
  }
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
