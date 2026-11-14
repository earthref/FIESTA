import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ErrorMessage } from "../components/error-message";
import { useLoginModal } from "../components/login-modal";
import { isSourceMode, SourceModeNotice } from "../components/source-mode-notice";
import { Button } from "../components/ui/button";
import { CountLabel } from "../components/ui/count-label";
import { Icon } from "../components/ui/icon";
import { PageSpinner } from "../components/ui/spinner";
import { ContributionCard, isProcessing } from "../components/workspace-card";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";
import type { ContributionOut } from "../lib/types";
import { cx } from "../lib/utils";

const uploadClass =
  "inline-flex items-center gap-1 rounded-sm bg-node px-3.5 py-2 text-[13px] font-medium text-white hover:bg-node-dark focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node focus-visible:ring-offset-2";

export function PrivateWorkspacePage() {
  const { user, isLoading: authLoading } = useAuth();
  const { openLogin } = useLoginModal();
  const { data: config } = useNodeConfig();
  // One list at a time: in preparation (the default) or published.
  const [showing, setShowing] = useState<"preparation" | "published">("preparation");
  // A card to scroll to once its list renders (Create new version, a version link).
  const [scrollTo, setScrollTo] = useState<number | null>(null);

  const sourceMode = isSourceMode(config);
  const queryClient = useQueryClient();
  // An empty private contribution, to fill in under Edit · History · Files.
  const create = useMutation({
    mutationFn: () => api<ContributionOut>("/private/contributions", { method: "POST" }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["private", "contributions"] });
      setShowing("preparation");
      setScrollTo(created.id);
    },
  });

  const list = useQuery({
    queryKey: ["private", "contributions"],
    queryFn: () => api<ContributionOut[]>("/private/contributions"),
    enabled: !!user && !!config && !sourceMode,
    // While any contribution is being processed, follow it to ready / failed.
    refetchInterval: (query) => (query.state.data?.some(isProcessing) ? 3000 : false),
  });
  const contributions = list.data ?? [];

  useEffect(() => {
    if (scrollTo === null) return;
    const card = document.getElementById(`contribution-${scrollTo}`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    setScrollTo(null);
  });

  // Every write is refused while the node mirrors its source, so drafts made
  // here before (or for after) the cutover stay out of sight until then.
  if (sourceMode) {
    return (
      <div>
        <h1 className="mb-3 text-xl font-semibold text-gray-900">Private Workspace</h1>
        <SourceModeNotice config={config} />
      </div>
    );
  }

  if (authLoading) return <PageSpinner label="Checking your session…" />;

  if (!user) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <h1 className="mb-2 text-xl font-semibold text-gray-900">Private Workspace</h1>
        <p className="mb-5 text-sm text-gray-600">
          Log in to manage, validate, and publish your contributions.
        </p>
        <Button onClick={openLogin}>Log In / Register</Button>
      </div>
    );
  }

  const preparationCount = contributions.filter((entry) => !entry.is_activated).length;
  const publishedCount = contributions.filter((entry) => entry.is_activated).length;
  const showPublished = showing === "published";
  // Published: newest publication first (activated_at; updated_at for rows
  // published before it was recorded). In preparation: most recently changed.
  const publishedAt = (entry: ContributionOut) => entry.activated_at ?? entry.updated_at;
  const visible = contributions
    .filter((entry) => entry.is_activated === showPublished)
    .sort((a, b) =>
      showPublished
        ? publishedAt(b).localeCompare(publishedAt(a))
        : b.updated_at.localeCompare(a.updated_at),
    );
  const successorOf = (entry: ContributionOut) =>
    contributions.find((other) => other.previous_id === entry.id);

  const jump = (target: ContributionOut | number) => {
    const entry =
      typeof target === "number" ? contributions.find((other) => other.id === target) : target;
    if (!entry) return;
    setShowing(entry.is_activated ? "published" : "preparation");
    setScrollTo(entry.id);
  };

  const toggleClass = (active: boolean) =>
    cx(
      "inline-flex items-center rounded-sm text-[13px] font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
      active
        ? "border border-transparent bg-node text-white hover:bg-node-dark"
        : "border border-gray-300 bg-surface text-gray-500 hover:bg-gray-50",
    );

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center" style={{ gap: "0 1em" }}>
        <Link to="/upload" className={uploadClass} style={{ margin: "0 0 0.5em" }}>
          <Icon name="plus" size="small" /> Upload Data Into Your Private Workspace
        </Link>
        <Button
          variant="secondary"
          onClick={() => create.mutate()}
          disabled={create.isPending}
          style={{ margin: "0 0 0.5em" }}
        >
          <Icon name="file-plus" size="small" />
          {create.isPending ? "Creating…" : "New Contribution"}
        </Button>
        <button
          type="button"
          onClick={() => setShowing("preparation")}
          aria-pressed={!showPublished}
          className={toggleClass(!showPublished)}
          style={{ margin: "0 1em 0.5em 0", padding: "0.6em 1.2em" }}
        >
          <Icon name="edit" size="small" />
          &nbsp;In Preparation
          <CountLabel>{preparationCount}</CountLabel>
        </button>
        <button
          type="button"
          onClick={() => setShowing("published")}
          aria-pressed={showPublished}
          className={toggleClass(showPublished)}
          style={{ margin: "0 1em 0.5em 0", padding: "0.6em 1.2em" }}
        >
          <Icon name="check" size="small" />
          &nbsp;Published
          <CountLabel>{publishedCount}</CountLabel>
        </button>
      </div>

      {list.isPending && <PageSpinner label="Loading your contributions…" />}
      {list.error && <ErrorMessage error={list.error} />}
      {create.error && <ErrorMessage error={create.error} />}

      {!list.isPending && !list.error && visible.length === 0 && (
        <div className="rounded-md border border-gray-200 bg-surface px-4 py-10 text-center">
          <p className="text-lg font-medium text-gray-800">
            {showPublished ? "Nothing published yet" : "Nothing in preparation"}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-600">
            {showPublished
              ? "Contributions you publish appear here, where you can share them or start a new version."
              : "Upload a data file to start a contribution. It stays private while you complete its details, validate it and publish it."}
          </p>
          {!showPublished && (
            <Link to="/upload" className={cx(uploadClass, "mt-4")}>
              <Icon name="plus" size="small" /> Upload Data
            </Link>
          )}
        </div>
      )}

      <div>
        {visible.map((contribution) => (
          <ContributionCard
            key={contribution.id}
            contribution={contribution}
            successor={successorOf(contribution)}
            onJump={jump}
          />
        ))}
      </div>
    </div>
  );
}
