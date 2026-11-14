import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { isNodeAdmin } from "../lib/admin";
import { api, download } from "../lib/api";
import { useAuth } from "../lib/auth";
import { siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { useOpenContribution } from "../lib/contribution-modal";
import type {
  ContributionOut,
  ContributionStatus,
  JobOut,
  ReferenceCheck,
  SearchLevel,
  SearchResult,
} from "../lib/types";
import { abbreviateNumber, cx, formatDate, getPath, singularize } from "../lib/utils";
import { ContributionEditor } from "./contribution-editor";
import { ErrorMessage } from "./error-message";
import { SummaryGrid } from "./summary-grid";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";
import { Spinner } from "./ui/spinner";
import { fetchValidation, ValidationModal, validationKey } from "./validation-modal";
import { WorkspaceFields } from "./workspace-fields";

// One private-workspace contribution as a card: a header with what it is and
// its everyday actions, then (in preparation) its details beside a checklist
// of what publishing needs, or (published) what can still be done with it,
// and the contribution's summary row at the bottom.

/** The API (re)processes a contribution after every upload and saved edit:
 * parse, validate, summarize, then `ready` (or `failed`). */
const PROCESSING = new Set<ContributionStatus>([
  "uploaded",
  "parsing",
  "validating",
  "summarizing",
]);

export const isProcessing = (contribution: ContributionOut) => PROCESSING.has(contribution.status);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Publish checklist ----------------------------------------------------------

type StepState = "done" | "todo" | "blocked" | "working" | "optional";

interface Step {
  key: string;
  state: StepState;
  /** What is done, or (not done) what to do next, as a short imperative. */
  label: string;
  detail?: ReactNode;
}

/** Whether a step still stands between the contribution and Publish. */
const blocks = (step: Step) => step.state !== "done" && step.state !== "optional";

function StepIcon({ state }: { state: StepState }) {
  const base = "flex h-5 w-5 shrink-0 items-center justify-center rounded-full";
  if (state === "working")
    return (
      <span className={base}>
        <Spinner />
      </span>
    );
  if (state === "done")
    return (
      <span className={cx(base, "bg-success text-white")}>
        <Icon name="check" size="small" />
      </span>
    );
  if (state === "blocked")
    return (
      <span className={cx(base, "bg-danger text-white")}>
        <Icon name="close" size="small" />
      </span>
    );
  return (
    <span
      className={cx(
        base,
        "border-2 bg-surface",
        state === "optional" ? "border-dashed border-gray-300" : "border-gray-400",
      )}
    />
  );
}

function Checklist({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((step) => (
        <li key={step.key} className="flex gap-2.5">
          <StepIcon state={step.state} />
          <div className="min-w-0 pt-px text-[13px] leading-snug">
            <div
              className={cx(
                "font-medium",
                step.state === "done" || step.state === "optional"
                  ? "text-gray-600"
                  : step.state === "blocked"
                    ? "text-error-ink"
                    : "text-gray-900",
              )}
            >
              {step.label}
            </div>
            {step.detail && <div className="mt-0.5 text-[12px] text-gray-500">{step.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// --- Shared bits ------------------------------------------------------------------

/** A small secondary button that is a link (Preview, View). */
const linkButton =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-surface px-3.5 py-2 text-[13px] font-medium text-gray-800 transition-colors hover:bg-gray-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node focus-visible:ring-offset-2";

/** An in-preparation card's left edge by readiness: errors red, warnings or
 * steps still to do amber, ready green. */
const readinessEdge = {
  checking: "border-l-node",
  danger: "border-l-danger",
  warning: "border-l-amber-400",
  success: "border-l-success",
} as const;

const fieldLabel = (warn: boolean) =>
  cx(
    "flex shrink-0 items-center whitespace-nowrap rounded-l-sm px-[0.8em] text-[12px] font-bold",
    warn ? "bg-danger text-white" : "bg-panel-strong text-gray-700",
  );

function ConfirmModal({
  title,
  children,
  confirm,
  pendingLabel,
  pending,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirm: string;
  pendingLabel: string;
  pending: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={pending}>
            {pending ? pendingLabel : confirm}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-gray-700">{children}</div>
    </Modal>
  );
}

/** The card's title: the contributor's name for it (else its file name),
 * renamed in place. */
function NameTitle({
  contribution,
  disabled,
  status,
}: {
  contribution: ContributionOut;
  disabled: boolean;
  status: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (name: string) =>
      api<ContributionOut>(`/private/contributions/${contribution.id}/name`, {
        method: "PUT",
        json: { name },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["private", "contributions"] });
      setEditing(false);
    },
  });
  const title = contribution.name || contribution.filename || `Contribution ${contribution.id}`;
  const inputId = `name-${contribution.id}`;

  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-1 flex-wrap gap-y-1"
        style={{ flexBasis: "20em" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!save.isPending) save.mutate(draft);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Contribution name
        </label>
        <div className="flex min-w-0 flex-1">
          <input
            id={inputId}
            // biome-ignore lint/a11y/noAutofocus: opened by the Rename button, so focus follows the click
            autoFocus
            value={draft}
            maxLength={255}
            placeholder="A name to help you remember which contribution you are working on"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
            className="min-w-0 flex-1 rounded-l-sm border border-gray-300 bg-surface px-2 py-1 text-[14px] font-semibold text-gray-900 placeholder:font-normal placeholder:text-ink-faint focus:border-node focus:outline-hidden"
          />
          <button
            type="submit"
            disabled={save.isPending}
            className="shrink-0 bg-node px-2.5 py-1 text-[12px] font-medium text-white hover:bg-node-dark disabled:opacity-60"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="shrink-0 rounded-r-sm border border-l-0 border-gray-300 bg-surface px-2.5 py-1 text-[12px] font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
        {save.error && <ErrorMessage error={save.error} className="basis-full" />}
      </form>
    );
  }
  return (
    <>
      <h2 className="min-w-0 truncate text-[15px] font-semibold text-gray-900" title={title}>
        {title}
      </h2>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(contribution.name ?? "");
          save.reset();
          setEditing(true);
        }}
        title="Give this contribution a name of your own"
        className="inline-flex items-center gap-1 rounded-sm px-1 text-[12px] text-gray-500 hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node disabled:opacity-50"
      >
        <Icon name="edit" size="small" /> Rename
      </button>
      {status}
    </>
  );
}

/** In preparation, the record counts per search level (what search's Counts
 * tile shows), each opening the private preview at that level. */
function Contents({
  contribution,
  doc,
  processing,
}: {
  contribution: ContributionOut;
  doc: SearchResult;
  processing: boolean;
}) {
  const { data: config } = useNodeConfig();
  const openContribution = useOpenContribution();
  const counts = (config?.search_levels ?? [])
    .filter((entry) => entry.count_field)
    .map((entry) => ({ entry, count: getPath(doc, entry.count_field as string) }))
    .filter(
      (item): item is { entry: SearchLevel; count: number } =>
        typeof item.count === "number" && item.count > 0,
    );
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        Contents
      </span>
      {counts.length === 0 ? (
        <span className="text-gray-500">
          {processing
            ? "Counted once the file is processed."
            : contribution.filename
              ? "No records counted."
              : "No data file yet."}
        </span>
      ) : (
        counts.map(({ entry, count }) => (
          <button
            key={entry.name}
            type="button"
            onClick={() =>
              openContribution(String(contribution.id), entry.table, undefined, {
                privateKey: contribution.private_key,
              })
            }
            title={`Show this contribution's ${entry.name}`}
            className="text-gray-700 hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          >
            <span className="font-semibold">{abbreviateNumber(count)}</span>{" "}
            {count === 1 ? singularize(entry.name) : entry.name}
          </button>
        ))
      )}
    </div>
  );
}

// --- The card ---------------------------------------------------------------------

export function ContributionCard({
  contribution,
  successor,
  onJump,
}: {
  contribution: ContributionOut;
  /** The contribution's next version, when one has been started. */
  successor?: ContributionOut;
  /** Show another of the caller's contributions (switching list if needed). */
  onJump: (target: ContributionOut | number) => void;
}) {
  const { data: config } = useNodeConfig();
  const queryClient = useQueryClient();
  const published = contribution.is_activated;
  const [editorOpen, setEditorOpen] = useState(false);
  const [doi, setDoi] = useState(contribution.reference_doi ?? "");
  const [modal, setModal] = useState<
    null | "share" | "delete" | "publish" | "results" | "reassign"
  >(null);
  const [reassignTo, setReassignTo] = useState("");
  const { user } = useAuth();
  // The contributor or a node admin may hand a private contribution to someone else.
  const canReassign =
    !published && (contribution.contributor_id === user?.id || isNodeAdmin(user, config?.slug));
  const [validating, setValidating] = useState(false);
  const [copied, setCopied] = useState<null | "private" | "public">(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["private", "contributions"] });
  const closeModal = () => setModal(null);

  const workspaceFields = config?.workspace?.fields ?? [];
  const requiredFields = workspaceFields.filter((field) => field.required);
  // A node may require the DOI to resolve (Crossref / DataCite) before Publish.
  const requireReference = config?.workspace?.require_reference ?? false;
  const processing = isProcessing(contribution);

  // The head revision's validation; the key carries the status too, so the
  // result is read again once processing a saved edit finishes.
  const validation = useQuery({
    queryKey: [...validationKey(contribution), contribution.status],
    queryFn: () => fetchValidation(contribution.id),
    enabled: !published && !!contribution.filename && !processing,
  });
  // The saved workspace fields (the same query WorkspaceFields edits through).
  const cells = useQuery({
    queryKey: ["private", "fields", contribution.id, contribution.head_revision],
    queryFn: () => api<Record<string, string>>(`/private/contributions/${contribution.id}/fields`),
    enabled:
      !published &&
      requiredFields.length > 0 &&
      !!contribution.head_revision &&
      !!contribution.filename,
  });
  const reference = useQuery({
    queryKey: ["private", "reference", contribution.id, contribution.reference_doi],
    queryFn: () => api<ReferenceCheck>(`/private/contributions/${contribution.id}/reference`),
    enabled: requireReference && !published && !!contribution.reference_doi,
    staleTime: 60_000,
  });

  const doiMutation = useMutation({
    mutationFn: () =>
      api<ContributionOut>(`/private/contributions/${contribution.id}/reference`, {
        method: "PUT",
        json: {
          doi: doi.trim(),
          expected_revision: contribution.head_revision,
          request_key: crypto.randomUUID(),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["private", "reference", contribution.id] });
      await invalidate();
    },
    onError: setActionError,
  });

  const mutationFor = (path: string, method: "POST" | "DELETE", after?: () => void) => ({
    mutationFn: () =>
      api<ContributionOut | undefined>(`/private/contributions/${contribution.id}${path}`, {
        method,
      }),
    onSuccess: async () => {
      closeModal();
      await invalidate();
      after?.();
    },
    onError: (err: unknown) => {
      closeModal();
      setActionError(err);
    },
  });
  const activateMutation = useMutation(mutationFor("/activate", "POST"));
  const deleteMutation = useMutation(mutationFor("", "DELETE"));
  // Errors stay in the modal, where the address can be corrected.
  const reassignMutation = useMutation({
    mutationFn: () =>
      api<ContributionOut>(`/private/contributions/${contribution.id}/contributor`, {
        method: "PUT",
        json: { user: reassignTo.trim() },
      }),
    onSuccess: async () => {
      closeModal();
      setReassignTo("");
      await invalidate();
    },
  });
  const downloadMutation = useMutation({
    mutationFn: () =>
      download(
        `/private/contributions/${contribution.id}/download`,
        contribution.filename ?? `contribution_${contribution.id}.txt`,
      ),
    onError: setActionError,
  });
  const versionMutation = useMutation({
    mutationFn: () =>
      api<ContributionOut>(`/private/contributions/${contribution.id}/versions`, {
        method: "POST",
      }),
    onSuccess: async (created) => {
      await invalidate();
      onJump(created);
    },
    onError: setActionError,
  });

  const validate = async () => {
    setActionError(null);
    setValidating(true);
    try {
      const before = (await fetchValidation(contribution.id))?.validated_at;
      await api<JobOut>(`/private/contributions/${contribution.id}/validate`, {
        method: "POST",
      });
      for (let attempt = 0; ; attempt++) {
        await sleep(2000);
        const result = await fetchValidation(contribution.id);
        if (result && result.validated_at !== before) {
          await invalidate();
          await queryClient.invalidateQueries({ queryKey: validationKey(contribution) });
          setModal("results");
          break;
        }
        if (attempt >= 60) throw new Error("Validation timed out; try refreshing later.");
      }
    } catch (err) {
      setActionError(err);
    } finally {
      setValidating(false);
    }
  };

  const pagePath = siteUrl(`/contributions/${contribution.id}`);
  const publicUrl = `${window.location.origin}${pagePath}`;
  const privateUrl = `${publicUrl}?private_key=${contribution.private_key ?? ""}`;
  const copy = async (which: "private" | "public") => {
    try {
      await navigator.clipboard.writeText(which === "private" ? privateUrl : publicUrl);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      setActionError(err);
    }
  };

  const busy =
    validating ||
    doiMutation.isPending ||
    activateMutation.isPending ||
    deleteMutation.isPending ||
    versionMutation.isPending ||
    reassignMutation.isPending;

  // The current file, through the workspace's own access check.
  const downloadButton = contribution.head_revision ? (
    <Button
      variant="secondary"
      onClick={() => {
        setActionError(null);
        downloadMutation.mutate();
      }}
      disabled={downloadMutation.isPending}
    >
      <Icon name="download" size="small" />{" "}
      {downloadMutation.isPending ? "Downloading…" : "Download"}
    </Button>
  ) : null;

  // --- What publishing still needs, in the order to do it ---------------------
  const steps: Step[] = [];
  if (!published) {
    steps.push(
      contribution.filename
        ? // The file name is already in the header.
          { key: "file", state: "done", label: "Data file uploaded" }
        : {
            key: "file",
            state: "blocked",
            label: "Upload a data file",
            detail: "This contribution has no file yet. Add one under Edit · History · Files.",
          },
    );
    for (const field of requiredFields) {
      const filled = !!cells.data?.[field.column]?.trim();
      steps.push({
        key: `field-${field.column}`,
        state: cells.data ? (filled ? "done" : "todo") : cells.isFetching ? "working" : "todo",
        label: filled ? `${field.label} filled in` : `Fill in ${field.label}`,
        detail: filled ? undefined : "Required. Choose a value under Details, then Save.",
      });
    }
    const savedDoi = contribution.reference_doi?.trim();
    if (!requireReference) {
      steps.push(
        savedDoi
          ? { key: "doi", state: "done", label: "DOI added", detail: savedDoi }
          : {
              key: "doi",
              state: "optional",
              label: "Add a DOI (optional)",
              detail: "The study's DOI links the data to its publication.",
            },
      );
    } else if (!savedDoi) {
      steps.push({
        key: "doi",
        state: "todo",
        label: "Add the study's DOI",
        detail: "Required. Enter it under Details, then Save.",
      });
    } else if (reference.isPending) {
      steps.push({ key: "doi", state: "working", label: "Checking the DOI…" });
    } else if (reference.data?.status === "ok") {
      steps.push({
        key: "doi",
        state: "done",
        label: "DOI found",
        detail: reference.data.citation ?? savedDoi,
      });
    } else {
      steps.push({
        key: "doi",
        state: "blocked",
        label:
          reference.data?.status === "not_found"
            ? "Wait for the DOI to register"
            : "Check the DOI again",
        detail:
          reference.data?.status === "not_found"
            ? "Crossref and DataCite don't know this DOI yet. A new paper's DOI can take up to a day to register; Save it again to recheck."
            : "The DOI registries could not be reached. Save the DOI again to retry.",
      });
    }
    const viewResults = (
      <button
        type="button"
        onClick={() => setModal("results")}
        className="text-node-ink underline hover:opacity-80"
      >
        View results
      </button>
    );
    if (!contribution.filename) {
      steps.push({ key: "validation", state: "todo", label: "Pass validation" });
    } else if (processing || validating) {
      steps.push({
        key: "validation",
        state: "working",
        label: "Checking the data…",
        detail: "Validation runs after every upload and every saved change.",
      });
    } else if (contribution.status === "failed") {
      steps.push({
        key: "validation",
        state: "blocked",
        label: "Fix the file: it could not be read",
        detail: (
          <>
            {validation.data?.errors[0]?.message && (
              <span className="block font-mono text-[11px] break-words text-error-ink">
                {validation.data.errors[0].message}
              </span>
            )}
            Correct it under Edit · History · Files; saving re-validates it.
          </>
        ),
      });
    } else if (validation.isPending) {
      steps.push({ key: "validation", state: "working", label: "Loading the validation…" });
    } else if (!validation.data) {
      steps.push({
        key: "validation",
        state: "todo",
        label: "Validate the data",
        detail: "This version has not been validated yet.",
      });
    } else if (validation.data.is_valid) {
      const warnings = validation.data.warnings.length;
      steps.push({
        key: "validation",
        state: "done",
        label: "Validation passed",
        detail: (
          <>
            {warnings > 0 && `${warnings} warning${warnings === 1 ? "" : "s"} · `}
            {viewResults}
          </>
        ),
      });
    } else {
      const errors = validation.data.errors.length;
      steps.push({
        key: "validation",
        state: "blocked",
        label: `Fix ${errors} validation error${errors === 1 ? "" : "s"}`,
        detail: (
          <>
            {viewResults} · Correct the file under Edit · History · Files; saving re-validates it.
          </>
        ),
      });
    }
  }
  const remaining = steps.filter(blocks);
  const canPublish = !published && remaining.length === 0 && !busy;
  const validationStep = steps.find((step) => step.key === "validation");
  // Validate leads only when nothing has been validated; re-running it on a
  // file with errors changes nothing until the file is fixed.
  const validateFirst = validationStep?.state === "todo";
  const canValidate = !!contribution.filename && !processing && !busy;

  // --- Header -------------------------------------------------------------------
  const superseded = published && successor?.is_activated;
  // In preparation, how close to Publish (the card edge and badge share it):
  // errors (a blocked step) red, warnings or steps still to do amber, ready green.
  const hasWarnings = validationStep?.state === "done" && !!validation.data?.warnings.length;
  const readiness: "checking" | "danger" | "warning" | "success" =
    processing || validating
      ? "checking"
      : remaining.some((step) => step.state === "blocked")
        ? "danger"
        : remaining.length > 0 || hasWarnings
          ? "warning"
          : "success";
  const status: ReactNode = published ? (
    superseded ? (
      <Badge variant="muted">Superseded by version {successor?.version}</Badge>
    ) : (
      <Badge variant="success">
        <Icon name="check" size="small" /> Published
      </Badge>
    )
  ) : readiness === "checking" ? (
    <Badge>
      <Spinner size="xs" /> Checking
    </Badge>
  ) : remaining.length === 0 ? (
    <Badge variant={readiness}>Ready to publish</Badge>
  ) : (
    <Badge variant={readiness}>
      {remaining.length} step{remaining.length === 1 ? "" : "s"} before publishing
    </Badge>
  );
  const meta = [
    // Once named, the file name moves down here.
    contribution.name && contribution.filename,
    `Contribution ${contribution.id}`,
    `Version ${contribution.version}`,
    published && contribution.activated_at
      ? `Published ${formatDate(contribution.activated_at)}`
      : `Updated ${formatDate(contribution.updated_at)}`,
    contribution.data_model_version && `Data model ${contribution.data_model_version}`,
  ].filter(Boolean);

  // The contribution's search doc (its level counts, what the Counts and Plot
  // tiles read), refetched as the contribution changes; until it is indexed,
  // a doc of the workspace's own fields, which stay the fresher either way.
  const contributionLevel = config?.search_levels.find(
    (entry) => entry.table === "contribution",
  ) ?? { name: "Contributions", table: "contribution", count_field: null };
  const indexed = useQuery({
    queryKey: ["contribution", contribution.id, contribution.private_key, contribution.updated_at],
    queryFn: () =>
      api<SearchResult>(`/contributions/${contribution.id}`, {
        params: { private_key: contribution.private_key || undefined },
      }),
    retry: false,
  });
  const indexedSummary = (indexed.data?.summary ?? {}) as Record<string, unknown>;
  const doc: SearchResult = {
    ...indexed.data,
    _is_activated: contribution.is_activated,
    summary: {
      ...indexedSummary,
      contribution: {
        ...((indexedSummary.contribution as Record<string, unknown> | undefined) ?? {}),
        id: contribution.id,
        version: contribution.version,
        timestamp: contribution.updated_at,
        _contributor: contribution.contributor_name,
      },
    },
  };

  const doiDirty = doi.trim() !== (contribution.reference_doi ?? "");
  const doiRecheck = requireReference && !!reference.data && reference.data.status !== "ok";

  // Title, meta line, status.
  const identity = (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <NameTitle contribution={contribution} disabled={busy} status={status} />
      </div>
      <p className="mt-0.5 text-[12px] text-gray-500">
        {meta.join(" · ")}
        {contribution.previous_id && (
          <>
            {" · New version of "}
            <button
              type="button"
              onClick={() => onJump(contribution.previous_id as number)}
              className="text-node-ink underline hover:opacity-80"
            >
              contribution {contribution.previous_id}
            </button>
          </>
        )}
      </p>
    </div>
  );
  // Everyday actions.
  const actions = (
    <div className="flex flex-wrap items-center gap-1.5">
      {published ? (
        <>
          <a href={pagePath} className={linkButton}>
            <Icon name="external" size="small" /> View
          </a>
          <Button variant="secondary" onClick={() => copy("public")}>
            <Icon name="share" size="small" /> {copied === "public" ? "Copied!" : "Copy link"}
          </Button>
          {downloadButton}
          <Button variant="secondary" onClick={() => setEditorOpen(true)}>
            <Icon name="folder-open" size="small" /> History · Files
          </Button>
        </>
      ) : (
        <>
          <a href={privateUrl} className={linkButton}>
            <Icon name="external" size="small" /> Preview
          </a>
          <Button
            variant="secondary"
            onClick={() => setModal("share")}
            disabled={busy || !contribution.private_key}
          >
            <Icon name="share" size="small" /> Share
          </Button>
          {downloadButton}
          {/* Legacy "Add Data to This Contribution" (MagIC #327): the upload
              page with this contribution as its target. */}
          <Link to="/upload" search={{ to: contribution.id }} className={linkButton}>
            <Icon name="upload" size="small" /> Add Data
          </Link>
          <Button variant="secondary" onClick={() => setEditorOpen(true)} disabled={busy}>
            <Icon name="edit" size="small" /> Edit · History · Files
          </Button>
          {canReassign && (
            <Button variant="secondary" onClick={() => setModal("reassign")} disabled={busy}>
              <Icon name="user" size="small" /> Reassign
            </Button>
          )}
          <Button variant="danger" onClick={() => setModal("delete")} disabled={busy}>
            <Icon name="trash" size="small" /> Delete
          </Button>
        </>
      )}
    </div>
  );

  return (
    <article
      id={`contribution-${contribution.id}`}
      className={cx(
        "mb-5 scroll-mt-14 rounded-md border border-l-4 border-gray-200 bg-surface shadow-xs",
        published
          ? superseded
            ? "border-l-gray-300"
            : "border-l-success"
          : readinessEdge[readiness],
      )}
    >
      {published ? (
        <>
          {/* Header: identity, status, everyday actions */}
          <header className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-gray-100 px-4 py-3">
            {identity}
            {actions}
          </header>
          {/* Published: what can still be done with it */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
            <div className="min-w-0 flex-1 text-[13px] text-gray-700" style={{ flexBasis: "20em" }}>
              {superseded ? (
                <p>
                  Version {successor?.version} (contribution {successor?.id}) replaced this one in
                  search. This version stays available at its link.
                </p>
              ) : (
                <p>
                  Public in search. Published data can't change: to correct or extend it, create a
                  new version, which stays private until you publish it.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {successor ? (
                <Button
                  variant={superseded ? "secondary" : "primary"}
                  onClick={() => onJump(successor)}
                >
                  {superseded
                    ? `Go to version ${successor.version}`
                    : `Continue version ${successor.version} (in preparation)`}
                  <Icon name="chevron-right" size="small" />
                </Button>
              ) : (
                <Button onClick={() => versionMutation.mutate()} disabled={busy}>
                  <Icon name="plus" size="small" />
                  {versionMutation.isPending ? "Creating…" : "Create new version"}
                </Button>
              )}
            </div>
          </div>
          {actionError !== null && (
            <div className="px-4 pb-3">
              <ErrorMessage error={actionError} />
            </div>
          )}
        </>
      ) : (
        /* In preparation: the header, actions and details on the left; what
           publishing needs down the card's full right side. */
        <div className="lg:flex">
          <div className="min-w-0 flex-1">
            <header className="border-b border-gray-100 px-4 py-3">
              {identity}
              <div className="mt-2.5">{actions}</div>
            </header>
            <section aria-labelledby={`details-${contribution.id}`} className="min-w-0 px-4 py-3">
              <h3
                id={`details-${contribution.id}`}
                className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
              >
                Details
              </h3>
              {workspaceFields.length > 0 && (
                <WorkspaceFields
                  contribution={contribution}
                  fields={workspaceFields}
                  disabled={busy}
                />
              )}
              <form
                className="flex min-w-0"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!doiMutation.isPending) doiMutation.mutate();
                }}
              >
                <label
                  htmlFor={`doi-${contribution.id}`}
                  className={fieldLabel(requireReference && !doi.trim())}
                >
                  DOI
                </label>
                <Input
                  id={`doi-${contribution.id}`}
                  value={doi}
                  onChange={(event) => setDoi(event.target.value)}
                  placeholder={requireReference ? "The study's DOI (required)" : "10.1029/…"}
                  title="After your paper is published, its DOI can take up to a day to register (usually an hour or two). Save the DOI again to check once more."
                  className={cx(
                    "flex-1 rounded-none py-1 text-[13px]",
                    requireReference && !doi.trim() && "border-danger",
                  )}
                />
                <button
                  type="submit"
                  disabled={busy || (!doiDirty && !doiRecheck)}
                  className={cx(
                    "shrink-0 rounded-r-sm px-3 py-1 text-[13px] font-medium whitespace-nowrap disabled:cursor-not-allowed",
                    doiDirty
                      ? "bg-danger text-white hover:bg-danger-dark disabled:opacity-60"
                      : "border border-l-0 border-gray-300 bg-surface text-gray-700 hover:bg-gray-50 disabled:opacity-50",
                  )}
                >
                  {doiMutation.isPending ? "Saving…" : doiRecheck && !doiDirty ? "Recheck" : "Save"}
                </button>
              </form>
              {reference.data?.status === "ok" && reference.data.title && (
                <p className="mt-1.5 text-[12px] text-gray-600" title={reference.data.title}>
                  <Icon name="check" size="small" /> {reference.data.citation ?? "DOI found"} —{" "}
                  {reference.data.title}
                </p>
              )}
              <Contents
                contribution={contribution}
                doc={doc}
                processing={processing || validating}
              />
            </section>
            {actionError !== null && (
              <div className="px-4 pb-3">
                <ErrorMessage error={actionError} />
              </div>
            )}
          </div>
          <section
            aria-labelledby={`publish-${contribution.id}`}
            className="shrink-0 rounded-b-md border-t border-gray-200 bg-panel-hover px-4 py-3 lg:w-80 lg:rounded-r-md lg:rounded-bl-none lg:border-t-0 lg:border-l"
          >
            <h3
              id={`publish-${contribution.id}`}
              className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500"
            >
              Publishing
            </h3>
            <Checklist steps={steps} />
            <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-200 pt-3">
              <Button
                variant={validateFirst && canValidate ? "primary" : "secondary"}
                onClick={validate}
                disabled={!canValidate}
              >
                {validating ? "Validating…" : validation.data ? "Validate again" : "Validate"}
              </Button>
              <Button
                variant={canPublish ? "primary" : "secondary"}
                onClick={() => setModal("publish")}
                disabled={!canPublish}
                title={
                  remaining.length
                    ? `Publish unlocks once these are done: ${remaining.map((step) => step.label).join("; ")}`
                    : "Publishing makes the data public and fixes this version; later changes need a new version."
                }
              >
                <Icon name="globe" size="small" /> Publish
              </Button>
            </div>
          </section>
        </div>
      )}

      {published && (
        /* A published contribution's summary row, as search shows it */
        <div className="overflow-x-auto rounded-b-md border-t border-gray-100 px-4 pt-px">
          <SummaryGrid
            level={contributionLevel}
            hits={[doc]}
            privateKey={contribution.private_key}
          />
        </div>
      )}

      {editorOpen && (
        <ContributionEditor
          contribution={contribution}
          onClose={() => {
            setEditorOpen(false);
            invalidate();
          }}
        />
      )}

      {modal === "share" && (
        <Modal
          open
          onClose={closeModal}
          title={`Share Contribution ${contribution.id}`}
          footer={
            <>
              <Button variant="secondary" onClick={closeModal}>
                Close
              </Button>
              <Button onClick={() => copy("private")}>
                {copied === "private" ? "Copied!" : "Copy"}
              </Button>
            </>
          }
        >
          <p className="mb-2 text-sm text-gray-600">
            Anyone with this link can view this private contribution:
          </p>
          <Input readOnly value={privateUrl} onFocus={(event) => event.target.select()} />
        </Modal>
      )}

      {modal === "reassign" && (
        <Modal
          open
          onClose={() => {
            closeModal();
            reassignMutation.reset();
          }}
          title={`Reassign Contribution ${contribution.id}`}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  closeModal();
                  reassignMutation.reset();
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => reassignMutation.mutate()}
                disabled={!reassignTo.trim() || reassignMutation.isPending}
              >
                {reassignMutation.isPending ? "Reassigning…" : "Reassign"}
              </Button>
            </>
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (reassignTo.trim()) reassignMutation.mutate();
            }}
          >
            <label
              htmlFor={`reassign-${contribution.id}`}
              className="mb-2 block text-sm text-gray-600"
            >
              Make another EarthRef user the contributor of this private contribution. Enter their
              email address or handle:
            </label>
            <Input
              id={`reassign-${contribution.id}`}
              value={reassignTo}
              onChange={(event) => setReassignTo(event.target.value)}
              placeholder="name@example.org or handle"
              autoFocus
            />
            {contribution.contributor_id === user?.id && (
              <p className="mt-2 text-sm text-gray-600">
                It leaves your workspace unless you share a workspace with them.
              </p>
            )}
            {reassignMutation.error && (
              <div className="mt-3">
                <ErrorMessage error={reassignMutation.error} />
              </div>
            )}
          </form>
        </Modal>
      )}

      {modal === "delete" && (
        <ConfirmModal
          title={`Delete Contribution ${contribution.id}?`}
          confirm="Delete"
          pendingLabel="Deleting…"
          pending={deleteMutation.isPending}
          danger
          onConfirm={() => deleteMutation.mutate()}
          onClose={closeModal}
        >
          <p className="font-medium text-error-ink">Warning! You cannot undo this delete.</p>
        </ConfirmModal>
      )}

      {modal === "publish" && (
        <ConfirmModal
          title={`Publish Contribution ${contribution.id}?`}
          confirm="Publish"
          pendingLabel="Publishing…"
          pending={activateMutation.isPending}
          onConfirm={() => activateMutation.mutate()}
          onClose={closeModal}
        >
          <p className="font-medium text-gray-800">Warning! Your data will be publicly visible.</p>
          <p>Published data can't be changed. To correct it later, create a new version.</p>
        </ConfirmModal>
      )}

      {modal === "results" && <ValidationModal contribution={contribution} onClose={closeModal} />}
    </article>
  );
}
