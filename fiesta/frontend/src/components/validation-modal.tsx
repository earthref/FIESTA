import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../lib/api";
import type { ContributionOut, ValidationIssue, ValidationResult } from "../lib/types";
import { cx, formatDate } from "../lib/utils";
import { ErrorMessage } from "./error-message";
import { Icon } from "./ui/icon";
import { Modal } from "./ui/modal";
import { PageSpinner } from "./ui/spinner";

/** The validation of the contribution's head revision, or null when that
 * revision has not been validated (every saved edit starts a new revision). */
export async function fetchValidation(id: number): Promise<ValidationResult | null> {
  try {
    return await api<ValidationResult>(`/private/contributions/${id}/validation`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Cache key of a contribution's validation: per head revision, so a saved
 * edit never shows the previous revision's result. */
export const validationKey = (contribution: ContributionOut) => [
  "private",
  "validation",
  contribution.id,
  contribution.head_revision,
];

function groupByTable(issues: ValidationIssue[]): [string, ValidationIssue[]][] {
  const map = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.table) ?? [];
    list.push(issue);
    map.set(issue.table, list);
  }
  return [...map.entries()];
}

function IssueGroup({
  table,
  issues,
  tone,
}: {
  table: string;
  issues: ValidationIssue[];
  tone: "danger" | "warning";
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-sm border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
      >
        <span
          aria-hidden="true"
          className={cx("text-gray-400 transition-transform", open && "rotate-90")}
        >
          <Icon name="caret-right" size="small" />
        </span>
        {table}
        <span
          className={cx(
            "inline-block min-w-[3em] rounded-full border bg-surface px-2 py-0.5 text-center text-xs font-medium",
            tone === "danger" ? "border-red-300 text-red-700" : "border-amber-300 text-amber-700",
          )}
        >
          {issues.length}
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-gray-100 border-t border-gray-100">
          {issues.map((issue, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: validation issues have no id and can repeat per row/column; list is static per result
              key={`${issue.column}-${issue.row}-${index}`}
              className="px-3 py-1.5 text-sm text-gray-700"
            >
              {issue.row !== null && <span className="text-gray-400">Row {issue.row}: </span>}
              {issue.column && <span className="font-mono text-xs">{issue.column}</span>}{" "}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ValidationModal({
  contribution,
  onClose,
}: {
  contribution: ContributionOut;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: validationKey(contribution),
    queryFn: () => fetchValidation(contribution.id),
  });

  const result = query.data;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Validation results — Contribution ${contribution.id}`}
      wide
    >
      {query.isPending && <PageSpinner label="Loading validation results…" />}
      {query.error && <ErrorMessage error={query.error} />}
      {result === null && !query.isPending && !query.error && (
        <p className="text-sm text-gray-600">
          This version of the contribution has not been validated yet. Use the Validate button on
          its card.
        </p>
      )}
      {result && (
        <div className="space-y-3">
          {result.is_valid ? (
            <p className="rounded-sm border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
              Validation passed successfully!
            </p>
          ) : (
            <p className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-error-ink">
              {result.errors.length} Validation Error{result.errors.length === 1 ? "" : "s"}
            </p>
          )}
          <p className="text-xs text-gray-500">Validated {formatDate(result.validated_at)}</p>
          {groupByTable(result.errors).map(([table, issues]) => (
            <IssueGroup key={`error-${table}`} table={table} issues={issues} tone="danger" />
          ))}
          {result.warnings.length > 0 && (
            <>
              <h3 className="pt-2 text-sm font-semibold text-amber-700">
                Warnings ({result.warnings.length})
              </h3>
              {groupByTable(result.warnings).map(([table, issues]) => (
                <IssueGroup key={`warning-${table}`} table={table} issues={issues} tone="warning" />
              ))}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
