import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ContributionEditor } from "../components/contribution-editor";
import { ErrorMessage } from "../components/error-message";
import { useLoginModal } from "../components/login-modal";
import { ResultItem } from "../components/result-item";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Modal } from "../components/ui/modal";
import { PageSpinner, Spinner } from "../components/ui/spinner";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import type {
  ContributionOut,
  JobOut,
  SearchResult,
  ValidationIssue,
  ValidationResult,
} from "../lib/types";
import { cx, formatDate } from "../lib/utils";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchValidation(id: number): Promise<ValidationResult | null> {
  try {
    return await api<ValidationResult>(`/api/private/contributions/${id}/validation`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Attached-segment style: 1px borders bleeding 1px past the card edges. */
const segmentBleed = { width: "calc(100% + 2px)", marginLeft: -1 } as const;

// --- Validation results modal --------------------------------------------------

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
            "inline-block min-w-[3em] rounded-full border bg-white px-2 py-0.5 text-center text-xs font-medium",
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

function ValidationModal({
  contribution,
  onClose,
}: {
  contribution: ContributionOut;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["private", "validation", contribution.id],
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
          This contribution has not been validated yet. Use the Validate button on its card.
        </p>
      )}
      {result && (
        <div className="space-y-3">
          {result.is_valid ? (
            <p className="rounded-sm border border-green-300 bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
              Validation passed successfully!
            </p>
          ) : (
            <p className="rounded-sm border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-[#9F3A38]">
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

// --- Contribution card (stacked attached segments) -------------------------------

function ContributionCard({ contribution }: { contribution: ContributionOut }) {
  const { data: config } = useNodeConfig();
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState(contribution.filename ?? `Contribution ${contribution.id}`);
  const [doi, setDoi] = useState(contribution.reference_doi ?? "");
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["private", "contributions"] });

  const validation = useQuery({
    queryKey: ["private", "validation", contribution.id],
    queryFn: () => fetchValidation(contribution.id),
    enabled: contribution.status === "ready" && !contribution.is_activated,
  });

  const doiMutation = useMutation({
    mutationFn: () =>
      api<ContributionOut>(`/api/private/contributions/${contribution.id}/reference`, {
        method: "PUT",
        json: {
          doi: doi.trim(),
          expected_revision: contribution.head_revision,
          request_key: crypto.randomUUID(),
        },
      }),
    onSuccess: invalidate,
    onError: setActionError,
  });

  const activateMutation = useMutation({
    mutationFn: () =>
      api<ContributionOut>(`/api/private/contributions/${contribution.id}/activate`, {
        method: "POST",
      }),
    onSuccess: () => {
      setPublishOpen(false);
      invalidate();
    },
    onError: (err) => {
      setPublishOpen(false);
      setActionError(err);
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: () =>
      api<ContributionOut>(`/api/private/contributions/${contribution.id}/deactivate`, {
        method: "POST",
      }),
    onSuccess: invalidate,
    onError: setActionError,
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      api<void>(`/api/private/contributions/${contribution.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleteOpen(false);
      invalidate();
    },
    onError: (err) => {
      setDeleteOpen(false);
      setActionError(err);
    },
  });

  const validate = async () => {
    setActionError(null);
    setValidating(true);
    try {
      const before = (await fetchValidation(contribution.id))?.validated_at;
      await api<JobOut>(`/api/private/contributions/${contribution.id}/validate`, {
        method: "POST",
      });
      for (let attempt = 0; ; attempt++) {
        await sleep(2000);
        const result = await fetchValidation(contribution.id);
        if (result && result.validated_at !== before) {
          queryClient.setQueryData(["private", "validation", contribution.id], result);
          setResultsOpen(true);
          break;
        }
        if (attempt >= 60) throw new Error("Validation timed out; try refreshing later.");
      }
      invalidate();
    } catch (err) {
      setActionError(err);
    } finally {
      setValidating(false);
    }
  };

  const shareUrl = `${window.location.origin}${siteUrl(`/contributions/${contribution.id}`)}?private_key=${contribution.private_key ?? ""}`;

  const share = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setActionError(err);
    }
  };

  const busy =
    validating ||
    doiMutation.isPending ||
    activateMutation.isPending ||
    deactivateMutation.isPending ||
    deleteMutation.isPending;
  const isValid = validation.data?.is_valid === true;
  const doiMissing = !doi.trim() && !contribution.is_activated;

  // Synthesized search doc so the bottom segment reuses the collapsed result card.
  const contributionLevel = config?.search_levels.find(
    (entry) => entry.table === "contribution",
  ) ?? { name: "Contributions", table: "contribution", count_field: null };
  const doc: SearchResult = {
    _is_activated: contribution.is_activated,
    summary: {
      contribution: {
        id: contribution.id,
        version: contribution.version,
        timestamp: contribution.updated_at,
        _contributor: contribution.contributor_name,
      },
    },
  };

  return (
    <div style={{ marginBottom: "1.5em" }}>
      {/* 1. Inverted node-color top attached segment */}
      <div
        className="flex flex-wrap items-center rounded-t-sm bg-node text-white"
        style={{ ...segmentBleed, padding: "0.5em", border: "1px solid rgba(34,36,38,.15)" }}
      >
        <div className="flex min-w-0" style={{ flex: "1 1 auto" }}>
          <label
            htmlFor={`name-${contribution.id}`}
            className="flex items-center whitespace-nowrap rounded-l-sm bg-[#e8e8e8] px-[0.8em] text-[12px] font-bold text-gray-700"
          >
            Private Contribution Name
          </label>
          <input
            id={`name-${contribution.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1 bg-white px-2 py-1 text-[13px] text-gray-900 focus:outline-hidden"
            style={{ borderRadius: 0 }}
          />
          <button
            type="button"
            disabled
            title="Renaming is coming soon"
            className="cursor-not-allowed rounded-r-sm bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white opacity-60"
            style={{ marginRight: 0 }}
          >
            Save
          </button>
        </div>
        {!contribution.is_activated && (
          <>
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              disabled={busy || !contribution.private_key}
              className="rounded-sm bg-white/95 px-2.5 py-1 text-[12px] font-medium text-gray-800 hover:bg-white disabled:opacity-50"
              style={{ margin: "0 0 0 0.5em" }}
            >
              Share
            </button>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              disabled={busy}
              className="rounded-sm bg-white/95 px-2.5 py-1 text-[12px] font-medium text-gray-800 hover:bg-white disabled:opacity-50"
              style={{ margin: "0 0 0 0.5em" }}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {/* 2. DOI + status/actions: ui attached secondary segment */}
      <div
        className="flex flex-wrap items-center bg-[#f3f4f5]"
        style={{
          ...segmentBleed,
          padding: "0.5em",
          border: "1px solid rgba(34,36,38,.15)",
          borderTop: "none",
        }}
      >
        <form
          className="flex min-w-0"
          style={{ flex: "1 1 auto" }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!doiMutation.isPending) doiMutation.mutate();
          }}
        >
          <label
            htmlFor={`doi-${contribution.id}`}
            className={cx(
              "flex items-center whitespace-nowrap rounded-l-sm px-[0.8em] text-[12px] font-bold",
              doiMissing ? "bg-red-600 text-white" : "bg-[#e8e8e8] text-gray-700",
            )}
          >
            DOI
          </label>
          <Input
            id={`doi-${contribution.id}`}
            value={doi}
            onChange={(event) => setDoi(event.target.value)}
            placeholder="10.1029/…"
            className={cx(
              "flex-1 rounded-none py-1 text-[13px]",
              doiMissing && "border-red-400 bg-red-50",
            )}
          />
          <button
            type="submit"
            disabled={busy || doi.trim() === (contribution.reference_doi ?? "")}
            className="rounded-r-sm border border-l-0 border-gray-300 bg-white px-2.5 py-1 text-[12px] font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {doiMutation.isPending ? "Saving…" : "Save"}
          </button>
        </form>

        <span className="flex items-center" style={{ margin: "0 0 0 0.5em" }}>
          {validating ? (
            <Spinner label="Validating…" />
          ) : (
            <span className="rounded-sm bg-gray-200 px-2 py-1 text-[12px] font-medium text-gray-700">
              {contribution.status}
            </span>
          )}
          {validation.data && (
            <button
              type="button"
              onClick={() => setResultsOpen(true)}
              className="ml-2 text-[12px] text-node underline hover:opacity-80"
            >
              validation results
            </button>
          )}
        </span>

        <span className="flex items-center" style={{ margin: "0 0 0 0.5em" }}>
          {contribution.is_activated ? (
            <>
              <button
                type="button"
                disabled
                className="rounded-sm bg-green-600 px-2.5 py-1 text-[12px] font-medium text-white opacity-80"
              >
                Published
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => deactivateMutation.mutate()}
                className="ml-2 rounded-sm border border-gray-300 bg-white px-2.5 py-1 text-[12px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {deactivateMutation.isPending ? "Deactivating…" : "Deactivate"}
              </button>
            </>
          ) : contribution.status === "ready" && isValid ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setPublishOpen(true)}
              className="rounded-sm bg-node px-2.5 py-1 text-[12px] font-medium text-white hover:bg-node-dark disabled:opacity-50"
            >
              Publish
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !contribution.filename}
              onClick={validate}
              className="rounded-sm bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Validate
            </button>
          )}
        </span>
      </div>

      {actionError !== null && (
        <div style={{ ...segmentBleed, border: "1px solid rgba(34,36,38,.15)", borderTop: "none" }}>
          <ErrorMessage error={actionError} />
        </div>
      )}

      {/* 3. Bottom attached segment wrapping the collapsed result card */}
      <div
        className="rounded-b-sm bg-white"
        style={{
          ...segmentBleed,
          padding: "1px 1em 0",
          border: "1px solid rgba(34,36,38,.15)",
          borderTop: "none",
        }}
      >
        <ResultItem doc={doc} level={contributionLevel} privateKey={contribution.private_key} />
      </div>

      <div className="my-2 flex gap-2">
        <Button variant="secondary" onClick={() => setEditorOpen(true)}>
          Edit / History / Files
        </Button>
        {contribution.published_revision && (
          <Button
            onClick={async () => {
              try {
                await api(`/api/private/contributions/${contribution.id}/versions`, {
                  method: "POST",
                });
                await invalidate();
              } catch (error) {
                setActionError(error);
              }
            }}
          >
            Create new version
          </Button>
        )}
      </div>
      {editorOpen && (
        <ContributionEditor
          contribution={contribution}
          onClose={() => {
            setEditorOpen(false);
            invalidate();
          }}
        />
      )}
      {/* Modals */}
      {shareOpen && (
        <Modal
          open
          onClose={() => setShareOpen(false)}
          title={`Share Contribution ${contribution.id}`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShareOpen(false)}>
                Close
              </Button>
              <Button onClick={share}>{copied ? "Copied!" : "Copy"}</Button>
            </>
          }
        >
          <p className="mb-2 text-sm text-gray-600">
            Anyone with this link can view this private contribution:
          </p>
          <Input readOnly value={shareUrl} onFocus={(event) => event.target.select()} />
        </Modal>
      )}

      {deleteOpen && (
        <Modal
          open
          onClose={() => setDeleteOpen(false)}
          title={`Delete Contribution ${contribution.id}?`}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setDeleteOpen(false)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete"}
              </Button>
            </>
          }
        >
          <p className="text-sm font-medium text-[#9F3A38]">
            Warning! You cannot undo this delete.
          </p>
        </Modal>
      )}

      {publishOpen && (
        <Modal
          open
          onClose={() => setPublishOpen(false)}
          title={`Publish Contribution ${contribution.id}?`}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setPublishOpen(false)}
                disabled={activateMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => activateMutation.mutate()}
                disabled={activateMutation.isPending}
              >
                {activateMutation.isPending ? "Publishing…" : "Publish"}
              </Button>
            </>
          }
        >
          <p className="text-sm font-medium text-gray-800">
            Warning! Your data will be publicly visible.
          </p>
        </Modal>
      )}

      {resultsOpen && (
        <ValidationModal contribution={contribution} onClose={() => setResultsOpen(false)} />
      )}
    </div>
  );
}

// --- Page ---------------------------------------------------------------------

export function PrivateWorkspacePage() {
  const { user, isLoading: authLoading } = useAuth();
  const { openLogin } = useLoginModal();
  const [showPreparation, setShowPreparation] = useState(true);
  const [showPublished, setShowPublished] = useState(true);

  const list = useQuery({
    queryKey: ["private", "contributions"],
    queryFn: () => api<ContributionOut[]>("/api/private/contributions"),
    enabled: !!user,
  });

  if (authLoading) return <PageSpinner label="Checking your session…" />;

  if (!user) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <h1 className="mb-2 text-xl font-semibold text-gray-900">Private Workspace</h1>
        <p className="mb-5 text-sm text-gray-600">
          Log in to manage, validate, and publish your contributions.
        </p>
        <Button onClick={openLogin}>Log In / Register</Button>
      </div>
    );
  }

  const contributions = list.data ?? [];
  const preparationCount = contributions.filter((entry) => !entry.is_activated).length;
  const publishedCount = contributions.filter((entry) => entry.is_activated).length;
  const visible = contributions.filter((entry) =>
    entry.is_activated ? showPublished : showPreparation,
  );

  const countLabelStyle = {
    color: "#0C0C0C",
    margin: "-1em -0.5em -1em 0.5em",
    minWidth: "4em",
    padding: "0.5em",
  } as const;

  const toggleClass = (active: boolean) =>
    cx(
      "inline-flex items-center rounded-sm text-[13px] font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
      active
        ? "bg-node text-white hover:bg-node-dark"
        : "border border-gray-300 bg-white text-gray-500 hover:bg-gray-50",
    );

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center" style={{ gap: "0 1em" }}>
        <Link
          to="/upload"
          className="inline-flex items-center gap-1 rounded-sm bg-node px-3.5 py-2 text-[13px] font-medium text-white hover:bg-node-dark focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node focus-visible:ring-offset-2"
          style={{ margin: "0 0 0.5em" }}
        >
          <Icon name="plus" size="small" /> Upload Data Into Your Private Workspace
        </Link>
        <button
          type="button"
          onClick={() => setShowPreparation(!showPreparation)}
          aria-pressed={showPreparation}
          className={toggleClass(showPreparation)}
          style={{ margin: "0 1em 0.5em 0", padding: "0.6em 1.2em" }}
        >
          <Icon name="edit" size="small" />
          &nbsp;In Preparation
          <span
            className="inline-block rounded-full border border-gray-300 bg-white text-center text-[11px] font-medium"
            style={countLabelStyle}
          >
            {preparationCount}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setShowPublished(!showPublished)}
          aria-pressed={showPublished}
          className={toggleClass(showPublished)}
          style={{ margin: "0 1em 0.5em 0", padding: "0.6em 1.2em" }}
        >
          <Icon name="check" size="small" />
          &nbsp;Published
          <span
            className="inline-block rounded-full border border-gray-300 bg-white text-center text-[11px] font-medium"
            style={countLabelStyle}
          >
            {publishedCount}
          </span>
        </button>
      </div>

      {list.isPending && <PageSpinner label="Loading your contributions…" />}
      {list.error && <ErrorMessage error={list.error} />}

      {!list.isPending && !list.error && visible.length === 0 && (
        <div className="rounded-sm border border-amber-300 bg-amber-50 px-4">
          <p className="py-10 text-center text-lg font-medium text-amber-800">
            No Items to Display
          </p>
        </div>
      )}

      <div>
        {visible.map((contribution) => (
          <ContributionCard key={contribution.id} contribution={contribution} />
        ))}
      </div>
    </div>
  );
}
