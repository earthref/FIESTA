import { useQuery } from "@tanstack/react-query";
import {
  Download,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Lock,
  Paperclip,
  Trash2,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { download, fetchFile } from "../lib/api";
import type { DataModel } from "../lib/types";
import { cx, formatBytes } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

/** GET /private/contributions/{id}/attachments: one file kept beside the
 * contribution's text (fiesta.services.attachments.cards). */
export type AttachmentCard = {
  name: string;
  size: number;
  sha256: string;
  kind: "image" | "svg" | "pdf" | "text" | "spreadsheet" | "archive" | "other";
  /** "upload": kept by the upload tool; "attachment": added here; null: older file. */
  origin: "upload" | "attachment" | null;
  added_at: string | null;
  /** Rows per table the file brought in (upload-tool originals). */
  rows: Record<string, number>;
  /** Rows per table that name the file. */
  referenced: Record<string, number>;
  /** Why it cannot be removed (null: it can). */
  locked: string | null;
};

/** Largest text file whose first lines a card shows, and largest SVG it draws. */
const TEXT_PREVIEW_BYTES = 256 * 1024;
const SVG_PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_LINES = 12;

const ICONS = {
  image: FileImage,
  svg: FileImage,
  pdf: FileText,
  text: FileText,
  spreadsheet: FileSpreadsheet,
  archive: FileArchive,
  other: File,
} as const;

export function AttachmentCards({
  base,
  cards,
  model,
  disabled,
  disabledNote,
  onAdd,
  onRemove,
}: {
  /** `/private/contributions/{id}`. */
  base: string;
  cards: AttachmentCard[] | undefined;
  model: DataModel | null | undefined;
  /** Adding and removing are off (read-only, busy, or unsaved table edits). */
  disabled: boolean;
  /** Why they are off, when it is something the user can change. */
  disabledNote?: string;
  onAdd: (files: File[]) => void;
  onRemove: (name: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const label = (table: string) => model?.tables[table]?.label ?? table;
  const add = (picked: FileList | null) => {
    const files = Array.from(picked ?? []);
    if (disabled || files.length === 0) return;
    const replaced = files.filter((f) => cards?.some((c) => c.name === f.name));
    if (
      replaced.length &&
      !window.confirm(`Replace ${replaced.map((f) => f.name).join(", ")} with the new file?`)
    )
      return;
    onAdd(files);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    add(event.dataTransfer.files);
  };
  return (
    <section
      aria-label="Attachments"
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cx(
        "min-h-[55vh] rounded-md border border-dashed p-3",
        dragging ? "border-node bg-node-soft" : "border-gray-300",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={disabled} onClick={() => input.current?.click()}>
          <Paperclip className="mr-1.5 inline size-4" aria-hidden />
          Add files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Add attachments"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="text-[13px] text-gray-600">
          {disabledNote ??
            "Drop files here to attach them: figures, scripts, notebooks or anything that goes with the data. Files the upload tool brought rows in from, and files a row names, are kept."}
        </span>
      </div>
      {cards === undefined ? null : cards.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">No files are attached.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cards.map((card) => (
            <li
              key={card.name}
              className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-surface shadow-xs"
            >
              <Thumbnail base={base} card={card} />
              <div className="flex flex-1 flex-col gap-2 p-3 text-[13px]">
                <div>
                  <p className="truncate font-semibold text-gray-900" title={card.name}>
                    {card.name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatBytes(card.size)}
                    {card.added_at && ` · added ${new Date(card.added_at).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {card.origin === "upload" && <Badge variant="node">Upload tool</Badge>}
                  {card.origin === "attachment" && <Badge>Attached</Badge>}
                </div>
                {card.origin === "upload" && (
                  <RowCounts
                    title="Rows brought in"
                    counts={card.rows}
                    label={label}
                    empty="Written by the upload tool (no rows)"
                  />
                )}
                <RowCounts
                  title="Rows that name it"
                  counts={card.referenced}
                  label={label}
                  empty="Not named by any row"
                />
                <div className="mt-auto flex items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void download(
                        `${base}/attachments/${encodeURIComponent(card.name)}`,
                        card.name,
                      )
                    }
                  >
                    <Download className="mr-1 inline size-3.5" aria-hidden />
                    Download
                  </Button>
                  {card.locked ? (
                    <span
                      className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500"
                      title={`Cannot be removed: ${card.locked}`}
                    >
                      <Lock className="size-3.5" aria-hidden />
                      Kept
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="danger"
                      className="ml-auto"
                      disabled={disabled}
                      onClick={() => window.confirm(`Remove ${card.name}?`) && onRemove(card.name)}
                    >
                      <Trash2 className="mr-1 inline size-3.5" aria-hidden />
                      Remove
                    </Button>
                  )}
                </div>
                {card.locked && <p className="text-xs text-gray-500">Kept: {card.locked}.</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RowCounts({
  title,
  counts,
  label,
  empty,
}: {
  title: string;
  counts: Record<string, number>;
  label: (table: string) => string;
  empty: string;
}) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  return (
    <div>
      <p className="text-xs font-medium text-gray-700">{title}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-gray-500">{empty}</p>
      ) : (
        <ul className="text-xs text-gray-700">
          {entries.map(([table, n]) => (
            <li key={table} className="flex justify-between gap-2">
              <span className="truncate">{label(table)}</span>
              <span className="tabular-nums">
                {n.toLocaleString()} row{n === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The card's preview: a server thumbnail (images, PDFs), the SVG itself, the
 * first lines of a small text file, else the file type's icon. */
function Thumbnail({ base, card }: { base: string; card: AttachmentCard }) {
  const path = `${base}/attachments/${encodeURIComponent(card.name)}`;
  const mode =
    card.kind === "image" || card.kind === "pdf"
      ? "thumbnail"
      : card.kind === "svg" && card.size <= SVG_PREVIEW_BYTES
        ? "svg"
        : card.kind === "text" && card.size <= TEXT_PREVIEW_BYTES
          ? "text"
          : null;
  const preview = useQuery({
    queryKey: [path, "preview", card.sha256, mode],
    enabled: mode !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () => {
      if (mode === "thumbnail") {
        const { blob } = await fetchFile(`${path}/thumbnail`, { params: { sha: card.sha256 } });
        return { blob };
      }
      const { blob } = await fetchFile(path);
      if (mode === "svg") return { blob: new Blob([blob], { type: "image/svg+xml" }) };
      const lines = (await blob.slice(0, 16 * 1024).text()).split(/\r?\n/).slice(0, PREVIEW_LINES);
      return { text: lines.join("\n") };
    },
  });
  const url = useObjectUrl(preview.data?.blob);
  const Icon = ICONS[card.kind] ?? File;
  return (
    <div className="flex h-36 items-center justify-center overflow-hidden border-b border-gray-100 bg-gray-50">
      {url ? (
        <img src={url} alt="" className="max-h-full max-w-full object-contain" />
      ) : preview.data?.text !== undefined ? (
        <pre className="h-full w-full overflow-hidden p-2 font-mono text-[10px] leading-tight text-gray-600">
          {preview.data.text}
        </pre>
      ) : (
        <span className="flex flex-col items-center gap-1 text-gray-400">
          <Icon className="size-10" aria-hidden />
          <span className="text-[11px] font-semibold uppercase">
            {card.name.includes(".") ? card.name.split(".").pop() : "file"}
          </span>
        </span>
      )}
    </div>
  );
}

function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
