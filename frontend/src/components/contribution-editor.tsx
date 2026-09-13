import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import type { ContributionOut } from "../lib/types";
import { ErrorMessage } from "./error-message";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

type Content = { revision_id: string; text: string };
type Revision = {
  id: string;
  parent_id: string | null;
  created_at: string;
  operation: string;
  files: string[];
};
type Attachment = { name: string; size: number };

export function ContributionEditor({
  contribution,
  onClose,
}: {
  contribution: ContributionOut;
  onClose: () => void;
}) {
  const base = `/api/private/contributions/${contribution.id}`;
  const cache = useQueryClient();
  const [draft, setDraft] = useState<Content | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState(crypto.randomUUID());
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
  const value = draft ?? content.data;
  const immutable = !!contribution.published_revision;
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: [base] });
    await cache.invalidateQueries({ queryKey: ["private", "contributions"] });
    setDraft(null);
    setRequestKey(crypto.randomUUID());
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Contribution ${contribution.id}: edit history`}>
      {immutable && <p>Published content is read-only. Create a new version to make changes.</p>}
      {(error || content.error) && <ErrorMessage error={error || content.error} />}
      <label className="block text-sm font-medium" htmlFor="contribution-text">
        Contribution text
      </label>
      <textarea
        id="contribution-text"
        className="my-2 min-h-64 w-full border p-2 font-mono text-xs"
        value={value?.text ?? ""}
        disabled={immutable || busy || !value}
        onChange={(e) => {
          if (value) {
            setDraft({ ...value, text: e.target.value });
            setRequestKey(crypto.randomUUID());
          }
        }}
      />
      <Button
        disabled={immutable || busy || !draft}
        onClick={() =>
          run(() =>
            api(`${base}/content`, {
              method: "PUT",
              json: {
                text: value?.text,
                expected_revision: value?.revision_id,
                request_key: requestKey,
              },
            }),
          )
        }
      >
        Save revision
      </Button>
      <h3 className="mt-4 font-semibold">Attachments</h3>
      <input
        type="file"
        aria-label="Add attachment"
        disabled={immutable || busy || !value || !!draft}
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
              disabled={immutable || busy || !!draft}
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
              disabled={immutable || busy || !!draft || revision.id === value?.revision_id}
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
    </Modal>
  );
}
