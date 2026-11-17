/**
 * The Upgrade page (legacy MagIC upgrade_contribution.jsx): a contribution
 * file in an older data-model version, upgraded to the latest and offered as
 * a download with its report. The upload page upgrades the same way as it
 * reads files; this page only converts.
 */
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, useState } from "react";
import { ErrorMessage } from "../components/error-message";
import { useLoginModal } from "../components/login-modal";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { UpgradeReportPanel } from "../components/upgrade-report";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";
import { decodeText } from "../lib/importer";
import { type UpgradeOptions, type UpgradeResult, upgradeText } from "../lib/upgrade";

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function UpgradePage() {
  const { data: config } = useNodeConfig();
  const { user, isLoading: authLoading } = useAuth();
  const { openLogin } = useLoginModal();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [options, setOptions] = useState<UpgradeOptions>({ unknown_columns: "keep", defaults: {} });
  const [result, setResult] = useState<UpgradeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = config?.key ?? "";
  const latest = config?.data_model_latest ?? "";
  const older = (config?.data_model_versions ?? []).filter((v) => v !== latest);

  const run = async (text: string, next: UpgradeOptions) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await upgradeText(text, next));
    } catch (err) {
      setResult(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = "";
    if (!picked) return;
    const text = decodeText(await picked.arrayBuffer());
    setFile({ name: picked.name, text });
    await run(text, options);
  };

  const change = (next: UpgradeOptions) => {
    setOptions(next);
    if (file) run(file.text, next);
  };

  const base = file?.name.replace(/\.[^.]*$/, "") ?? "contribution";

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-gray-900">Upgrade a contribution</h1>
      <p className="mb-4 text-sm text-gray-600">
        Upgrade a {key} text file written in an older data model version
        {older.length > 0 && ` (${older.join(", ")})`} to version {latest}: tables and columns are
        renamed, split and merged as the data models record, and the report lists everything that
        changed or was dropped. Nothing is uploaded or kept. To put the file in your private
        workspace, import it on the{" "}
        <Link to="/Upload" className="text-node-ink underline">
          upload page
        </Link>
        , which upgrades it the same way.
      </p>
      {/* Upgrading runs on the server for contributors: it needs a login. */}
      {!user && !authLoading && (
        <div className="rounded-md border border-gray-200 bg-surface px-4 py-6 text-center">
          <p className="mb-3 text-sm text-gray-700">Log in to upgrade a contribution file.</p>
          <Button onClick={openLogin}>Log In / Register</Button>
        </div>
      )}
      {user && (
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <label className="cursor-pointer rounded-md border border-gray-300 bg-surface px-3 py-2 font-semibold hover:bg-gray-50">
            Select a file…
            <input type="file" className="sr-only" accept=".txt,.tsv,text/plain" onChange={pick} />
          </label>
          {file && <span className="break-all font-bold text-gray-900">{file.name}</span>}
          <label className="flex items-center gap-2">
            <span className="font-semibold text-gray-700">Undefined columns</span>
            <select
              className="rounded-md border border-gray-300 bg-surface px-2 py-1.5"
              value={options.unknown_columns}
              onChange={(event) =>
                change({ ...options, unknown_columns: event.target.value as "keep" | "drop" })
              }
            >
              <option value="keep">Keep under their own names</option>
              <option value="drop">Drop</option>
            </select>
          </label>
          {busy && <Spinner className="h-5 w-5" label="Upgrading…" />}
        </div>
      )}
      {error !== null && <ErrorMessage error={error} />}
      {result && !result.upgraded && (
        <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-[13px] text-gray-700">
          {result.from_version
            ? `This file is already written in ${key} data model version ${result.from_version}; there is nothing to upgrade.`
            : `This file does not look like a ${key} contribution in any data model version.`}
        </p>
      )}
      {result?.upgraded && result.text && (
        <>
          <UpgradeReportPanel
            result={result}
            modelName={`${key} Data Model`}
            busy={busy}
            onDefault={(name, on) =>
              change({ ...options, defaults: { ...options.defaults, [name]: on } })
            }
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={() => download(result.text ?? "", `${base} (v${result.to_version}).txt`)}
            >
              Download the upgraded file
            </Button>
            <Button
              variant="secondary"
              onClick={() => download(result.report_text ?? "", `${base}-upgrade-report.txt`)}
            >
              Download the report
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
