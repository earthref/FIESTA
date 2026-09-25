// Structured editor for one data model version (config/<slug>/data_models/<v>.json):
// tables and their columns, keeping every field it does not show (urls,
// previous_columns, ...) and the file's JSON formatting. Saving writes the
// whole file into the node's draft.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  adminKeys,
  formatJsonLike,
  lockOf,
  type NodeSettings,
  patchSettings,
  putFile,
  readFile,
} from "../../lib/admin";
import { ErrorMessage } from "../error-message";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Spinner } from "../ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../ui/table";
import { Field } from "./admin-ui";

interface Column {
  label?: string;
  group?: string;
  position?: number;
  type?: string;
  unit?: string;
  description?: string;
  notes?: string;
  examples?: string[];
  validations?: string[];
  [key: string]: unknown;
}

interface DataTable {
  label?: string;
  position?: number;
  description?: string;
  notes?: string;
  columns: Record<string, Column>;
  [key: string]: unknown;
}

interface DataModel {
  data_model_version?: string;
  tables: Record<string, DataTable>;
  [key: string]: unknown;
}

const TYPES = ["String", "Integer", "Number", "Timestamp", "List", "Dictionary", "Matrix"];
const NAME = /^[a-z][a-z0-9_]*$/;

function byPosition<T extends { position?: number }>(entries: [string, T][]): [string, T][] {
  return [...entries].sort((a, b) => (a[1].position ?? 0) - (b[1].position ?? 0));
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function DataModelEditor({
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
  const versions = settings.data_model.versions;
  const [version, setVersion] = useState(settings.data_model.latest);
  const path = `${settings.data_model.dir}/${version}.json`;
  const file = useQuery({
    queryKey: [...adminKeys.node(slug), "file", path],
    queryFn: () => readFile(slug, path),
  });
  const [model, setModel] = useState<DataModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [table, setTable] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; column: Column } | "new" | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!file.data) return;
    const parsed = JSON.parse(file.data.content) as DataModel;
    setModel(parsed);
    setDirty(false);
    setTable((current) =>
      current && parsed.tables[current]
        ? current
        : (byPosition(Object.entries(parsed.tables))[0]?.[0] ?? null),
    );
  }, [file.data]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) });
  };

  const save = useMutation({
    mutationFn: () => {
      if (!model || !file.data) throw new Error("nothing loaded");
      return putFile(slug, path, formatJsonLike(file.data.content, model), lockOf(file.data));
    },
    onSuccess: invalidate,
  });

  const newVersion = useMutation({
    mutationFn: async (name: string) => {
      if (!model || !file.data) throw new Error("nothing loaded");
      const copy = { ...model, data_model_version: name };
      const ref = await putFile(
        slug,
        `${settings.data_model.dir}/${name}.json`,
        formatJsonLike(file.data.content, copy),
        lockOf(file.data),
      );
      return patchSettings(
        slug,
        [{ path: ["data_model", "versions"], value: [...versions, name] }],
        ref.lock_version,
      );
    },
    onSuccess: (_ref, name) => {
      invalidate();
      setVersion(name);
    },
  });

  const makeLatest = useMutation({
    mutationFn: () =>
      patchSettings(slug, [{ path: ["data_model", "latest"], value: version }], settingsLock),
    onSuccess: invalidate,
  });

  const update = (next: DataModel) => {
    setModel(next);
    setDirty(true);
  };

  const tables = useMemo(() => (model ? byPosition(Object.entries(model.tables)) : []), [model]);
  const current = model && table ? model.tables[table] : null;
  const columns = current
    ? byPosition(Object.entries(current.columns)).filter(
        ([name, col]) =>
          !filter ||
          name.includes(filter.toLowerCase()) ||
          (col.label ?? "").toLowerCase().includes(filter.toLowerCase()),
      )
    : [];

  const setTableField = (field: keyof DataTable, value: string) => {
    if (!model || !table) return;
    update({
      ...model,
      tables: { ...model.tables, [table]: { ...model.tables[table], [field]: value } },
    });
  };

  const putColumn = (name: string, column: Column) => {
    if (!model || !table) return;
    const t = model.tables[table];
    update({
      ...model,
      tables: { ...model.tables, [table]: { ...t, columns: { ...t.columns, [name]: column } } },
    });
  };

  const deleteColumn = (name: string) => {
    if (!model || !table) return;
    const t = model.tables[table];
    const { [name]: _removed, ...rest } = t.columns;
    update({ ...model, tables: { ...model.tables, [table]: { ...t, columns: rest } } });
  };

  const addTable = () => {
    if (!model) return;
    const name = window.prompt("New table name (lowercase, e.g. samples)")?.trim();
    if (!name) return;
    if (!NAME.test(name) || model.tables[name]) {
      window.alert(`${name} is not a new lowercase table name`);
      return;
    }
    const position = Math.max(0, ...Object.values(model.tables).map((t) => t.position ?? 0)) + 1;
    update({
      ...model,
      tables: { ...model.tables, [name]: { label: name, position, description: "", columns: {} } },
    });
    setTable(name);
  };

  const deleteTable = () => {
    if (!model || !table) return;
    if (settings.hierarchy.includes(table)) {
      window.alert(`${table} is in the node's hierarchy; remove it there first.`);
      return;
    }
    if (
      !window.confirm(
        `Delete table ${table} and its ${Object.keys(model.tables[table].columns).length} columns?`,
      )
    )
      return;
    const { [table]: _removed, ...rest } = model.tables;
    update({ ...model, tables: rest });
    setTable(Object.keys(rest)[0] ?? null);
  };

  if (file.isLoading || !model)
    return file.error ? <ErrorMessage error={file.error} /> : <Spinner />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Version</span>
        <select
          aria-label="Data model version"
          value={version}
          onChange={(e) => {
            if (dirty && !window.confirm("Discard unsaved changes to this version?")) return;
            setVersion(e.target.value);
          }}
          className="rounded-md border border-gray-300 px-2 py-1"
        >
          {versions.map((v) => (
            <option key={v} value={v}>
              {v}
              {v === settings.data_model.latest ? " (latest)" : ""}
            </option>
          ))}
        </select>
        {version !== settings.data_model.latest && (
          <Button size="sm" variant="secondary" onClick={() => makeLatest.mutate()}>
            Make Latest
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={dirty}
          title={dirty ? "Save first" : undefined}
          onClick={() => {
            const name = window.prompt(`New version copied from ${version}, e.g. 3.1`)?.trim();
            if (!name) return;
            if (versions.includes(name)) window.alert(`${name} already exists`);
            else newVersion.mutate(name);
          }}
        >
          New Version From This
        </Button>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge variant="warning">unsaved changes</Badge>}
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save to Draft
          </Button>
        </span>
      </div>
      {[save.error, newVersion.error, makeLatest.error].map(
        (error, i) => error && <ErrorMessage key={String(i)} error={error} />,
      )}

      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <nav aria-label="Tables" className="space-y-0.5 text-sm">
          {tables.map(([name, t]) => (
            <button
              key={name}
              type="button"
              onClick={() => setTable(name)}
              className={`block w-full rounded-sm px-2 py-1 text-left ${
                name === table ? "bg-node-soft font-semibold text-node-dark" : "hover:bg-gray-100"
              }`}
            >
              {t.label ?? name}
              <span className="ml-1 text-xs text-gray-500">{Object.keys(t.columns).length}</span>
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={addTable}>
            + Add Table
          </Button>
        </nav>

        {current && table && (
          <div className="min-w-0 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Table label (${table})`}>
                <Input
                  value={current.label ?? ""}
                  onChange={(e) => setTableField("label", e.target.value)}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={current.description ?? ""}
                  onChange={(e) => setTableField("description", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Notes">
              <textarea
                value={current.notes ?? ""}
                onChange={(e) => setTableField("notes", e.target.value)}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Input
                className="max-w-xs"
                placeholder="Filter columns"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <Button size="sm" onClick={() => setEditing("new")}>
                Add Column
              </Button>
              <Button size="sm" variant="danger" className="ml-auto" onClick={deleteTable}>
                Delete Table
              </Button>
            </div>
            <Table>
              <THead>
                <tr>
                  <Th>Column</Th>
                  <Th>Label</Th>
                  <Th>Group</Th>
                  <Th>Type</Th>
                  <Th>Validations</Th>
                  <Th />
                </tr>
              </THead>
              <TBody>
                {columns.map(([name, col]) => (
                  <Tr key={name}>
                    <Td className="font-mono text-xs">{name}</Td>
                    <Td>{col.label}</Td>
                    <Td className="text-xs">{col.group}</Td>
                    <Td className="text-xs">{col.type}</Td>
                    <Td className="max-w-[16rem] truncate font-mono text-xs">
                      {(col.validations ?? []).join(", ")}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing({ name, column: col })}
                      >
                        Edit
                      </Button>{" "}
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          window.confirm(`Delete column ${name}?`) && deleteColumn(name)
                        }
                      >
                        Delete
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>

      {editing && current && (
        <ColumnModal
          name={editing === "new" ? null : editing.name}
          column={
            editing === "new"
              ? {
                  label: "",
                  group: "",
                  type: "String",
                  position:
                    Math.max(0, ...Object.values(current.columns).map((c) => c.position ?? 0)) + 1,
                  description: "",
                }
              : editing.column
          }
          existing={Object.keys(current.columns)}
          onClose={() => setEditing(null)}
          onSave={(name, column) => {
            putColumn(name, column);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ColumnModal({
  name,
  column,
  existing,
  onClose,
  onSave,
}: {
  name: string | null;
  column: Column;
  existing: string[];
  onClose: () => void;
  onSave: (name: string, column: Column) => void;
}) {
  const [key, setKey] = useState(name ?? "");
  const [draft, setDraft] = useState<Column>(column);
  const [examples, setExamples] = useState((column.examples ?? []).join("\n"));
  const [validations, setValidations] = useState((column.validations ?? []).join("\n"));
  const keyError =
    name === null && (!NAME.test(key) || existing.includes(key))
      ? "a new lowercase column name (letters, digits, _)"
      : null;
  const set = (field: keyof Column, value: unknown) => setDraft({ ...draft, [field]: value });
  const submit = () => {
    const out: Column = { ...draft, examples: lines(examples), validations: lines(validations) };
    for (const field of ["examples", "validations", "unit", "notes"] as const) {
      const value = out[field];
      if ((Array.isArray(value) && value.length === 0 && !(field in column)) || value === "")
        delete out[field];
    }
    onSave(name ?? key, out);
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={name ? `Column ${name}` : "New Column"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!keyError} onClick={submit}>
            Apply
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        {name === null && (
          <Field label="Column name" hint={keyError ?? undefined}>
            <Input value={key} onChange={(e) => setKey(e.target.value.trim())} />
          </Field>
        )}
        <Field label="Label">
          <Input value={draft.label ?? ""} onChange={(e) => set("label", e.target.value)} />
        </Field>
        <Field label="Group">
          <Input value={draft.group ?? ""} onChange={(e) => set("group", e.target.value)} />
        </Field>
        <Field label="Type">
          <select
            value={draft.type ?? "String"}
            onChange={(e) => set("type", e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2"
          >
            {TYPES.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </Field>
        <Field label="Unit">
          <Input value={draft.unit ?? ""} onChange={(e) => set("unit", e.target.value)} />
        </Field>
        <Field label="Position">
          <Input
            type="number"
            value={draft.position ?? 0}
            onChange={(e) => set("position", Number(e.target.value))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description">
            <Input
              value={draft.description ?? ""}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Notes">
            <textarea
              rows={3}
              value={draft.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2"
            />
          </Field>
        </div>
        <Field label="Examples" hint="One per line">
          <textarea
            rows={4}
            value={examples}
            onChange={(e) => setExamples(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
          />
        </Field>
        <Field
          label="Validations"
          hint="One per line, e.g. required() or cv(&quot;lithology&quot;)"
        >
          <textarea
            rows={4}
            value={validations}
            onChange={(e) => setValidations(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
          />
        </Field>
      </div>
    </Modal>
  );
}
