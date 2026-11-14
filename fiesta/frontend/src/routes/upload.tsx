import { useSearch } from "@tanstack/react-router";
import { useLoginModal } from "../components/login-modal";
import { isSourceMode, SourceModeNotice } from "../components/source-mode-notice";
import { UploadWizard } from "../components/upload-wizard";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";

export function UploadPage() {
  const { data: config } = useNodeConfig();
  const { user } = useAuth();
  const { openLogin } = useLoginModal();
  const { to } = useSearch({ from: "/upload" }) as { to?: number };

  if (isSourceMode(config)) {
    return (
      <div>
        <h1 className="mb-3 text-xl font-semibold text-gray-900">Upload a contribution</h1>
        <SourceModeNotice config={config} />
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-gray-900">Upload a contribution</h1>
      <p className="mb-5 text-sm text-gray-600">
        Upload {config?.key} text files, delimited tables or Excel workbooks to your private
        workspace, as a new contribution or into one you are preparing. They will be parsed,
        validated, and summarized before you publish them.
        {!user && (
          <>
            {" "}
            You will need to{" "}
            <button type="button" onClick={openLogin} className="text-node-ink underline">
              log in
            </button>{" "}
            to upload.
          </>
        )}
      </p>
      <UploadWizard initialTarget={to} />
    </div>
  );
}
