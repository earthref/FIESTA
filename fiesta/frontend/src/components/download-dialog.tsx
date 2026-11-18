import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { nodeUrl } from "../lib/base";
import { ErrorMessage } from "./error-message";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { Spinner } from "./ui/spinner";

/** GET /contributions/{id}/download/info. */
interface DownloadInfo {
  filename: string;
  size: number;
  /** sha256 of the file the download serves (inside a .gz or .zip too). */
  sha256: string;
  /** The stored canonical file, served unchanged with `original=true`. */
  stored: { size: number | null; sha256: string | null };
}

type Choice = "txt" | "gzip" | "zip";

interface DownloadDialogProps {
  open: boolean;
  onClose: () => void;
  /** The contribution whose file downloads, plain, gzipped or zipped. */
  contributionId: string | number;
  privateKey?: string;
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

/** The contribution modal's download dialog (MagIC #509): its file as text,
 * gzip or zip, with the served file's SHA-256 and a link to the stored file
 * unchanged. The search page's Download Results is DownloadResultsModal. */
export function DownloadDialog({ open, onClose, contributionId, privateKey }: DownloadDialogProps) {
  const [choice, setChoice] = useState<Choice>("txt");

  const keyParams: Record<string, string> = privateKey ? { private_key: privateKey } : {};
  const info = useQuery({
    queryKey: ["download-info", contributionId, privateKey],
    queryFn: () =>
      api<DownloadInfo>(`/contributions/${contributionId}/download/info`, { params: keyParams }),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const name = info.data?.filename ?? `contribution_${contributionId}.txt`;
  const options: { value: Choice; label: string; detail: string }[] = [
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
  ];

  const start = () => {
    const params = new URLSearchParams(keyParams);
    if (choice === "gzip" || choice === "zip") params.set("compress", choice);
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
          <Button onClick={start}>Download</Button>
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
              checked={choice === option.value}
              onChange={() => setChoice(option.value)}
            />
            <span>
              <span className="block break-all font-medium text-ink-strong">{option.label}</span>
              <span className="block text-gray-600">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-600">
        {info.isPending && <Spinner size="xs" />}
        {info.data && (
          <>
            <div>
              SHA-256 of {info.data.filename}:{" "}
              <code className="break-all text-ink-strong">{info.data.sha256}</code>
            </div>
            <p className="mb-0 mt-1.5">
              The download writes the contribution's ID and details into its contribution table and
              drops a leading byte-order mark and stray separator lines. The archived file
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
        {info.isError && <ErrorMessage error={info.error} />}
      </div>
    </Modal>
  );
}
