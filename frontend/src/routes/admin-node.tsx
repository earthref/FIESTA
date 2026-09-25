// One node's admin page: its settings, data models, vocabularies and files
// (edited into the node's one open draft), its admins, and its revision history.
// Publishing the draft makes it live and writes it to the repository.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { AdminGate, Field, NodeChip, RepoStatus, Tabs } from "../components/admin/admin-ui";
import { DataModelEditor } from "../components/admin/data-model-editor";
import { FiltersEditor } from "../components/admin/filters-editor";
import { PagesEditor } from "../components/admin/pages-editor";
import { VocabularyEditor } from "../components/admin/vocabulary-editor";
import { ErrorMessage } from "../components/error-message";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Modal } from "../components/ui/modal";
import { PageSpinner, Spinner } from "../components/ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../components/ui/table";
import {
  type AdminConfig,
  type AdminNode,
  type AdminUser,
  adminKeys,
  type FileChange,
  type FileList,
  formatDate,
  lockOf,
  type NodeSettings,
  patchSettings,
  putFile,
  readFile,
  type SettingsOp,
  useAdminConfig,
  useAdminNode,
  useNodeSettings,
  type Validation,
} from "../lib/admin";
import { api } from "../lib/api";
import { cx } from "../lib/utils";
import type { AdminNodeParams } from "../router";

type Section =
  | "settings"
  | "pages"
  | "filters"
  | "data-models"
  | "vocabularies"
  | "files"
  | "admins"
  | "history";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "settings", label: "Settings" },
  { key: "pages", label: "Pages" },
  { key: "filters", label: "Search Filters" },
  { key: "data-models", label: "Data Models" },
  { key: "vocabularies", label: "Vocabularies" },
  { key: "files", label: "Files" },
  { key: "admins", label: "Admins" },
  { key: "history", label: "History" },
];

const CHANGE_BADGE: Record<FileChange["change"], "success" | "warning" | "danger"> = {
  added: "success",
  modified: "warning",
  removed: "danger",
};

// --- Draft bar and publication ------------------------------------------------

function DraftBar({ node, config }: { node: AdminNode; config: AdminConfig | undefined }) {
  const queryClient = useQueryClient();
  const [publishing, setPublishing] = useState(false);
  const discard = useMutation({
    mutationFn: () => api(`/v2/admin/nodes/${node.slug}/draft`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.node(node.slug) }),
  });
  if (!node.draft) {
    return (
      <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
        No open draft. Any edit below starts one from the published revision; nothing changes for
        visitors until the draft is published.
      </div>
    );
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
      <span>
        <strong>Draft r{node.draft.number}</strong> started by {node.draft.author ?? "?"}, last
        edited {formatDate(node.draft.updated_at)}.
      </span>
      {node.draft_is_stale && (
        <Badge variant="danger">
          published changed since this draft started — review before publishing
        </Badge>
      )}
      <span className="ml-auto flex gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={discard.isPending}
          onClick={() => window.confirm("Discard every change in this draft?") && discard.mutate()}
        >
          Discard Draft
        </Button>
        <Button size="sm" onClick={() => setPublishing(true)}>
          Review &amp; Publish
        </Button>
      </span>
      {discard.error && <ErrorMessage error={discard.error} className="w-full" />}
      {publishing && (
        <PublishModal node={node} config={config} onClose={() => setPublishing(false)} />
      )}
    </div>
  );
}

