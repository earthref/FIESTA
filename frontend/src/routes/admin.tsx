// Admin settings: FIESTA nodes and EarthRef accounts. Super admins see every
// node and edit accounts; node admins see their nodes and look accounts up.
// Node configuration editing lives in admin-node.tsx.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AdminGate, Field, NodeChip, RepoStatus, Tabs } from "../components/admin/admin-ui";
import { ErrorMessage } from "../components/error-message";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Modal } from "../components/ui/modal";
import { Spinner } from "../components/ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../components/ui/table";
import {
  type AdminNode,
  type AdminUser,
  adminKeys,
  formatDate,
  useAdminConfig,
} from "../lib/admin";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { AdminParams } from "../router";

// --- Nodes ----------------------------------------------------------------------

function NodesPanel({ superAdmin }: { superAdmin: boolean }) {
  const [creating, setCreating] = useState(false);
  const nodes = useQuery({
    queryKey: adminKeys.nodes,
    queryFn: () => api<AdminNode[]>("/v2/admin/nodes"),
  });
  if (nodes.isLoading) return <Spinner label="Loading nodes…" />;
  if (nodes.error) return <ErrorMessage error={nodes.error} />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-gray-600">
          {superAdmin ? "Every FIESTA node." : "The nodes you administer."} Changes are drafted here
          and go live when published.
        </p>
        {superAdmin && <Button onClick={() => setCreating(true)}>New Node</Button>}
      </div>
      <Table>
        <THead>
          <tr>
            <Th>Node</Th>
            <Th>Title</Th>
            <Th>Published</Th>
            <Th>Draft</Th>
            <Th>Admins</Th>
          </tr>
        </THead>
        <TBody>
          {(nodes.data ?? []).map((node) => (
            <Tr key={node.slug}>
              <Td>
                <Link to="/admin/nodes/$slug" params={{ slug: node.slug }} className="underline">
                  <NodeChip node={node} />
                </Link>
                <div className="text-xs text-gray-500">{node.slug}</div>
              </Td>
              <Td>{node.title ?? <span className="text-gray-400">not served</span>}</Td>
              <Td>
                {node.published ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <span>r{node.published.number}</span>
                    <span className="text-xs text-gray-500">
                      {formatDate(node.published.published_at)}
                    </span>
                    <RepoStatus revision={node.published} />
                  </div>
                ) : (
                  <Badge variant="warning">never published</Badge>
                )}
              </Td>
              <Td>
                {node.draft ? (
                  <Badge variant="node">
                    r{node.draft.number} by {node.draft.author ?? "?"}
                  </Badge>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </Td>
              <Td className="text-xs">{node.admins.map((a) => a.name).join(", ") || "—"}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      {creating && <NewNodeModal nodes={nodes.data ?? []} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewNodeModal({ nodes, onClose }: { nodes: AdminNode[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState(nodes[0]?.slug ?? "");
  const create = useMutation({
    mutationFn: () =>
      api<AdminNode>("/v2/admin/nodes", {
        json: { key, slug: slug || key.toLowerCase(), title, template },
      }),
    onSuccess: (node) => {
      queryClient.invalidateQueries({ queryKey: adminKeys.nodes });
      navigate({ to: "/admin/nodes/$slug", params: { slug: node.slug } });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="New Node"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-node" disabled={!key || !title || create.isPending}>
            Create Draft
          </Button>
        </>
      }
    >
      <form id="new-node" onSubmit={submit} className="space-y-3 text-sm">
        <p className="text-gray-600">
          The new node starts as a draft with a copy of the template node's data models and
          vocabularies. Nothing is served until you publish it; publishing creates its database
          schema, search index and storage prefix, and writes its YAML to the repository.
        </p>
        <Field label="Key" hint="Shown in the portal bar and the URL, e.g. MagIC">
          <Input value={key} onChange={(e) => setKey(e.target.value)} required />
        </Field>
        <Field label="Slug" hint="Lowercase; names the schema, index and queue. Cannot change.">
          <Input
            value={slug}
            placeholder={key.toLowerCase()}
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        <Field label="Copy data models and vocabularies from">
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2"
          >
            {nodes
              .filter((node) => node.published)
              .map((node) => (
                <option key={node.slug} value={node.slug}>
                  {node.key}
                </option>
              ))}
          </select>
        </Field>
        {create.error && <ErrorMessage error={create.error} />}
      </form>
    </Modal>
  );
}

// --- Users ----------------------------------------------------------------------

const PAGE = 50;

function UsersPanel({ superAdmin }: { superAdmin: boolean }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<"" | "super" | "node">("");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<AdminUser | "new" | null>(null);
  const users = useQuery({
    queryKey: [...adminKeys.users, q, role, offset],
    queryFn: () =>
      api<{ total: number; users: AdminUser[] }>("/v2/admin/users", {
        params: { q, role, offset, limit: PAGE },
      }),
    placeholderData: (previous) => previous,
  });
  const nodes = useQuery({
    queryKey: adminKeys.nodes,
    queryFn: () => api<AdminNode[]>("/v2/admin/nodes"),
    enabled: superAdmin,
  });
  const total = users.data?.total ?? 0;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search name, email, handle or ORCID"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
        />
        <select
          value={role}
          onChange={(e) => {
            setRole(e.target.value as typeof role);
            setOffset(0);
          }}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          aria-label="Role"
        >
          <option value="">All accounts</option>
          <option value="super">Super admins</option>
          <option value="node">Node admins</option>
        </select>
        <span className="text-sm text-gray-500">{total} accounts</span>
        {superAdmin && (
          <Button className="ml-auto" onClick={() => setEditing("new")}>
            New Account
          </Button>
        )}
      </div>
      {users.error && <ErrorMessage error={users.error} />}
      <Table>
        <THead>
          <tr>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Handle</Th>
            <Th>ORCID</Th>
            <Th>Roles</Th>
            {superAdmin && <Th />}
          </tr>
        </THead>
        <TBody>
          {(users.data?.users ?? []).map((u) => (
            <Tr key={u.id}>
              <Td>{u.name}</Td>
              <Td>{u.email}</Td>
              <Td>{u.handle ?? ""}</Td>
              <Td>{u.orcid ?? ""}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {u.is_admin && <Badge variant="danger">super admin</Badge>}
                  {u.admin_nodes.map((slug) => (
                    <Badge key={slug} variant="node">
                      {slug} admin
                    </Badge>
                  ))}
                </div>
              </Td>
              {superAdmin && (
                <Td>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(u)}>
                    Edit
                  </Button>
                </Td>
              )}
            </Tr>
          ))}
        </TBody>
      </Table>
      {total > PAGE && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <Button
            size="sm"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}
      {editing && (
        <UserModal
          user={editing === "new" ? null : editing}
          nodes={nodes.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function UserModal({
  user,
  nodes,
  onClose,
}: {
  user: AdminUser | null;
  nodes: AdminNode[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const [email, setEmail] = useState(user?.email ?? "");
  const [name, setName] = useState(user?.name ?? "");
  const [handle, setHandle] = useState(user?.handle ?? "");
  const [orcid, setOrcid] = useState(user?.orcid ?? "");
  const [password, setPassword] = useState("");
  const [superAdmin, setSuperAdmin] = useState(user?.is_admin ?? false);
  const [adminNodes, setAdminNodes] = useState<string[]>(user?.admin_nodes ?? []);
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        email,
        name,
        handle: handle || null,
        orcid: orcid || null,
        is_admin: superAdmin,
        ...(password ? { password } : {}),
      };
      if (!user) {
        const created = await api<AdminUser>("/v2/admin/users", { json: body });
        if (adminNodes.length === 0) return created;
        return api<AdminUser>(`/v2/admin/users/${created.id}`, {
          method: "PATCH",
          json: { admin_nodes: adminNodes },
        });
      }
      return api<AdminUser>(`/v2/admin/users/${user.id}`, {
        method: "PATCH",
        json: { ...body, admin_nodes: adminNodes },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.users });
      queryClient.invalidateQueries({ queryKey: adminKeys.nodes });
      if (user?.id === me?.id) queryClient.invalidateQueries({ queryKey: ["auth"] });
      onClose();
    },
  });
  const toggleNode = (slug: string) =>
    setAdminNodes((current) =>
      current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug].sort(),
    );
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : "New Account"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="user-form" disabled={!email || !name || save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="user-form"
        className="space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Handle">
            <Input value={handle} onChange={(e) => setHandle(e.target.value)} />
          </Field>
          <Field label="ORCID">
            <Input
              value={orcid}
              placeholder="0000-0000-0000-0000"
              onChange={(e) => setOrcid(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label={user ? "New password" : "Password"}
          hint={
            user
              ? "Leave empty to keep the current password."
              : "At least 8 characters; leave empty for an account without a password (ORCID login)."
          }
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={superAdmin}
            onChange={(e) => setSuperAdmin(e.target.checked)}
          />
          <span>
            <strong>Super admin</strong> — every node, node creation and accounts
          </span>
        </label>
        <fieldset>
          <legend className="mb-1 text-xs font-semibold text-gray-700">Node admin of</legend>
          <div className="flex flex-wrap gap-3">
            {nodes.map((node) => (
              <label key={node.slug} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={adminNodes.includes(node.slug)}
                  onChange={() => toggleNode(node.slug)}
                />
                <NodeChip node={node} />
              </label>
            ))}
          </div>
        </fieldset>
        {save.error && <ErrorMessage error={save.error} />}
      </form>
    </Modal>
  );
}

// --- Page -----------------------------------------------------------------------

export function AdminPage() {
  const search = useSearch({ from: "/admin" }) as AdminParams;
  const navigate = useNavigate();
  const config = useAdminConfig();
  const tab = search.tab === "users" ? "users" : "nodes";
  return (
    <AdminGate>
      <div className="pb-10">
        <h1 className="mb-1 text-xl font-semibold text-gray-900">Admin Settings</h1>
        <p className="mb-4 text-sm text-gray-600">
          {config.data?.is_super_admin
            ? "You are a super admin: every FIESTA node and every EarthRef account."
            : `You administer ${config.data?.admin_nodes.join(", ") ?? "…"}.`}
          {config.data && !config.data.editing && (
            <span className="ml-1 text-amber-700">
              This deployment reads node configuration from files; edit config/ in the repository
              instead.
            </span>
          )}
        </p>
        <Tabs
          tabs={[
            { key: "nodes", label: "Nodes" },
            { key: "users", label: "Accounts" },
          ]}
          active={tab}
          onChange={(next) => navigate({ to: "/admin", search: { tab: next } })}
        />
        {config.isLoading ? (
          <Spinner />
        ) : tab === "nodes" ? (
          config.data?.editing ? (
            <NodesPanel superAdmin={!!config.data?.is_super_admin} />
          ) : null
        ) : (
          <UsersPanel superAdmin={!!config.data?.is_super_admin} />
        )}
      </div>
    </AdminGate>
  );
}
