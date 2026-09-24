// Pieces shared by the admin settings pages (routes/admin.tsx, admin-node.tsx).

import type { ReactNode } from "react";
import { type AdminNode, isAnyAdmin, type NodeRevision } from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { cx } from "../../lib/utils";
import { useLoginModal } from "../login-modal";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PageSpinner } from "../ui/spinner";

/** Login / permission gate for the admin pages. */
export function AdminGate({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const { openLogin } = useLoginModal();
  if (isLoading) return <PageSpinner label="Checking your session…" />;
  if (!user) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <h1 className="mb-2 text-xl font-semibold text-gray-900">Admin Settings</h1>
        <p className="mb-5 text-sm text-gray-600">Log in with an admin account.</p>
        <Button onClick={openLogin}>Log In</Button>
      </div>
    );
  }
  if (!isAnyAdmin(user)) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <h1 className="mb-2 text-xl font-semibold text-gray-900">Admin Settings</h1>
        <p className="text-sm text-gray-600">
          Your account is not an admin of any FIESTA node. A super admin can grant access.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-gray-200">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          onClick={() => onChange(tab.key)}
          className={cx(
            "-mb-px border-b-2 px-3 py-2 text-sm",
            tab.key === active
              ? "border-node font-semibold text-node"
              : "border-transparent text-gray-600 hover:text-gray-900",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-gray-700">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export function NodeChip({ node }: { node: Pick<AdminNode, "key" | "color"> }) {
  return (
    <span className="font-bold" style={{ color: node.color ?? "#666666" }}>
      {node.key}
    </span>
  );
}

const REPO_LABELS: Record<string, string> = {
  written: "in git",
  failed: "git write failed",
  pending: "git write pending",
  skipped: "not written to git",
};

/** Where a published revision stands in the repository (PR link when there is one). */
export function RepoStatus({ revision }: { revision: NodeRevision }) {
  const status = revision.repo_status;
  if (!status) return null;
  const variant =
    status === "written"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "pending"
          ? "warning"
          : "muted";
  const ref = revision.repo_ref;
  const label = REPO_LABELS[status] ?? status;
  return (
    <Badge variant={variant} title={revision.repo_error ?? ref ?? undefined}>
      {ref?.startsWith("https://") ? (
        <a href={ref} target="_blank" rel="noreferrer" className="underline">
          {status === "written" ? "pull request" : label}
        </a>
      ) : (
        label
      )}
    </Badge>
  );
}
