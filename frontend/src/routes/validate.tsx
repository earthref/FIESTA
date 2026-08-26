import { Link } from "@tanstack/react-router";
import { UploadWizard } from "../components/upload-wizard";
import { useNodeConfig } from "../lib/config";

export function ValidatePage() {
  const { data: config } = useNodeConfig();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold text-gray-900">Validate a file</h1>
      <p className="mb-5 text-sm text-gray-600">
        Validation runs inside your{" "}
        <Link to="/private" className="text-node underline">
          private workspace
        </Link>
        : the file below is uploaded as a private contribution (never published), parsed against the{" "}
        {config?.key} data model, and a full error and warning report is produced. You can delete
        the contribution afterwards, or fix the file and re-upload.
      </p>
      <UploadWizard />
    </div>
  );
}
