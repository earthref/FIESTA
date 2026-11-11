#!/bin/bash
# Pre-job hook for the self-hosted deploy runners (marfik-deploy on MARFIK,
# fiesta-deploy on fiesta-ct). Not run from this repo: an operator copies it to
# the runner host and points the runner at it (docs/OPERATOR_TODO.md):
#
#   echo ACTIONS_RUNNER_HOOK_JOB_STARTED=/etc/github-runner/job-guard.sh >> <runner dir>/.env
#
# The repos are public, so anyone can open a PR that ADDS a workflow with
# `on: pull_request` and `runs-on: [self-hosted, marfik-deploy]`; GitHub runs
# the PR's own workflow files, and only first-time contributors need approval.
# Leaving pull_request out of our deploy.yml does not stop that. This hook
# does: the runner refuses every job whose workflow file is not on the
# allowlist at a protected ref. A non-zero exit fails the job before any step
# runs ("Set up runner" shows the reason).
#
# Allowlist: one GITHUB_WORKFLOW_REF per line, exactly as GitHub reports it,
# e.g. earthref/MagIC/.github/workflows/deploy.yml@refs/heads/main
# A fork PR's workflow ref is ...@refs/pull/<n>/merge, so it can never match.
# Blank lines and #-comments are ignored. No file = nothing runs.
set -uo pipefail
ALLOWLIST=${RUNNER_JOB_GUARD_ALLOWLIST:-/etc/github-runner/allowed-workflows}

deny() {
  echo "runner-job-guard: refusing job: $*" >&2
  echo "runner-job-guard: repo=${GITHUB_REPOSITORY:-?} event=${GITHUB_EVENT_NAME:-?} ref=${GITHUB_REF:-?} workflow=${GITHUB_WORKFLOW_REF:-?} actor=${GITHUB_ACTOR:-?}" >&2
  exit 1
}

# Only events that a write-access account causes. pull_request and
# pull_request_target are the fork-PR events; anything else is not ours.
case "${GITHUB_EVENT_NAME:-}" in
  push | workflow_dispatch | workflow_run) ;;
  *) deny "event '${GITHUB_EVENT_NAME:-}' is not push, workflow_dispatch or workflow_run" ;;
esac

[[ -r "$ALLOWLIST" ]] || deny "allowlist $ALLOWLIST is missing or unreadable"
[[ -n "${GITHUB_WORKFLOW_REF:-}" ]] || deny "GITHUB_WORKFLOW_REF is not set"

while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%%#*}
  line=${line//[[:space:]]/}
  [[ -n "$line" && "$line" == "$GITHUB_WORKFLOW_REF" ]] && exit 0
done < "$ALLOWLIST"

deny "workflow ref is not in $ALLOWLIST"
