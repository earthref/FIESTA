// Editor for a node's controlled / suggested vocabularies:
// {name: {label, database_column | database_name, items: [{item, label?}]}}.
// Items are edited one per line as `item` or `item | label`; fields the
// editor does not show are kept.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  adminKeys,
  formatJsonLike,
  lockOf,
  type NodeSettings,
  putFile,
  readFile,
} from "../../lib/admin";
import { ErrorMessage } from "../error-message";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Field } from "./admin-ui";

interface VocabItem {
  item: string;
  label?: string;
  [key: string]: unknown;
}

interface Vocabulary {
  label?: string;
  items?: VocabItem[];
  [key: string]: unknown;
}

type Vocabularies = Record<string, Vocabulary>;

function itemsToText(items: VocabItem[] = []): string {
  return items.map((i) => (i.label ? `${i.item} | ${i.label}` : i.item)).join("\n");
}

function textToItems(text: string, previous: VocabItem[] = []): VocabItem[] {
  const byItem = new Map(previous.map((i) => [i.item, i]));
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [item, ...label] = line.split(" | ");
      const kept = { ...(byItem.get(item.trim()) ?? {}), item: item.trim() };
      if (label.length) kept.label = label.join(" | ").trim();
      else delete kept.label;
      return kept;
    });
}

export function VocabularyEditor({ slug, settings }: { slug: string; settings: NodeSettings }) {
  const queryClient = useQueryClient();
  const files = [
    { kind: "controlled", path: settings.vocabularies.controlled },
    { kind: "suggested", path: settings.vocabularies.suggested },
  ].filter((f): f is { kind: string; path: string } => !!f.path);
  const [path, setPath] = useState(files[0]?.path ?? "");
  const file = useQuery({
    queryKey: [...adminKeys.node(slug), "file", path],
    queryFn: () => readFile(slug, path),
    enabled: !!path,
  });
  const [vocabs, setVocabs] = useState<Vocabularies | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [itemsText, setItemsText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState("");

  /** Select a vocabulary and load its items into the textarea. */
  const choose = (name: string | null, source: Vocabularies) => {
    setSelected(name);
    setItemsText(name ? itemsToText(source[name]?.items) : "");
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the file does
  useEffect(() => {
    if (!file.data) return;
    const parsed = JSON.parse(file.data.content) as Vocabularies;
    setVocabs(parsed);
    setDirty(false);
    choose(
      selected && parsed[selected] ? selected : (Object.keys(parsed).sort()[0] ?? null),
      parsed,
    );
  }, [file.data]);

  const save = useMutation({
    mutationFn: () => {
      if (!vocabs || !file.data) throw new Error("nothing loaded");
      return putFile(
        slug,
        path,
        formatJsonLike(file.data.content, commitItems()),
        lockOf(file.data),
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) });
    },
  });

  /** vocabs with the items textarea of the selected vocabulary applied. */
  function commitItems(): Vocabularies {
    if (!vocabs || !selected) return vocabs ?? {};
    return {
      ...vocabs,
      [selected]: {
        ...vocabs[selected],
        items: textToItems(itemsText, vocabs[selected].items),
      },
    };
  }

  const select = (name: string) => {
    const committed = commitItems();
    setVocabs(committed);
    choose(name, committed);
  };

  const add = () => {
    const name = window.prompt("New vocabulary (the column it controls, e.g. lithologies)")?.trim();
    if (!name || !vocabs) return;
    if (vocabs[name]) {
      window.alert(`${name} already exists`);
      return;
    }
    const next = { ...commitItems(), [name]: { label: name, database_column: name, items: [] } };
    setVocabs(next);
    choose(name, next);
    setDirty(true);
  };

  const remove = () => {
    if (!vocabs || !selected || !window.confirm(`Delete the ${selected} vocabulary?`)) return;
    const { [selected]: _removed, ...rest } = vocabs;
    setVocabs(rest);
    choose(Object.keys(rest).sort()[0] ?? null, rest);
    setDirty(true);
  };

  if (!path) return <p className="text-sm text-gray-600">This node has no vocabularies.</p>;
  if (file.error) return <ErrorMessage error={file.error} />;
  if (!vocabs) return <Spinner />;
  const names = Object.keys(vocabs)
    .sort()
    .filter((n) => !filter || n.includes(filter.toLowerCase()));
  const current = selected ? vocabs[selected] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          aria-label="Vocabulary file"
          value={path}
          onChange={(e) => {
            if (dirty && !window.confirm("Discard unsaved changes?")) return;
            setPath(e.target.value);
          }}
          className="rounded-md border border-gray-300 px-2 py-1"
        >
          {files.map((f) => (
            <option key={f.path} value={f.path}>
              {f.kind} ({f.path})
            </option>
          ))}
        </select>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge variant="warning">unsaved changes</Badge>}
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save to Draft
          </Button>
        </span>
      </div>
      {save.error && <ErrorMessage error={save.error} />}
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div className="space-y-1 text-sm">
          <Input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="max-h-[60vh] overflow-y-auto">
            {names.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => select(name)}
                className={`block w-full rounded-sm px-2 py-1 text-left ${
                  name === selected
                    ? "bg-node-soft font-semibold text-node-dark"
                    : "hover:bg-gray-100"
                }`}
              >
                {name}
                <span className="ml-1 text-xs text-gray-500">
                  {vocabs[name].items?.length ?? 0}
                </span>
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={add}>
            + Add Vocabulary
          </Button>
        </div>
        {current && selected && (
          <div className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field label={`Label (${selected})`}>
                  <Input
                    value={current.label ?? ""}
                    onChange={(e) => {
                      setVocabs({ ...vocabs, [selected]: { ...current, label: e.target.value } });
                      setDirty(true);
                    }}
                  />
                </Field>
              </div>
              <Button size="sm" variant="danger" onClick={remove}>
                Delete
              </Button>
            </div>
            <Field label="Items" hint="One per line: item, or item | label">
              <textarea
                rows={20}
                value={itemsText}
                onChange={(e) => {
                  setItemsText(e.target.value);
                  setDirty(true);
                }}
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}
