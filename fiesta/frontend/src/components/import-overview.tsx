/**
 * The top of the upload page's Step 2: one line per sheet across every file
 * (where it goes, how much of it, what it needs), problems first, with
 * upload-wide shortcuts. A clean current-version file reads as all Ready and
 * goes straight to Continue; anything else is one click from its card.
 */
import type { SheetReview } from "../lib/import-review";
import type { SheetImport } from "../lib/importer";
import { STATUS_STYLE } from "./data-importer";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export interface OverviewEntry {
  key: string;
  title: string;
  table: string;
  known: boolean;
  result: SheetImport;
  review: SheetReview;
}

const ORDER: Record<SheetReview["status"], number> = { fix: 0, review: 1, ready: 2, skipped: 3 };

export function ImportOverview({
  entries,
  nFiles,
  fileProblems,
  onOpen,
  onAcceptAll,
  onLeaveOutUnmatched,
  nSoft,
  nUnmatched,
}: {
  entries: OverviewEntry[];
  nFiles: number;
  /** Files that could not be read, or that the upgrade reports on. */
  fileProblems: number;
  onOpen: (key: string) => void;
  onAcceptAll: () => void;
  onLeaveOutUnmatched: () => void;
  nSoft: number;
  nUnmatched: number;
}) {
  const count = (status: SheetReview["status"]) =>
    entries.filter((e) => e.review.status === status).length;
  const rows = entries
    .filter((e) => e.review.status !== "skipped")
    .reduce((n, e) => n + e.result.nRows, 0);
  const sorted = [...entries].sort((a, b) => ORDER[a.review.status] - ORDER[b.review.status]);
  const allReady = entries.length > 0 && count("fix") === 0 && count("review") === 0;
  return (
    <div className="mb-2 rounded-md border border-gray-200 bg-gray-50/60 px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-gray-900">
          {nFiles} {nFiles === 1 ? "file" : "files"}, {entries.length}{" "}
          {entries.length === 1 ? "table" : "tables"}, {rows.toLocaleString()}{" "}
          {rows === 1 ? "row" : "rows"} to import
        </span>
        {count("fix") > 0 && <Badge variant="danger">{count("fix")} to fix</Badge>}
        {count("review") > 0 && <Badge variant="warning">{count("review")} to review</Badge>}
        {count("ready") > 0 && <Badge variant="success">{count("ready")} ready</Badge>}
        {count("skipped") > 0 && <Badge variant="muted">{count("skipped")} skipped</Badge>}
        {fileProblems > 0 && (
          <Badge variant="warning">
            {fileProblems} {fileProblems === 1 ? "file" : "files"} with notes
          </Badge>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {nSoft > 0 && (
            <Button size="sm" variant="secondary" onClick={onAcceptAll}>
              Accept all {nSoft} suggested {nSoft === 1 ? "match" : "matches"}
            </Button>
          )}
          {nUnmatched > 0 && (
            <Button size="sm" variant="secondary" onClick={onLeaveOutUnmatched}>
              Leave out all {nUnmatched} unmatched {nUnmatched === 1 ? "column" : "columns"}
            </Button>
          )}
        </span>
      </div>
      {allReady && (
        <p className="mt-1 text-gray-600">
          Every table and column was recognized. Continue, or open a table below to check it.
        </p>
      )}
      {entries.length > 1 && (
        <table className="mt-2 w-full border-collapse text-[12px]">
          <tbody>
            {sorted.map((e) => {
              const style = STATUS_STYLE[e.review.status];
              const columns = e.result.inColumnNames.length;
              const imported = e.result.nColumns;
              return (
                <tr key={e.key} className="border-t border-gray-200 first:border-t-0">
                  <td className="w-20 py-1 pr-2">
                    <Badge variant={style.badge}>{style.label}</Badge>
                  </td>
                  <td className="py-1 pr-2 font-semibold text-gray-900">{e.title}</td>
                  <td className="py-1 pr-2 text-gray-700">
                    → {e.known ? e.table : <em className="text-red-700">no table</em>}
                  </td>
                  <td className="hidden py-1 pr-2 text-right text-gray-600 sm:table-cell">
                    {e.review.status === "skipped"
                      ? ""
                      : `${e.result.nRows.toLocaleString()} ${e.result.nRows === 1 ? "row" : "rows"}`}
                  </td>
                  <td className="hidden py-1 pr-2 text-right text-gray-600 sm:table-cell">
                    {e.review.status === "skipped" ? "" : `${imported} of ${columns} columns`}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {e.review.nFix > 0 && (
                      <span className="text-red-700">{e.review.nFix} to fix </span>
                    )}
                    {e.review.nReview > 0 && (
                      <span className="text-amber-800">{e.review.nReview} to review</span>
                    )}
                  </td>
                  <td className="w-16 py-1 text-right">
                    <button
                      type="button"
                      className="text-node-ink underline"
                      onClick={() => onOpen(e.key)}
                    >
                      {e.review.status === "fix" || e.review.status === "review"
                        ? "Review"
                        : "Open"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
