/**
 * What upgrading a contribution to the latest data model did (legacy MagIC
 * upgrade_contribution.jsx's warnings and errors): errors and warnings in
 * full, the renames, merges and conversions in a collapsed list, and each
 * blank the old model gave a default meaning to as a choice (MagIC #521).
 */
import type { UpgradeNote, UpgradeResult } from "../lib/upgrade";
import { notesByLevel } from "../lib/upgrade";
import { Badge } from "./ui/badge";

const count = (n: number) => (n > 1 ? ` (${n.toLocaleString()} rows)` : "");

function NoteList({ notes, className }: { notes: UpgradeNote[]; className: string }) {
  return (
    <ul className={`list-disc space-y-0.5 pl-5 ${className}`}>
      {notes.map((note) => (
        <li key={`${note.step}|${note.kind}|${note.message}`}>
          {note.message}
          {count(note.count)}
        </li>
      ))}
    </ul>
  );
}

export function UpgradeReportPanel({
  result,
  modelName,
  onDefault,
  busy = false,
}: {
  result: UpgradeResult;
  /** "MagIC Data Model". */
  modelName: string;
  /** Switch a blank default on or off (re-runs the upgrade). */
  onDefault?: (key: string, on: boolean) => void;
  busy?: boolean;
}) {
  const report = result.report;
  if (!report) return null;
  const { error, warning, info } = notesByLevel(report);
  const unknown = warning.some((n) => n.kind === "unknown_column" || n.kind === "unknown_table");
  const offered = report.defaults.filter((d) => d.count > 0);
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">
          Upgraded from {modelName} version {report.from_version} to {report.to_version}
        </span>
        {report.guessed && <Badge variant="warning">version guessed</Badge>}
        {error.length > 0 && <Badge variant="danger">{error.length} Upgrade Error(s)</Badge>}
        {warning.length > 0 && <Badge variant="warning">{warning.length} Upgrade Warning(s)</Badge>}
      </div>
      {error.length > 0 && <NoteList notes={error} className="mt-1 text-red-800" />}
      {warning.length > 0 && <NoteList notes={warning} className="mt-1 text-amber-900" />}
      {unknown && (
        <p className="mt-1">
          Columns and tables the old data model does not define are kept under their own names: map
          them to a {report.to_version} column or exclude them below.
        </p>
      )}
      {offered.length > 0 && (
        <fieldset className="mt-2" disabled={busy || !onDefault}>
          <legend className="font-semibold">
            Blank values the {report.from_version} data model gave a default meaning to:
          </legend>
          {offered.map((d) => (
            <label key={d.key} className="mt-0.5 flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={d.on}
                onChange={(event) => onDefault?.(d.key, event.target.checked)}
              />
              <span>
                {d.label} <span className="text-gray-500">({d.count.toLocaleString()} blank)</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {info.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer font-semibold">
            {info.length} renamed, merged or converted column(s) and table(s)
          </summary>
          <NoteList notes={info} className="mt-1 text-gray-700" />
        </details>
      )}
    </div>
  );
}
