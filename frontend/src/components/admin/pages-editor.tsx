// Editor for a node's content pages: the YAML `pages:` list (order = menu order)
// and each page's HTML in the tree file <slug>/pages/<page-slug>.html. Metadata
// and order are saved as one PATCH of the whole list; each page's HTML is a
// separate file write. Creating a page writes both the list entry and an initial
// HTML file; deleting removes both.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  adminKeys,
  lockOf,
  type NodeSettings,
  patchSettings,
  putFile,
  readFile,
  type SettingsPage,
} from "../../lib/admin";
import { ApiError, api } from "../../lib/api";
import { sanitizeHtml } from "../../lib/sanitize";
import { ErrorMessage } from "../error-message";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Field } from "./admin-ui";

/** A page as the form edits it (menu and icon always present, defaulted). */
interface EditablePage {
  slug: string;
  title: string;
  menu: "left" | "right" | "hidden";
  icon: string;
}

const MENUS: EditablePage["menu"][] = ["left", "right", "hidden"];
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
// Slugs the router already owns, so a content page may not take them.
const RESERVED = new Set([
  "search",
  "contribution",
  "contributions",
  "upload",
  "private",
  "validate",
  "data-models",
  "vocabularies",
  "method-codes",
  "login",
  "contact",
  "admin",
]);

const fromStored = (p: SettingsPage): EditablePage => ({
  slug: p.slug,
  title: p.title,
  menu: p.menu ?? "left",
  icon: p.icon ?? "",
});

/** Back to the YAML shape, dropping the defaults to keep it compact. */
function toStored(pages: EditablePage[]): SettingsPage[] {
  return pages.map((p) => {
    const out: SettingsPage = { slug: p.slug, title: p.title };
    if (p.menu !== "left") out.menu = p.menu;
    if (p.icon.trim()) out.icon = p.icon.trim();
    return out;
  });
}

// The page route renders the title as its heading; the body starts as one paragraph.
const initialHtml = (title: string) =>
  `<p>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")} — coming soon.</p>\n`;

const pagePath = (slug: string, page: string) => `${slug}/pages/${page}.html`;

