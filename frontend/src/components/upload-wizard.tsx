import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";
import type { ContributionOut, ValidationResult } from "../lib/types";
import { cx, formatBytes } from "../lib/utils";
import { ErrorMessage } from "./error-message";
import { useLoginModal } from "./login-modal";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

type Step = 1 | 2 | 3;
type Phase = "idle" | "creating" | "uploading" | "processing" | "done" | "error";

const SEGMENT_BORDER = "rgba(34,36,38,.15)";

const stepDefs: { step: Step; icon: string; title: string; description: string }[] = [
  { step: 1, icon: "📂", title: "Select", description: "Choose a file from your computer" },
  { step: 2, icon: "📄", title: "Review", description: "Check the file before uploading" },
  { step: 3, icon: "⬆", title: "Upload", description: "Add it to your private workspace" },
];

/** Legacy "ui top attached stackable three steps" bar (min-height 8em per step). */
function StepsBar({ current }: { current: Step }) {
  return (
    <ol
      className="flex flex-col rounded-t-sm bg-white sm:flex-row"
      style={{
        width: "calc(100% + 2px)",
        marginLeft: -1,
        border: `1px solid ${SEGMENT_BORDER}`,
        margin: "0 0 0 -1px",
        padding: 0,
      }}
    >
      {stepDefs.map((def, index) => {
        const active = def.step === current;
        const disabled = def.step > current;
        return (
          <li
            key={def.step}
            aria-current={active ? "step" : undefined}
            className="relative flex flex-1 items-center justify-center gap-3 px-4 py-3"
            style={{
              minHeight: "8em",
              borderLeft: index > 0 ? `1px solid ${SEGMENT_BORDER}` : "none",
              color: disabled ? "rgba(40,40,40,.3)" : "rgba(0,0,0,.87)",
              background: active ? "#fff" : "transparent",
            }}
          >
            <span aria-hidden="true" className="text-[2.5em] leading-none">
              {def.icon}
            </span>
            <span className="text-left">
              <span className="block text-[1.1em] font-bold">
                Step {def.step}. {def.title}
              </span>
              <span className="block text-[13px]">{def.description}</span>
            </span>
            {/* Active pointing-below arrow (site.overrides .ui.steps .active.step.pointing.below) */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute left-1/2 hidden bg-white sm:block"
                style={{
                  top: "calc(100% + 1px)",
                  width: "1.14em",
                  height: "1.14em",
                  transform: "translate(-50%, -50%) rotate(45deg)",
                  borderRight: `1px solid ${SEGMENT_BORDER}`,
                  borderBottom: `1px solid ${SEGMENT_BORDER}`,
                  zIndex: 2,
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function UploadWizard() {
  const { data: config } = useNodeConfig();
  const { user } = useAuth();
  const { openLogin } = useLoginModal();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);
  const [contributionId, setContributionId] = useState<number | null>(null);

  const contributionQuery = useQuery({
    queryKey: ["private", "contribution", contributionId],
    queryFn: () => api<ContributionOut>(`/api/private/contributions/${contributionId}`),
    enabled: contributionId !== null && phase === "processing",
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "ready" || status === "failed" ? false : 2000;
    },
  });

  const status = contributionQuery.data?.status;
  useEffect(() => {
    if (phase === "processing" && (status === "ready" || status === "failed")) {
      setPhase("done");
      queryClient.invalidateQueries({ queryKey: ["private", "contributions"] });
    }
  }, [phase, status, queryClient]);

  const validationQuery = useQuery({
    queryKey: ["private", "validation", contributionId],
    queryFn: async () => {
      try {
        return await api<ValidationResult>(
          `/api/private/contributions/${contributionId}/validation`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: contributionId !== null && phase === "done",
  });

  const pickFile = (picked: File | undefined | null) => {
    if (!picked) return;
    setFile(picked);
    setStep(2);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    pickFile(event.dataTransfer.files?.[0]);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    pickFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const startUpload = async () => {
    if (!file) return;
    setStep(3);
    setError(null);
    try {
      setPhase("creating");
      const contribution = await api<ContributionOut>("/api/private/contributions", {
        method: "POST",
      });
      setContributionId(contribution.id);
      setPhase("uploading");
      const formData = new FormData();
      formData.append("file", file);
      await api<ContributionOut>(`/api/private/contributions/${contribution.id}/file`, {
        method: "PUT",
        formData,
      });
      setPhase("processing");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  };

  const reset = () => {
    setStep(1);
    setFile(null);
    setPhase("idle");
    setError(null);
    setContributionId(null);
  };

  const busy = phase === "creating" || phase === "uploading" || phase === "processing";

  return (
    <div className="upload-contribution">
      <StepsBar current={step} />
      {/* ui attached message container (bg white) */}
      <div
        className="rounded-b-sm bg-white"
        style={{
          width: "calc(100% + 2px)",
          margin: "0 0 0 -1px",
          border: `1px solid ${SEGMENT_BORDER}`,
          borderTop: "none",
          padding: "1em",
        }}
      >
        {step === 1 && (
          <>
            <button
              type="button"
              aria-label="Choose a file to upload"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cx(
                "upload-dropzone grid w-full cursor-pointer items-center px-6 py-10 text-center",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                dragging && "bg-node-soft",
              )}
              style={{ gridTemplateColumns: "1fr auto 1fr" }}
            >
              <span className="flex flex-col items-center gap-2">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-[4em] w-[4em] text-node"
                >
                  <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v10.5C2 16.216 2.784 17 3.75 17h12.5A1.75 1.75 0 0 0 18 15.25v-4.507a1.75 1.75 0 0 0-.062-.464l-1.1-4.036A1.75 1.75 0 0 0 15.15 5H10.7L9.324 3.513A1.75 1.75 0 0 0 8.086 3H3.75Zm1.6 5h10.06l1.03 3.78.01.22v3.25a.25.25 0 0 1-.25.25H3.75a.25.25 0 0 1-.25-.25V11.9L4.62 8.6A.75.75 0 0 1 5.35 8Z" />
                </svg>
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  Click and select
                </span>
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  files to upload.
                </span>
              </span>
              <span
                aria-hidden="true"
                className="mx-6 flex flex-col items-center gap-1 text-[12px] font-bold text-gray-400"
              >
                <span className="h-10 w-px bg-gray-300" />
                OR
                <span className="h-10 w-px bg-gray-300" />
              </span>
              <span className="flex flex-col items-center gap-2">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-[4em] w-[4em] text-node"
                >
                  <path d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" />
                  <path d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" />
                </svg>
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  Drag and drop files
                </span>
                <span className="block text-[1.07rem] font-bold text-gray-800">
                  here to upload.
                </span>
              </span>
            </button>
            {config && (
              <p className="mt-2 text-center text-xs text-gray-400">
                {config.key} text files, data model version {config.data_model_latest}
              </p>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              onChange={onFileChange}
              aria-hidden="true"
              tabIndex={-1}
            />
          </>
        )}

        {step === 2 && file && (
          <div>
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">File</dt>
                <dd className="mt-0.5 break-all text-gray-900">{file.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Size</dt>
                <dd className="mt-0.5 text-gray-900">{formatBytes(file.size)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">Type</dt>
                <dd className="mt-0.5 text-gray-900">{file.type || "text/plain"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  Data model
                </dt>
                <dd className="mt-0.5 text-gray-900">{config?.data_model_latest}</dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-gray-600">
              Uploading creates a new private contribution in your workspace. The file is parsed and
              validated automatically; nothing is published until you activate it.
            </p>
            {!user && (
              <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                You need to{" "}
                <button type="button" onClick={openLogin} className="font-medium underline">
                  log in
                </button>{" "}
                before uploading.
              </p>
            )}
            <div className="mt-5 flex gap-2">
              <Button variant="secondary" onClick={reset}>
                Back
              </Button>
              <Button onClick={startUpload} disabled={!user}>
                Upload
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            {busy && (
              <div className="flex flex-col items-center gap-3 py-6">
                <Spinner
                  className="h-6 w-6"
                  label={
                    phase === "creating"
                      ? "Creating private contribution…"
                      : phase === "uploading"
                        ? "Uploading file…"
                        : `Processing (${status ?? "queued"})…`
                  }
                />
                {phase === "processing" && (
                  <p className="text-xs text-gray-500">
                    Your file is being parsed, validated, and summarized. This can take a moment.
                  </p>
                )}
              </div>
            )}

            {phase === "error" && (
              <div>
                <ErrorMessage error={error} />
                <div className="mt-4 flex gap-2">
                  <Button variant="secondary" onClick={reset}>
                    Start over
                  </Button>
                  {file && <Button onClick={startUpload}>Retry</Button>}
                </div>
              </div>
            )}

            {phase === "done" && (
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Badge variant={status === "ready" ? "success" : "danger"}>{status}</Badge>
                  <span className="text-sm text-gray-700">
                    Contribution {contributionId}{" "}
                    {status === "ready" ? "was uploaded and processed." : "failed to process."}
                  </span>
                </div>
                {validationQuery.data && (
                  <p className="mb-3 text-sm text-gray-600">
                    Validation:{" "}
                    {validationQuery.data.is_valid ? (
                      <span className="font-medium text-green-700">passed</span>
                    ) : (
                      <span className="font-medium text-red-700">failed</span>
                    )}{" "}
                    — {validationQuery.data.errors.length} error(s),{" "}
                    {validationQuery.data.warnings.length} warning(s). Full results are available in
                    your private workspace.
                  </p>
                )}
                <div className="flex gap-2">
                  <Link to="/private">
                    <Button>Open private workspace</Button>
                  </Link>
                  <Button variant="secondary" onClick={reset}>
                    Upload another file
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