function PublishModal({
  node,
  config,
  onClose,
}: {
  node: AdminNode;
  config: AdminConfig | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const validation = useQuery({
    queryKey: [...adminKeys.node(node.slug), "validate"],
    queryFn: () => api<Validation>(`/v2/admin/nodes/${node.slug}/validate`),
    staleTime: 0,
  });
  const publish = useMutation({
    mutationFn: () =>
      api<AdminNode>(`/v2/admin/nodes/${node.slug}/publish`, {
        json: { message, lock_version: node.draft?.lock_version ?? null },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.node(node.slug) });
      queryClient.invalidateQueries({ queryKey: adminKeys.nodes });
      queryClient.invalidateQueries({ queryKey: ["config"] });
      onClose();
    },
  });
  const v = validation.data;
  const destination =
    config?.publish_to === "github"
      ? `a pull request on ${config.repository}`
      : config?.publish_to === "files"
        ? "this checkout's config/ directory"
        : "nowhere (repository writes are off on this deployment)";
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Publish ${node.key} r${node.draft?.number}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!v?.can_publish || !message.trim() || publish.isPending}
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        </>
      }
    >
      {validation.isLoading ? (
        <Spinner label="Validating…" />
      ) : validation.error ? (
        <ErrorMessage error={validation.error} />
      ) : (
        v && (
          <div className="space-y-3 text-sm">
            {v.ok ? (
              <p className="text-green-800">
                The draft loads as a node: every data model, vocabulary and plugin checks out.
              </p>
            ) : (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="mb-1 font-semibold text-red-800">Fix these before publishing:</p>
                <ul className="list-disc pl-5 text-red-800">
                  {v.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            )}
            {v.protected_changes.length > 0 && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-3">
                This draft changes <strong>{v.protected_changes.join(", ")}</strong>, which moves or
                renames the node's data.{" "}
                {v.can_publish || !v.ok
                  ? "Make sure the index, bucket or legacy source is ready."
                  : "Only a super admin can publish it."}
              </p>
            )}
            <div>
              <p className="mb-1 font-semibold">Changes</p>
              {v.changes.length === 0 ? (
                <p className="text-gray-600">None — the draft matches the published revision.</p>
              ) : (
                <ul className="space-y-0.5">
                  {v.changes.map((c) => (
                    <li key={c.path} className="flex items-center gap-2">
                      <Badge variant={CHANGE_BADGE[c.change]}>{c.change}</Badge>
                      <span className="font-mono text-xs">{c.path}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Field
              label="What changed and why"
              hint={`Recorded in the history and the commit message. Publishing makes the draft live immediately and writes it to ${destination}.`}
            >
              <textarea
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2"
              />
            </Field>
            {!node.published && (
              <p className="text-gray-600">
                This is the node's first publication: its database schema, search index and storage
                prefix are created now. Its pages appear on the website once the YAML is merged into
                the repository and deployed.
              </p>
            )}
            {publish.error && <ErrorMessage error={publish.error} />}
          </div>
        )
      )}
    </Modal>
  );
}

// --- Settings -----------------------------------------------------------------

interface SettingsForm {
  title: string;
  subtitle: string;
  color: string;
  contact_email: string;
  website: string;
  github_issues: string;
  doi_prefix: string;
  plugins: string[];
  index: string;
  bucket: string;
}

function formOf(s: NodeSettings): SettingsForm {
  return {
    title: s.node.title ?? "",
    subtitle: s.node.subtitle ?? "",
    color: s.node.color ?? "#666666",
    contact_email: s.node.contact_email ?? "",
    website: s.node.links?.website ?? "",
    github_issues: s.node.links?.github_issues ?? "",
    doi_prefix: s.doi?.prefix ?? "",
    plugins: s.features?.plugins ?? [],
    index: s.search.index,
    bucket: s.storage.bucket,
  };
}

/** The YAML edits that turn `before` into `after` (only changed fields). */
function opsFor(before: SettingsForm, after: SettingsForm): SettingsOp[] {
  const orNull = (value: string) => value.trim() || null;
  const fields: [keyof SettingsForm, (string | number)[], unknown][] = [
    ["title", ["node", "title"], after.title.trim()],
    ["subtitle", ["node", "subtitle"], after.subtitle.trim()],
    ["color", ["node", "color"], after.color],
    ["contact_email", ["node", "contact_email"], orNull(after.contact_email)],
    ["website", ["node", "links", "website"], orNull(after.website)],
    ["github_issues", ["node", "links", "github_issues"], orNull(after.github_issues)],
    ["doi_prefix", ["doi", "prefix"], orNull(after.doi_prefix)],
    ["plugins", ["features", "plugins"], after.plugins],
    ["index", ["search", "index"], after.index.trim()],
    ["bucket", ["storage", "bucket"], after.bucket.trim()],
  ];
  return fields
    .filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(([, path, value]) => ({ path, value }));
}

function Checkboxes({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {options.map((option) => (
        <label key={option} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={value.includes(option)}
            onChange={() =>
              onChange(
                value.includes(option)
                  ? value.filter((entry) => entry !== option)
                  : [...value, option],
              )
            }
          />
          {option}
        </label>
      ))}
    </div>
  );
}

function SettingsSection({ node, superAdmin }: { node: AdminNode; superAdmin: boolean }) {
  const queryClient = useQueryClient();
  const settings = useNodeSettings(node.slug);
  const initial = useMemo(
    () => (settings.data ? formOf(settings.data.settings) : null),
    [settings.data],
  );
  const [form, setForm] = useState<SettingsForm | null>(null);
  useEffect(() => setForm(initial), [initial]);
  const save = useMutation({
    mutationFn: () => {
      if (!initial || !form) throw new Error("nothing loaded");
      return patchSettings(node.slug, opsFor(initial, form), lockOf(settings.data));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.node(node.slug) }),
  });
  if (settings.error) return <ErrorMessage error={settings.error} />;
  if (!form || !initial || !settings.data) return <Spinner />;
  const s = settings.data.settings;
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm({ ...form, [key]: value });
  const input = (key: keyof SettingsForm) => ({
    value: form[key] as string,
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const changed = opsFor(initial, form).length;
  return (
    <form
      className="max-w-3xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Key" hint="Fixed: it is the node's URL and portal label.">
          <Input value={s.node.key} disabled />
        </Field>
        <Field label="Slug" hint="Fixed: it names the schema, queue and storage prefix.">
          <Input value={s.node.slug} disabled />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Title">
            <Input {...input("title")} required />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Subtitle">
            <textarea
              rows={2}
              value={form.subtitle}
              onChange={(e) => set("subtitle", e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Color">
          <div className="flex gap-2">
            <input
              type="color"
              aria-label="Pick color"
              value={/^#[0-9a-f]{6}$/i.test(form.color) ? form.color : "#666666"}
              onChange={(e) => set("color", e.target.value)}
              className="h-9 w-12 rounded-sm border border-gray-300"
            />
            <Input {...input("color")} />
          </div>
        </Field>
        <Field label="Contact email">
          <Input type="email" {...input("contact_email")} />
        </Field>
        <Field label="Website">
          <Input {...input("website")} />
        </Field>
        <Field label="GitHub issues">
          <Input {...input("github_issues")} />
        </Field>
        <Field label="DOI prefix">
          <Input {...input("doi_prefix")} />
        </Field>
      </div>
      <Field label="Plugins">
        <Checkboxes
          options={node.plugins ?? []}
          value={form.plugins}
          onChange={(v) => set("plugins", v)}
        />
      </Field>
      <fieldset className="rounded-md border border-gray-200 p-3">
        <legend className="px-1 text-xs font-semibold text-gray-700">
          Data location {superAdmin ? "" : "(super admins only)"}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Search index" hint="Prefixed by FIESTA_INDEX_PREFIX">
            <Input {...input("index")} disabled={!superAdmin} />
          </Field>
          <Field label="Bucket" hint="Unused when FIESTA_S3_BUCKET is set">
            <Input {...input("bucket")} disabled={!superAdmin} />
          </Field>
        </div>
      </fieldset>
      <p className="text-xs text-gray-500">
        Content pages and the search filter sidebar have their own tabs. Search levels, hierarchy,
        home page cards and news are edited in the node YAML under Files. Edits keep the YAML's
        comments and layout.
      </p>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!changed || save.isPending}>
          Save to Draft
        </Button>
        <Button type="button" variant="ghost" disabled={!changed} onClick={() => setForm(initial)}>
          Reset
        </Button>
        {changed > 0 && <Badge variant="warning">{changed} unsaved</Badge>}
      </div>
      {save.error && <ErrorMessage error={save.error} />}
    </form>
  );
}

// --- Files --------------------------------------------------------------------

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function FilesSection({ node }: { node: AdminNode }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(`${node.slug}.yaml`);
  const list = useQuery({
    queryKey: [...adminKeys.node(node.slug), "files"],
    queryFn: () => api<FileList>(`/v2/admin/nodes/${node.slug}/files`),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: adminKeys.node(node.slug) });
  const upload = useMutation({
    mutationFn: async ({ path, file }: { path: string; file: File }) =>
      putFile(node.slug, path, toBase64(await file.arrayBuffer()), lockOf(list.data), "base64"),
    onSuccess: (_ref, { path }) => {
      invalidate();
      setSelected(path);
    },
  });
  const create = useMutation({
    mutationFn: (path: string) => putFile(node.slug, path, "", lockOf(list.data)),
    onSuccess: (_ref, path) => {
      invalidate();
      setSelected(path);
    },
  });
  if (list.error) return <ErrorMessage error={list.error} />;
  if (!list.data) return <Spinner />;
  const changes = new Map(list.data.changes.map((c) => [c.path, c.change]));
  const removed = list.data.changes.filter((c) => c.change === "removed");
  const askPath = () => window.prompt("Path of the new file", `${node.slug}/`)?.trim();
  return (
    <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
      <div className="space-y-1 text-sm">
        <div className="max-h-[65vh] overflow-y-auto">
          {list.data.files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => setSelected(f.path)}
              className={cx(
                "flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left font-mono text-xs",
                f.path === selected ? "bg-node-soft text-node-dark" : "hover:bg-gray-100",
              )}
            >
              <span className="truncate">{f.path}</span>
              {changes.has(f.path) && (
                <Badge variant={CHANGE_BADGE[changes.get(f.path) ?? "modified"]}>
                  {changes.get(f.path)}
                </Badge>
              )}
            </button>
          ))}
          {removed.map((c) => (
            <div key={c.path} className="px-2 py-1 font-mono text-xs text-gray-400 line-through">
              {c.path}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const path = askPath();
              if (path) create.mutate(path);
            }}
          >
            New File
          </Button>
          <label className="inline-flex cursor-pointer items-center rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-gray-50">
            Upload…
            <input
              type="file"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const path = window.prompt("Save as", `${node.slug}/${file.name}`)?.trim();
                if (path) upload.mutate({ path, file });
              }}
            />
          </label>
        </div>
        {(upload.error || create.error) && <ErrorMessage error={upload.error ?? create.error} />}
      </div>
      <FileEditor
        key={selected}
        node={node}
        path={selected}
        onDeleted={() => setSelected(`${node.slug}.yaml`)}
      />
    </div>
  );
}

function FileEditor({
  node,
  path,
  onDeleted,
}: {
  node: AdminNode;
  path: string;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const file = useQuery({
    queryKey: [...adminKeys.node(node.slug), "file", path],
    queryFn: () => readFile(node.slug, path),
  });
  const [text, setText] = useState<string | null>(null);
  useEffect(() => setText(file.data?.encoding === "utf-8" ? file.data.content : null), [file.data]);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: adminKeys.node(node.slug) });
  const save = useMutation({
    mutationFn: () => putFile(node.slug, path, text ?? "", lockOf(file.data)),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () =>
      api(`/v2/admin/nodes/${node.slug}/draft/file`, {
        method: "DELETE",
        params: { path, lock_version: lockOf(file.data) ?? undefined },
      }),
    onSuccess: () => {
      invalidate();
      onDeleted();
    },
  });
  if (file.error) return <ErrorMessage error={file.error} />;
  if (!file.data) return <Spinner />;
  const dirty = text !== null && text !== file.data.content;
  const isYaml = path === `${node.slug}.yaml`;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs">{path}</span>
        <span className="text-xs text-gray-500">
          {(file.data.size / 1024).toFixed(1)} KB · r{file.data.revision} ({file.data.state})
        </span>
        <span className="ml-auto flex gap-2">
          {!isYaml && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => window.confirm(`Delete ${path} from the draft?`) && remove.mutate()}
            >
              Delete
            </Button>
          )}
          {text !== null && (
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              Save to Draft
            </Button>
          )}
        </span>
      </div>
      {text === null ? (
        <p className="text-sm text-gray-600">Binary file; replace it with Upload.</p>
      ) : (
        <textarea
          aria-label={path}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-[65vh] w-full rounded-md border border-gray-300 p-2 font-mono text-xs"
        />
      )}
      {(save.error || remove.error) && <ErrorMessage error={save.error ?? remove.error} />}
    </div>
  );
}

