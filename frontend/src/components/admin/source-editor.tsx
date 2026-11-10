// A node's data source (docs/data-sources.md): whether this deployment mirrors
// it, its sync script, the schedule (node YAML `legacy.sync`, saved to the draft
// like any other setting), the ops scheduler's last run, and the sync reports.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { adminKeys, formatDate, type NodeSettings, patchSettings } from "../../lib/admin";
import { api } from "../../lib/api";
import { ErrorMessage } from "../error-message";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../ui/table";
import { Field } from "./admin-ui";

interface SyncRun {
  started_at: string;
  finished_at: string;
  reported_at: string;
  ok: boolean;
  trigger?: string | null;
  by?: string;
  summary: {
    applied?: number;
    unchanged?: number;
    quarantined?: number;
    source_records?: number;
    missing_from_source?: number[];
    errors?: { id: number | null; error: string }[];
    failed?: string;
  };
}

interface SourceStatus {
  mode: "public" | "source";
  source_id: string | null;
  kind: string | null;
  script: string | null;
  sync: { enabled: boolean; cron: string } | null;
  synced: number;
  schedule: {
    name: string;
    last_run: {
      status: string;
      trigger: string;
      deferred_at: string | null;
      started_at: string | null;
      duration: number | null;
      last_success_at: string | null;
    } | null;
  } | null;
  runs: SyncRun[];
}

const RUN_STATUS: Record<string, "success" | "warning" | "danger" | "muted"> = {
  succeeded: "success",
  doing: "warning",
  todo: "muted",
  failed: "danger",
};

function seconds(value: number | null | undefined): string {
  if (value == null) return "";
  return value < 90 ? `${Math.round(value)} s` : `${Math.round(value / 60)} min`;
}

