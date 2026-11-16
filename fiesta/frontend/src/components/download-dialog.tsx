import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, download } from "../lib/api";
import { nodeUrl } from "../lib/base";
import { formatNumber } from "../lib/utils";
import { ErrorMessage } from "./error-message";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { Spinner } from "./ui/spinner";

/** The API's default cap on one multi-contribution download
 * (`download_max_contributions`); a larger server cap still serves this many. */
export const MAX_DOWNLOAD_CONTRIBUTIONS = 100;

/** GET /contributions/{id}/download/info. */
interface DownloadInfo {
  filename: string;
  size: number;
  /** sha256 of the file the download serves (inside a .gz or .zip too). */
  sha256: string;
  /** The stored canonical file, served unchanged with `original=true`. */
  stored: { size: number | null; sha256: string | null };
}

type Choice = "txt" | "gzip" | "zip" | "results";

interface DownloadDialogProps {
  open: boolean;
  onClose: () => void;
  /** One contribution's file, in a plain, gzip or zip download. */
  contributionId?: string | number;
  privateKey?: string;
  /** Several contributions (a search's matches) as one zip: how many, and
   * how to fetch their ids (at most MAX_DOWNLOAD_CONTRIBUTIONS). Offered only
   * for more than one. */
  results?: { count: number; fetchIds: (max: number) => Promise<string[]> };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The download dialog (MagIC #509): one contribution's file as text,
 * gzip or zip, with the served file's SHA-256, or a search's matching
 * contributions as one zip. Options that cannot work are not shown. */
export function DownloadDialog({
  open,
  onClose,
  contributionId,
  privateKey,
  results,
}: DownloadDialogProps) {
  const single = contributionId !== undefined && contributionId !== "";
  const several = !!results && results.count > 1;
  const [choice, setChoice] = useState<Choice>(single ? "txt" : "results");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const keyParams: Record<string, string> = privateKey ? { private_key: privateKey } : {};
  const info = useQuery({
    queryKey: ["download-info", contributionId, privateKey],
    queryFn: () =>
      api<DownloadInfo>(`/contributions/${contributionId}/download/info`, { params: keyParams }),
    enabled: open && single,
    staleTime: 5 * 60_000,
  });

  const name = info.data?.filename ?? `contribution_${contributionId}.txt`;
  const capped = several && results.count > MAX_DOWNLOAD_CONTRIBUTIONS;
  const resultCount = several ? Math.min(results.count, MAX_DOWNLOAD_CONTRIBUTIONS) : 0;

  const options: { value: Choice; label: string; detail: string }[] = [];
  if (single) {
    options.push(
      {
        value: "txt",
        label: name,
        detail: info.data ? `Text, ${formatBytes(info.data.size)}` : "Text",
      },
      { value: "gzip", label: `${name}.gz`, detail: "Compressed (gzip)" },
      {
        value: "zip",
        label: `${stem(name)}.zip`,
        detail: "Compressed (zip), with a SHA256SUMS checksum file",
      },
    );
  }
  if (several) {
    options.push({
      value: "results",
      label: capped
        ? `The first ${formatNumber(resultCount)} of ${formatNumber(results.count)} matching contributions`
        : `All ${formatNumber(resultCount)} matching contributions`,
      detail: "One zip: a folder per contribution and a SHA256SUMS checksum file",
    });
  }
  const selected = options.some((o) => o.value === choice) ? choice : options[0]?.value;

  const start = async () => {
    setError(null);
    if (selected === "results" && results) {
      setBusy(true);
      try {
        const ids = await results.fetchIds(MAX_DOWNLOAD_CONTRIBUTIONS);
        if (ids.length === 0) throw new Error("No contributions to download.");
        // Fetched with the session's token: the signed-in user's own
        // unpublished matches download too.
        await download(`/contributions/download?ids=${ids.join(",")}`, "contributions.zip");
        onClose();
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
      return;
    }
    const params = new URLSearchParams(keyParams);
    if (selected === "gzip" || selected === "zip") params.set("compress", selected);
    const query = params.toString();
    const anchor = document.createElement("a");
    anchor.href = nodeUrl(`/contributions/${contributionId}/download${query ? `?${query}` : ""}`);
    anchor.download = "";
    anchor.click();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Download"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={start} disabled={busy || !selected}>
            {busy && <Spinner size="xs" />}
            {busy ? "Preparing…" : "Download"}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 border-0 p-0">
        <legend className="sr-only">What to download</legend>
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-panel-soft"
          >
            <input
              type="radio"
              name="download-choice"
              className="mt-0.5 accent-[var(--node-color)]"
              checked={selected === option.value}
              onChange={() => setChoice(option.value)}
            />
            <span>
              <span className="block break-all font-medium text-ink-strong">{option.label}</span>
              <span className="block text-gray-600">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {single && (
        <div className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-600">
          {info.isPending && <Spinner size="xs" />}
          {info.data && (
            <>
              <div>
                SHA-256 of {info.data.filename}:{" "}
                <code className="break-all text-ink-strong">{info.data.sha256}</code>
              </div>
              <p className="mb-0 mt-1.5">
                The download writes the contribution's ID and details into its contribution table
                and drops a leading byte-order mark and stray separator lines. The archived file
                {info.data.stored.sha256 && (
                  <>
                    {" "}
                    (SHA-256 <code className="break-all">{info.data.stored.sha256}</code>)
                  </>
                )}{" "}
                is also available{" "}
                <a
                  className="text-node-ink underline"
                  href={nodeUrl(
                    `/contributions/${contributionId}/download?${new URLSearchParams({
                      ...keyParams,
                      original: "true",
                    })}`,
                  )}
                  download
                >
                  unchanged
                </a>
                .
              </p>
            </>
          )}
        </div>
      )}
      {error !== null && (
        <div className="mt-3">
          <ErrorMessage error={error} />
        </div>
      )}
    </Modal>
  );
}
