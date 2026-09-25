import { useLoginModal } from "../components/login-modal";
import { UploadWizard } from "../components/upload-wizard";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";

export function UploadPage() {
  const { data: config } = useNodeConfig();
  const { user } = useAuth();
  const { openLogin } = useLoginModal();

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-gray-900">Upload a contribution</h1>
      <p className="mb-5 text-sm text-gray-600">
        Upload a {config?.key} text file to your private workspace. It will be parsed, validated,
        and summarized before you publish it.
        {!user && (
          <>
            {" "}
            You will need to{" "}
            <button type="button" onClick={openLogin} className="text-node underline">
              log in
            </button>{" "}
            to upload.
          </>
        )}
      </p>
      <UploadWizard />
    </div>
  );
}