function RunsTable({ runs }: { runs: SyncRun[] }) {
  if (!runs.length) {
    return <p className="text-sm text-gray-500">No sync has reported a run yet.</p>;
  }
  return (
    <Table>
      <THead>
        <tr>
          <Th>Finished</Th>
          <Th>Result</Th>
          <Th>Applied</Th>
          <Th>Unchanged</Th>
          <Th>Quarantined</Th>
          <Th>Took</Th>
          <Th>Trigger</Th>
        </tr>
      </THead>
      <TBody>
        {runs.map((run) => {
          const s = run.summary ?? {};
          const errors = s.errors ?? [];
          const took =
            (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000;
          return (
            <Tr key={run.reported_at}>
              <Td>{formatDate(run.finished_at)}</Td>
              <Td>
                <Badge variant={run.ok ? "success" : "danger"}>
                  {run.ok ? "ok" : s.failed ? "failed" : `${errors.length} errors`}
                </Badge>
                {(s.failed || errors.length > 0) && (
                  <details className="mt-1 max-w-md text-xs text-gray-600">
                    <summary className="cursor-pointer">details</summary>
                    {s.failed && <p>{s.failed}</p>}
                    <ul className="list-disc pl-4">
                      {errors.slice(0, 50).map((e) => (
                        <li key={`${e.id}-${e.error}`}>
                          {e.id != null && <strong>{e.id}: </strong>}
                          {e.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </Td>
              <Td>{s.applied ?? ""}</Td>
              <Td>{s.unchanged ?? ""}</Td>
              <Td>{s.quarantined ?? ""}</Td>
              <Td>{seconds(took)}</Td>
              <Td className="text-gray-500">{run.trigger ?? ""}</Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

export function SourceEditor({
  slug,
  settings,
  settingsLock,
}: {
  slug: string;
  settings: NodeSettings;
  settingsLock: number | null;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: [...adminKeys.node(slug), "source"],
    queryFn: () => api<SourceStatus>(`/v2/${slug}/source`),
    refetchInterval: 30_000,
  });
  const saved = settings.legacy?.sync;
  const initial = { enabled: saved?.enabled ?? false, cron: saved?.cron ?? "20 * * * *" };
  const [form, setForm] = useState(initial);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the saved values change
  useEffect(() => setForm(initial), [initial.enabled, initial.cron]);
  const changed = form.enabled !== initial.enabled || form.cron.trim() !== initial.cron;
  const save = useMutation({
    mutationFn: () =>
      patchSettings(
        slug,
        [
          { path: ["legacy", "sync", "enabled"], value: form.enabled },
          { path: ["legacy", "sync", "cron"], value: form.cron.trim() },
        ],
        settingsLock,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) }),
  });
  const runNow = useMutation({
    mutationFn: () => api<{ job_id: number }>(`/v2/${slug}/source/run`, { method: "POST" }),
    onSuccess: () => status.refetch(),
  });

  if (status.error) return <ErrorMessage error={status.error} />;
  if (!status.data) return <Spinner />;
  const s = status.data;
  if (!s.source_id) {
    return (
      <p className="max-w-3xl text-sm text-gray-600">
        {settings.node.key} has no data source: its node YAML has no <code>legacy:</code> block, so
        it only takes contributions through FIESTA.
      </p>
    );
  }
  const last = s.schedule?.last_run;
  const scheduled = !!s.sync?.enabled;
  return (
    <div className="max-w-4xl space-y-5">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-semibold text-gray-700">Mode here</dt>
        <dd>
          {s.mode === "source" ? (
            <Badge variant="node">data source</Badge>
          ) : (
            <Badge variant="muted">public contributions</Badge>
          )}{" "}
          <span className="text-gray-500">
            {s.mode === "source"
              ? "contributions are synced from the source; uploads are refused"
              : "people contribute here; the sync is off (FIESTA_CONTRIBUTIONS_MODE)"}
          </span>
        </dd>
        <dt className="font-semibold text-gray-700">Source</dt>
        <dd>
          {s.kind} <code className="text-gray-500">{s.source_id}</code> · {s.synced} records synced
        </dd>
        <dt className="font-semibold text-gray-700">Sync script</dt>
        <dd>
          {s.script ? (
            <code>{s.script}</code>
          ) : (
            <Badge variant="warning">none in this checkout</Badge>
          )}
        </dd>
        <dt className="font-semibold text-gray-700">Scheduler</dt>
        <dd>
          {last ? (
            <>
              <Badge variant={RUN_STATUS[last.status] ?? "default"}>
                {last.status === "todo" ? "waiting for the ops worker" : last.status}
              </Badge>{" "}
              <span className="text-gray-600">
                {last.started_at
                  ? `started ${formatDate(last.started_at)}`
                  : `queued ${formatDate(last.deferred_at)}`}
                {last.duration != null && `, ${seconds(last.duration)}`} ({last.trigger})
                {last.last_success_at && ` · last success ${formatDate(last.last_success_at)}`}
              </span>
            </>
          ) : (
            <span className="text-gray-500">
              {s.schedule?.name} has not run on the ops worker yet
            </span>
          )}
        </dd>
      </dl>

      <form
        className="rounded-md border border-gray-200 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <p className="mb-3 text-xs font-semibold text-gray-700">
          Schedule (live: {scheduled ? `on, ${s.sync?.cron} UTC` : "off"})
        </p>
        <div className="grid items-end gap-3 sm:grid-cols-[auto_16rem_auto]">
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={!s.script}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="h-4 w-4 rounded-sm border-gray-300"
            />
            Sync on a schedule
          </label>
          <Field label="Cron (UTC)" hint="20 * * * * = hourly at :20">
            <Input
              value={form.cron}
              disabled={!s.script}
              onChange={(e) => setForm({ ...form, cron: e.target.value })}
            />
          </Field>
          <div className="flex gap-2 pb-0.5">
            <Button type="submit" disabled={!changed || save.isPending}>
              Save to Draft
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!s.script || s.mode !== "source" || runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              Run now
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          The schedule is part of the node configuration: publish the draft to apply it. The ops
          worker picks it up without a restart and runs the script; Run now queues one run there.
        </p>
        {save.error && <ErrorMessage error={save.error} />}
        {runNow.error && <ErrorMessage error={runNow.error} />}
        {runNow.data && (
          <p className="mt-2 text-sm text-green-700">
            Queued as job {runNow.data.job_id} on the ops worker.
          </p>
        )}
      </form>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-800">Latest syncs</h2>
        <RunsTable runs={s.runs} />
      </div>
    </div>
  );
}