// --- Admins -------------------------------------------------------------------

function AdminsSection({ node }: { node: AdminNode }) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const found = useQuery({
    queryKey: [...adminKeys.users, q, "", 0],
    queryFn: () =>
      api<{ total: number; users: AdminUser[] }>("/v2/admin/users", {
        params: { q, limit: 10 },
      }),
    enabled: q.trim().length >= 2,
  });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: adminKeys.node(node.slug) });
    queryClient.invalidateQueries({ queryKey: adminKeys.users });
  };
  const add = useMutation({
    mutationFn: (id: number) => api(`/v2/admin/nodes/${node.slug}/admins/${id}`, { method: "PUT" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/v2/admin/nodes/${node.slug}/admins/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const current = new Set(node.admins.map((a) => a.id));
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-gray-600">
        Node admins edit and publish {node.key}'s configuration, see its private contributions, and
        manage this list. Super admins can do all of this on every node.
      </p>
      <Table>
        <TBody>
          {node.admins.map((a) => (
            <Tr key={a.id}>
              <Td>{a.name}</Td>
              <Td>{a.email}</Td>
              <Td className="text-right">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    window.confirm(`Remove ${a.name} as a ${node.key} admin?`) &&
                    remove.mutate(a.id)
                  }
                >
                  Remove
                </Button>
              </Td>
            </Tr>
          ))}
          {node.admins.length === 0 && (
            <Tr>
              <Td className="text-gray-500">No node admins yet.</Td>
            </Tr>
          )}
        </TBody>
      </Table>
      <Field label="Add an admin">
        <Input
          placeholder="Search accounts by name, email or handle"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </Field>
      {found.data && (
        <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
          {found.data.users.map((u) => (
            <li key={u.id} className="flex items-center gap-2 px-3 py-2">
              <span>{u.name}</span>
              <span className="text-gray-500">{u.email}</span>
              <Button
                size="sm"
                className="ml-auto"
                disabled={current.has(u.id) || add.isPending}
                onClick={() => add.mutate(u.id)}
              >
                {current.has(u.id) ? "Admin" : "Add"}
              </Button>
            </li>
          ))}
          {found.data.users.length === 0 && <li className="px-3 py-2 text-gray-500">No match.</li>}
        </ul>
      )}
      {(add.error || remove.error) && <ErrorMessage error={add.error ?? remove.error} />}
    </div>
  );
}

// --- History ------------------------------------------------------------------

function HistorySection({ node }: { node: AdminNode }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: adminKeys.node(node.slug) });
  const rollback = useMutation({
    mutationFn: (number: number) =>
      api(`/v2/admin/nodes/${node.slug}/draft`, { json: { from_revision: number } }),
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: (number: number) =>
      api(`/v2/admin/nodes/${node.slug}/revisions/${number}/write`, { method: "POST" }),
    onSuccess: invalidate,
  });
  return (
    <div className="space-y-3">
      <Table>
        <THead>
          <tr>
            <Th>Revision</Th>
            <Th>State</Th>
            <Th>Message</Th>
            <Th>Published</Th>
            <Th>Repository</Th>
            <Th />
          </tr>
        </THead>
        <TBody>
          {(node.revisions ?? []).map((r) => (
            <Tr key={r.id}>
              <Td>r{r.number}</Td>
              <Td>
                <Badge
                  variant={
                    r.state === "published"
                      ? "success"
                      : r.state === "discarded"
                        ? "muted"
                        : "default"
                  }
                >
                  {r.state}
                </Badge>{" "}
                {r.source === "repo" && <Badge variant="muted">from git</Badge>}
              </Td>
              <Td className="max-w-md">{r.message}</Td>
              <Td className="text-xs">
                {r.published_at && (
                  <>
                    {formatDate(r.published_at)}
                    {r.published_by && <> by {r.published_by}</>}
                  </>
                )}
              </Td>
              <Td>
                <RepoStatus revision={r} />
                {r.repo_error && <div className="text-xs text-red-700">{r.repo_error}</div>}
              </Td>
              <Td className="whitespace-nowrap">
                {r.state === "published" && r.repo_status === "failed" && (
                  <Button size="sm" variant="secondary" onClick={() => retry.mutate(r.number)}>
                    Retry Write
                  </Button>
                )}
                {r.state !== "published" && r.published_at && !node.draft && (
                  <Button
                    size="sm"
                    variant="secondary"
                    title="Open a draft with this revision's files, to publish them again"
                    onClick={() => rollback.mutate(r.number)}
                  >
                    Draft From This
                  </Button>
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      {(rollback.error || retry.error) && <ErrorMessage error={rollback.error ?? retry.error} />}
    </div>
  );
}

// --- Page ---------------------------------------------------------------------

function NodeAdmin({ slug, section }: { slug: string; section: Section }) {
  const navigate = useNavigate();
  const config = useAdminConfig();
  const node = useAdminNode(slug);
  const settings = useNodeSettings(slug);
  if (node.isLoading) return <PageSpinner />;
  if (node.error || !node.data) return <ErrorMessage error={node.error ?? "not found"} />;
  const n = node.data;
  const superAdmin = !!config.data?.is_super_admin;
  return (
    <div className="pb-10">
      <Link to="/admin" search={{ tab: "nodes" }} className="text-sm text-node underline">
        ← Admin Settings
      </Link>
      <h1 className="mt-1 flex flex-wrap items-baseline gap-2 text-xl font-semibold text-gray-900">
        <NodeChip node={n} /> {n.title}
      </h1>
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-gray-600">
        {n.published ? (
          <>
            Live: r{n.published.number}, published {formatDate(n.published.published_at)}
            {n.published.published_by && <> by {n.published.published_by}</>}
            <RepoStatus revision={n.published} />
          </>
        ) : (
          <Badge variant="warning">not published yet</Badge>
        )}
        {!n.served && n.published && (
          <Badge variant="muted">not served by this API (FIESTA_NODE)</Badge>
        )}
      </p>
      <DraftBar node={n} config={config.data} />
      <Tabs
        tabs={SECTIONS}
        active={section}
        onChange={(next) =>
          navigate({ to: "/admin/nodes/$slug", params: { slug }, search: { section: next } })
        }
      />
      {section === "settings" && <SettingsSection node={n} superAdmin={superAdmin} />}
      {["pages", "filters", "data-models", "vocabularies"].includes(section) &&
        (settings.data ? (
          section === "pages" ? (
            <PagesEditor
              slug={slug}
              settings={settings.data.settings}
              settingsLock={lockOf(settings.data)}
            />
          ) : section === "filters" ? (
            <FiltersEditor
              slug={slug}
              settings={settings.data.settings}
              settingsLock={lockOf(settings.data)}
            />
          ) : section === "data-models" ? (
            <DataModelEditor
              slug={slug}
              settings={settings.data.settings}
              settingsLock={lockOf(settings.data)}
            />
          ) : (
            <VocabularyEditor slug={slug} settings={settings.data.settings} />
          )
        ) : (
          <Spinner />
        ))}
      {section === "files" && <FilesSection node={n} />}
      {section === "admins" && <AdminsSection node={n} />}
      {section === "history" && <HistorySection node={n} />}
    </div>
  );
}

export function AdminNodePage() {
  const { slug } = useParams({ from: "/admin/nodes/$slug" });
  const search = useSearch({ from: "/admin/nodes/$slug" }) as AdminNodeParams;
  const section = SECTIONS.some((s) => s.key === search.section)
    ? (search.section as Section)
    : "settings";
  return (
    <AdminGate>
      <NodeAdmin slug={slug} section={section} />
    </AdminGate>
  );
}
