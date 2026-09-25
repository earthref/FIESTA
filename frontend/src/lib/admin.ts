// Admin settings API (/v2/admin/..., see docs/api.md "Admin"). Super admins
// (`is_admin`) manage accounts and every node; node admins (`admin_nodes`)
// edit and publish their nodes' configuration and manage their admins.

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";
import type { UserOut } from "./types";

export function isAnyAdmin(user: UserOut | null): boolean {
  return !!user && (user.is_admin || user.admin_nodes.length > 0);
}

export interface AdminConfig {
  editing: boolean;
  publish_to: "none" | "files" | "github";
  repository: string | null;
  is_super_admin: boolean;
  admin_nodes: string[];
  /** The nodes this API serves. */
  nodes: { slug: string; key: string; color: string }[];
}

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  handle: string | null;
  orcid: string | null;
  is_admin: boolean;
  admin_nodes: string[];
  created_at: string;
}

export interface NodeRevision {
  id: number;
  number: number;
  state: "draft" | "published" | "superseded" | "discarded";
  source: "ui" | "repo";
  message: string | null;
  lock_version: number;
  tree_hash: string;
  author: string | null;
  created_at: string;
  updated_at: string;
  published_by: string | null;
  published_at: string | null;
  repo_status: "pending" | "written" | "failed" | "skipped" | null;
  repo_ref: string | null;
  repo_error: string | null;
}

export interface AdminNode {
  slug: string;
  key: string;
  title: string | null;
  color: string | null;
  served: boolean;
  published: NodeRevision | null;
  draft: NodeRevision | null;
  draft_is_stale: boolean;
  admins: { id: number; name: string; email: string }[];
  revisions?: NodeRevision[];
  plugins?: string[];
}

export interface FileChange {
  path: string;
  change: "added" | "modified" | "removed";
}

export interface FileList {
  revision: number;
  state: NodeRevision["state"];
  lock_version: number;
  files: { path: string; sha256: string }[];
  changes: FileChange[];
}

export interface FileContent {
  path: string;
  revision: number;
  state: NodeRevision["state"];
  lock_version: number;
  size: number;
  encoding: "utf-8" | "base64";
  content: string;
}

export interface Validation {
  ok: boolean;
  errors: string[];
  protected_changes: string[];
  can_publish: boolean;
  changes: FileChange[];
}

export interface DraftRef {
  revision: number;
  lock_version: number;
}

/** The node YAML, parsed (only the fields the settings form edits are typed). */
export interface NodeSettings {
  node: {
    key: string;
    slug: string;
    title: string;
    subtitle?: string;
    color?: string;
    links?: { website?: string | null; github_issues?: string | null };
    contact_email?: string | null;
  };
  search: { index: string; levels: { name: string; table: string }[]; facets?: string[] };
  storage: { bucket: string };
  data_model: { versions: string[]; latest: string; dir: string };
  vocabularies: { controlled: string; suggested?: string | null; method_codes?: string | null };
  hierarchy: string[];
  doi?: { prefix?: string | null };
  features?: { pages?: string[]; plugins?: string[] };
  [key: string]: unknown;
}

export interface SettingsOp {
  path: (string | number)[];
  value: unknown;
}

export const adminKeys = {
  config: ["admin", "config"] as const,
  nodes: ["admin", "nodes"] as const,
  node: (slug: string) => ["admin", "node", slug] as const,
  users: ["admin", "users"] as const,
};

export function useAdminConfig() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...adminKeys.config, user?.id],
    queryFn: () => api<AdminConfig>("/v2/admin/config"),
    enabled: isAnyAdmin(user),
  });
}

export function useAdminNode(slug: string) {
  return useQuery({
    queryKey: adminKeys.node(slug),
    queryFn: () => api<AdminNode>(`/v2/admin/nodes/${slug}`),
  });
}

/** The lock to send with an edit of content loaded from `loaded`: the draft's
 * version when it came from the draft (so a concurrent edit is refused), none
 * when it came from the published revision (the edit opens the draft). */
export function lockOf(loaded: { state: NodeRevision["state"]; lock_version: number } | undefined) {
  return loaded?.state === "draft" ? loaded.lock_version : null;
}

export function useNodeSettings(slug: string, rev = "current") {
  return useQuery({
    queryKey: [...adminKeys.node(slug), "settings", rev],
    queryFn: () =>
      api<{
        revision: number;
        state: NodeRevision["state"];
        lock_version: number;
        settings: NodeSettings;
      }>(`/v2/admin/nodes/${slug}/settings`, { params: { rev } }),
  });
}

export function readFile(slug: string, path: string, rev = "current") {
  return api<FileContent>(`/v2/admin/nodes/${slug}/file`, { params: { path, rev } });
}

export function putFile(
  slug: string,
  path: string,
  content: string,
  lockVersion: number | null,
  encoding: "utf-8" | "base64" = "utf-8",
) {
  return api<DraftRef>(`/v2/admin/nodes/${slug}/draft/file`, {
    method: "PUT",
    json: { path, content, encoding, lock_version: lockVersion },
  });
}

export function patchSettings(slug: string, ops: SettingsOp[], lockVersion: number | null) {
  return api<DraftRef>(`/v2/admin/nodes/${slug}/draft/settings`, {
    method: "PATCH",
    json: { ops, lock_version: lockVersion },
  });
}

/** Serialize JSON the way the file already is (legacy data models use a
 * one-space indent and a trailing newline), so git diffs stay small. */
export function formatJsonLike(original: string, value: unknown): string {
  const indent = original.match(/^\{\n( +)"/)?.[1].length ?? 1;
  return `${JSON.stringify(value, null, indent)}${original.endsWith("\n") ? "\n" : ""}`;
}

export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "";
}
