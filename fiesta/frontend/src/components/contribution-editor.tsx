import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { isNodeAdmin } from "../lib/admin";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";
import { indexVocabularies, parseContribution } from "../lib/contribution-grid";
import { dataModelQuery, unwrapModel } from "../lib/data-model";
import type { ContributionOut, ValidationResult, Vocabularies } from "../lib/types";
import type { GridApi } from "./contribution-grid";
import { ErrorMessage } from "./error-message";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { PageSpinner } from "./ui/spinner";

// The grid is its own chunk: nothing of it loads until an editor opens.
const ContributionGrid = lazy(() =>
  import("./contribution-grid").then((m) => ({ default: m.ContributionGrid })),
);

type Content = { revision_id: string; text: string };
type Revision = {
  id: string;
  parent_id: string | null;
  created_at: string;
  operation: string;
  files: string[];
};
type Attachment = { name: string; size: number };
type Mode = "grid" | "text";
/** How long the editor waits for the worker to validate a saved revision (3 s polls). */
const VALIDATION_POLLS = 60;

export function ContributionEditor({
  contribution,
  onClose,
}: {
  contribution: ContributionOut;
  onClose: () => void;
}) {
  const base = `/private/contributions/${contribution.id}`;
  const cache = useQueryClient();
  const [mode, setMode] = useState<Mode>("grid");
  // The text mode's edits (null: none), and the text the grid starts from after them.
  const [textDraft, setTextDraft] = useState<string | null>(null);
  const [gridSeed, setGridSeed] = useState<string | null>(null);
  const [gridDirty, setGridDirty] = useState(false);
  const [gridKey, setGridKey] = useState(0);
  const gridApi = useRef<GridApi | null>(null);
  // A retried save of the same text reuses its idempotency key; new text gets a new one.
  const lastSave = useRef<{ text: string; key: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const content = useQuery({
    queryKey: [base, "content"],
    queryFn: () => api<Content>(`${base}/content`),
  });
  const history = useQuery({
    queryKey: [base, "history"],
    queryFn: () => api<Revision[]>(`${base}/revisions`),
  });
  const files = useQuery({
    queryKey: [base, "attachments"],
    queryFn: () => api<Attachment[]>(`${base}/attachments`),
  });
  const value = content.data;
  const { data: config } = useNodeConfig();
  const version = contribution.data_model_version || config?.data_model_latest || "";
  const model = useQuery({ ...dataModelQuery(version), enabled: !!version, select: unwrapModel });
  const vocabularies = useQuery({
    queryKey: ["vocabularies", "editor"],
    queryFn: async () => {
      const [controlled, plugins, suggested] = await Promise.all([
        api<Vocabularies>("/config/vocabularies/controlled"),
        api<Vocabularies>("/config/vocabularies/plugins").catch(() => ({})),
        api<Vocabularies>("/config/vocabularies/suggested").catch(() => ({})),
      ]);
      return { controlled, plugins, suggested };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const lookup = useMemo(
    () =>
      indexVocabularies(
        vocabularies.data?.controlled,
        vocabularies.data?.plugins,
        vocabularies.data?.suggested,
      ),
    [vocabularies.data],
  );
  // The saved revision's own validation (the worker runs one after each save).
  const revision = content.data?.revision_id;
  const validation = useQuery({
    queryKey: [base, "revision-validation", revision],
    queryFn: () => api<ValidationResult[]>(`${base}/revisions/${revision}/validation`),
    enabled: !!revision,
    refetchInterval: (query) =>
      query.state.data?.length === 0 && query.state.dataUpdateCount < VALIDATION_POLLS
        ? 3000
        : false,
  });
  const validationResult = validation.data?.[0] ?? null;
  const polls = cache.getQueryState([base, "revision-validation", revision])?.dataUpdateCount ?? 0;
  const validationPending = validation.data?.length === 0 && polls < VALIDATION_POLLS;

  const immutable = !!contribution.published_revision;
  const dirty = mode === "grid" ? gridDirty : textDraft !== null && textDraft !== value?.text;
  const onGridDirty = useCallback((next: boolean) => setGridDirty(next), []);
  const discard = () => {
    setTextDraft(null);
    setGridSeed(null);
    setGridDirty(false);
    setGridKey((k) => k + 1);
  };
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: [base] });
    await cache.invalidateQueries({ queryKey: ["private", "contributions"] });
    discard();
  };
  /** Runs one change and refreshes; false (with the error shown) if it failed. */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const text =
      mode === "grid" ? (gridApi.current?.getText() ?? "") : (textDraft ?? value?.text ?? "");
    if (lastSave.current?.text !== text) lastSave.current = { text, key: crypto.randomUUID() };
    const requestKey = lastSave.current.key;
    return run(() =>
      api(`${base}/content`, {
        method: "PUT",
        json: { text, expected_revision: value?.revision_id, request_key: requestKey },
      }),
    );
  };
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setError(null);
    if (next === "text") {
      setTextDraft(gridDirty ? (gridApi.current?.getText() ?? null) : gridSeed);
    } else {
      if (textDraft !== null && textDraft !== value?.text) {
        try {
          parseContribution(textDraft);
        } catch (e) {
          setError(new Error(`The text cannot be shown as a grid: ${(e as Error).message}`));
          return;
        }
        setGridSeed(textDraft);
      } else setGridSeed(null);
      setGridDirty(false);
      setGridKey((k) => k + 1);
    }
    setMode(next);
  };
  const close = () => {
    if (dirty && !window.confirm("Discard the unsaved edits?")) return;
    onClose();
  };
  // Only a node admin unpublishes (the API refuses everyone else).
  const { user } = useAuth();
  const admin = isNodeAdmin(user, config?.slug);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const loading = content.isPending || model.isPending || vocabularies.isPending;
  return (
    <Modal
      open
      full
      onClose={close}
      title={`Contribution ${contribution.id}: ${immutable ? "" : "Edit · "}History · Files`}
    >
      {immutable && <p>Published content is read-only. Create a new version to make changes.</p>}
      {(error || content.error || model.error) && (
        <ErrorMessage error={error || content.error || model.error} />
      )}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-gray-300">
          {(["grid", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => switchMode(m)}
              className={
                mode === m
                  ? "bg-node px-3 py-1 text-xs font-semibold text-white"
                  : "px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
              }
            >
              {m === "grid" ? "Grid" : "Text"}
            </button>
          ))}
        </div>
        {dirty && <span className="text-xs font-medium text-purple-700">Unsaved edits</span>}
        <span className="ml-auto flex gap-2">
          <Button disabled={immutable || busy || !dirty} onClick={save}>
            {busy ? "Saving…" : "Save revision"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !dirty}
            onClick={() => window.confirm("Discard the unsaved edits?") && discard()}
          >
            Cancel edits
          </Button>
        </span>
      </div>
      {mode === "grid" ? (
        loading || !value || !model.data ? (
          <PageSpinner label="Loading the contribution…" />
        ) : (
          <Suspense fallback={<PageSpinner label="Loading the editor…" />}>
            <ContributionGrid
              key={`${value.revision_id}:${gridKey}`}
              baseText={value.text}
              draftText={gridSeed}
              model={model.data}
              lookup={lookup}
              validation={validationResult}
              validationPending={validationPending}
              readOnly={immutable || busy}
              apiRef={gridApi}
              onDirtyChange={onGridDirty}
            />
          </Suspense>
        )
      ) : (
        <>
          <label className="block text-sm font-medium" htmlFor="contribution-text">
            Contribution text
          </label>
          <textarea
            id="contribution-text"
            className="my-2 min-h-[55vh] w-full border border-gray-300 bg-surface p-2 font-mono text-xs"
            value={textDraft ?? value?.text ?? ""}
            disabled={immutable || busy || !value}
            onChange={(e) => setTextDraft(e.target.value)}
          />
        </>
      )}
      <h3 className="mt-4 font-semibold">Attachments</h3>
      <input
        type="file"
        aria-label="Add attachment"
        disabled={immutable || busy || !value || dirty}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file || !value) return;
          const formData = new FormData();
          formData.append("file", file);
          void run(() =>
            api(`${base}/attachments/${encodeURIComponent(file.name)}`, {
              method: "PUT",
              formData,
              headers: { "If-Match": value.revision_id, "Idempotency-Key": crypto.randomUUID() },
            }),
          );
        }}
      />
      <ul>
        {files.data?.map((file) => (
          <li key={file.name} className="my-2 flex items-center gap-2">
            <span>
              {file.name} ({file.size} bytes)
            </span>
            <Button
              variant="secondary"
              disabled={immutable || busy || dirty}
              onClick={() =>
                run(() =>
                  api(`${base}/attachments/${encodeURIComponent(file.name)}`, {
                    method: "DELETE",
                    json: {
                      expected_revision: value?.revision_id,
                      request_key: crypto.randomUUID(),
                    },
                  }),
                )
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <h3 className="mt-4 font-semibold">Saved revisions</h3>
      <ul>
        {history.data?.map((revision) => (
          <li key={revision.id} className="my-2 flex items-center gap-2">
            <span>
              {new Date(revision.created_at).toLocaleString()} — {revision.operation}
            </span>
            <Button
              variant="secondary"
              disabled={immutable || busy || dirty || revision.id === value?.revision_id}
              onClick={() =>
                run(() =>
                  api(`${base}/revisions/${revision.id}/restore`, {
                    method: "POST",
                    json: {
                      expected_revision: value?.revision_id,
                      request_key: crypto.randomUUID(),
                    },
                  }),
                )
              }
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
      {admin && contribution.is_activated && (
        <section
          aria-labelledby={`admin-${contribution.id}`}
          className="mt-4 rounded-md border border-red-200 bg-red-50 p-3"
        >
          <h3 id={`admin-${contribution.id}`} className="font-semibold text-red-800">
            Admin
          </h3>
          <p className="my-1.5 text-sm text-gray-700">
            Unpublishing takes the contribution out of search and stops its public link; the private
            share link still works. It moves back to its contributor's In Preparation list, where it
            can be published again or deleted. Contributors cannot do this themselves: they correct
            published data with a new version.
          </p>
          {confirmUnpublish ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-red-800">
                Unpublish Contribution {contribution.id}?
              </span>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (await run(() => api(`${base}/deactivate`, { method: "POST" }))) {
                    setConfirmUnpublish(false);
                    onClose();
                  }
                }}
              >
                {busy ? "Unpublishing…" : "Yes, unpublish"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmUnpublish(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirmUnpublish(true)}>
              Unpublish
            </Button>
          )}
        </section>
      )}
    </Modal>
  );
}