export function PagesEditor({
  slug,
  settings,
  settingsLock,
}: {
  slug: string;
  settings: NodeSettings;
  /** lockOf() the settings the parent loaded (for edits to the node YAML). */
  settingsLock: number | null;
}) {
  const queryClient = useQueryClient();
  const initial = useMemo(() => (settings.pages ?? []).map(fromStored), [settings.pages]);
  const [pages, setPages] = useState<EditablePage[]>(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.slug ?? null);
  const [draft, setDraft] = useState<EditablePage>({ slug: "", title: "", menu: "left", icon: "" });

  useEffect(() => {
    setPages(initial);
    setSelected((current) =>
      current && initial.some((p) => p.slug === current) ? current : (initial[0]?.slug ?? null),
    );
  }, [initial]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) });

  const save = useMutation({
    mutationFn: () =>
      patchSettings(slug, [{ path: ["pages"], value: toStored(pages) }], settingsLock),
    onSuccess: invalidate,
  });

  const create = useMutation({
    mutationFn: async (entry: EditablePage) => {
      const next = [...pages, entry];
      const ref = await patchSettings(
        slug,
        [{ path: ["pages"], value: toStored(next) }],
        settingsLock,
      );
      await putFile(slug, pagePath(slug, entry.slug), initialHtml(entry.title), ref.lock_version);
      return entry.slug;
    },
    onSuccess: (created) => {
      invalidate();
      setSelected(created);
      setDraft({ slug: "", title: "", menu: "left", icon: "" });
    },
  });

  const remove = useMutation({
    mutationFn: async (page: string) => {
      const next = pages.filter((p) => p.slug !== page);
      const ref = await patchSettings(
        slug,
        [{ path: ["pages"], value: toStored(next) }],
        settingsLock,
      );
      try {
        await api(`/v2/admin/nodes/${slug}/draft/file`, {
          method: "DELETE",
          params: { path: pagePath(slug, page), lock_version: ref.lock_version ?? undefined },
        });
      } catch (error) {
        // The page may never have had a file (created but not yet saved elsewhere).
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      return page;
    },
    onSuccess: () => {
      invalidate();
      setSelected(null);
    },
  });

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= pages.length) return;
    const next = [...pages];
    [next[index], next[target]] = [next[target], next[index]];
    setPages(next);
  };

  const setField = <K extends keyof EditablePage>(field: K, value: EditablePage[K]) =>
    setPages(pages.map((p) => (p.slug === selected ? { ...p, [field]: value } : p)));

  const existing = new Set(pages.map((p) => p.slug));
  const draftError =
    draft.slug && (!SLUG.test(draft.slug) || RESERVED.has(draft.slug) || existing.has(draft.slug))
      ? "a new lowercase slug (letters, digits, hyphens), not a reserved route"
      : null;
  const dirty = JSON.stringify(toStored(pages)) !== JSON.stringify(toStored(initial));
  const current = pages.find((p) => p.slug === selected) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-600">
          Content pages appear in the navigation menu in list order.
        </span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge variant="warning">unsaved order/metadata</Badge>}
          <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setPages(initial)}>
            Reset
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save to Draft
          </Button>
        </span>
      </div>
      {[save.error, create.error, remove.error].map(
        (error, i) => error && <ErrorMessage key={String(i)} error={error} />,
      )}

      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <div className="space-y-2 text-sm">
          <div className="space-y-0.5">
            {pages.map((page, index) => (
              <div
                key={page.slug}
                className={`flex items-center gap-1 rounded-sm px-1 ${
                  page.slug === selected ? "bg-node-soft" : "hover:bg-gray-100"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelected(page.slug)}
                  className={`min-w-0 flex-1 px-1 py-1 text-left ${
                    page.slug === selected ? "font-semibold text-node-dark" : ""
                  }`}
                >
                  <span className="truncate">{page.title || page.slug}</span>
                  <span className="ml-1 font-mono text-xs text-gray-500">/{page.slug}</span>
                  {page.menu !== "left" && (
                    <span className="ml-1 text-xs text-gray-500">({page.menu})</span>
                  )}
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Move down"
                  disabled={index === pages.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
              </div>
            ))}
            {pages.length === 0 && <p className="px-1 py-1 text-gray-500">No pages yet.</p>}
          </div>

          <form
            className="space-y-2 rounded-md border border-gray-200 p-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draftError && draft.slug && draft.title.trim()) create.mutate(draft);
            }}
          >
            <p className="text-xs font-semibold text-gray-700">New page</p>
            <Field label="Slug" hint={draftError ?? "Reachable at /<slug> once published."}>
              <Input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.trim() })}
              />
            </Field>
            <Field label="Title">
              <Input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Menu">
                <select
                  value={draft.menu}
                  onChange={(e) =>
                    setDraft({ ...draft, menu: e.target.value as EditablePage["menu"] })
                  }
                  className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                >
                  {MENUS.map((menu) => (
                    <option key={menu}>{menu}</option>
                  ))}
                </select>
              </Field>
              <Field label="Icon">
                <Input
                  value={draft.icon}
                  onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
                />
              </Field>
            </div>
            <Button
              size="sm"
              type="submit"
              disabled={!!draftError || !draft.slug || !draft.title.trim() || create.isPending}
            >
              Create Page
            </Button>
          </form>
        </div>

        {current ? (
          <div className="min-w-0 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <Field label={`Title (/${current.slug})`}>
                  <Input
                    value={current.title}
                    onChange={(e) => setField("title", e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Menu">
                <select
                  value={current.menu}
                  onChange={(e) => setField("menu", e.target.value as EditablePage["menu"])}
                  className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
                >
                  {MENUS.map((menu) => (
                    <option key={menu}>{menu}</option>
                  ))}
                </select>
              </Field>
              <Field label="Icon">
                <Input value={current.icon} onChange={(e) => setField("icon", e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() =>
                    window.confirm(`Delete the ${current.slug} page and its HTML?`) &&
                    remove.mutate(current.slug)
                  }
                >
                  Delete Page
                </Button>
              </div>
            </div>
            <p className="text-xs text-gray-500">
              Reachable at <span className="font-mono">/{current.slug}</span> once the draft is
              published. Title, menu and icon save with the list above.
            </p>
            <PageHtml
              key={current.slug}
              slug={slug}
              page={current.slug}
              settingsLock={settingsLock}
            />
          </div>
        ) : (
          <p className="text-sm text-gray-600">Select a page, or create one.</p>
        )}
      </div>
    </div>
  );
}

/** One page's HTML file, edited beside a sanitized live preview. */
function PageHtml({
  slug,
  page,
  settingsLock,
}: {
  slug: string;
  page: string;
  settingsLock: number | null;
}) {
  const queryClient = useQueryClient();
  const path = pagePath(slug, page);
  const file = useQuery({
    queryKey: [...adminKeys.node(slug), "file", path],
    queryFn: async () => {
      try {
        return await readFile(slug, path);
      } catch (error) {
        // A page whose file has not been written yet starts empty.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!file.isSuccess) return;
    setHtml(file.data?.content ?? "");
  }, [file.isSuccess, file.data]);

  const save = useMutation({
    mutationFn: () => putFile(slug, path, html ?? "", file.data ? lockOf(file.data) : settingsLock),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) }),
  });

  if (file.isLoading || html === null)
    return file.error ? <ErrorMessage error={file.error} /> : <Spinner />;
  const dirty = html !== (file.data?.content ?? "");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-xs text-gray-500">{path}</span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge variant="warning">unsaved HTML</Badge>}
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save HTML to Draft
          </Button>
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <textarea
          aria-label="Page HTML"
          spellCheck={false}
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          className="h-[55vh] w-full rounded-md border border-gray-300 p-2 font-mono text-xs"
        />
        <div className="h-[55vh] overflow-y-auto rounded-md border border-gray-200 p-3">
          <p className="mb-2 text-xs font-semibold text-gray-500">
            Preview (as the page renders it)
          </p>
          <div
            className="er-content text-sm text-[#555555]"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered through sanitizeHtml (DOMPurify)
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
          />
        </div>
      </div>
      {save.error && <ErrorMessage error={save.error} />}
    </div>
  );
}
