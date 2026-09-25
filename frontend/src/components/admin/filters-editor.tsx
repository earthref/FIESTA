// Editor for the node's search sidebar filters (search.filters in the YAML).
// A filter is a facet (aggregate a data-model column), a range (a numeric
// summary.* path a plugin indexes) or a bounding box. Saving writes the whole
// list and clears the legacy search.facets key. Column suggestions come from the
// node's latest data model.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import {
  adminKeys,
  type NodeSettings,
  patchSettings,
  readFile,
  type SettingsFilter,
  type SettingsOp,
  settingsFilters,
} from "../../lib/admin";
import { ApiError } from "../../lib/api";
import { ErrorMessage } from "../error-message";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Spinner } from "../ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../ui/table";
import { Field } from "./admin-ui";

const TYPES: SettingsFilter["type"][] = ["facet", "range", "bbox"];
const VIEWS = ["Summaries", "Rows"];

// Stable keys so the list survives reordering without index-based keys.
let counter = 0;
const nextId = () => `filter-${counter++}`;
interface Row {
  id: string;
  filter: SettingsFilter;
}

interface DataColumn {
  label?: string;
  type?: string;
}
interface DataModelFile {
  tables: Record<string, { columns: Record<string, DataColumn> }>;
}

export function FiltersEditor({
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
  const initial = useMemo(() => settingsFilters(settings.search), [settings.search]);
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((filter) => ({ id: nextId(), filter })),
  );
  const [editing, setEditing] = useState<{ id: string | null; filter: SettingsFilter } | null>(
    null,
  );

  useEffect(() => {
    setRows(initial.map((filter) => ({ id: nextId(), filter })));
  }, [initial]);

  // The latest data model, for facet/range field suggestions.
  const dmPath = `${settings.data_model.dir}/${settings.data_model.latest}.json`;
  const model = useQuery({
    queryKey: [...adminKeys.node(slug), "file", dmPath],
    queryFn: async () => {
      try {
        return JSON.parse((await readFile(slug, dmPath)).content) as DataModelFile;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });

  // column name -> tables it appears in; and the numeric summary.* paths.
  const { facetColumns, rangeFields } = useMemo(() => {
    const columns = new Map<string, Set<string>>();
    const ranges: string[] = [];
    for (const [table, t] of Object.entries(model.data?.tables ?? {})) {
      for (const [column, col] of Object.entries(t.columns)) {
        let tables = columns.get(column);
        if (!tables) {
          tables = new Set();
          columns.set(column, tables);
        }
        tables.add(table);
        if (col.type === "Number") ranges.push(`summary.${table}.${column}`);
      }
    }
    return { facetColumns: columns, rangeFields: [...new Set(ranges)].sort() };
  }, [model.data]);

  const levelNames = settings.search.levels.map((l) => l.name);

  const save = useMutation({
    mutationFn: () => {
      const ops: SettingsOp[] = [{ path: ["search", "filters"], value: rows.map((r) => r.filter) }];
      // Drop the pre-2026-09 facets key it replaces.
      if (settings.search.facets !== undefined)
        ops.push({ path: ["search", "facets"], value: null });
      return patchSettings(slug, ops, settingsLock);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) }),
  });

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
  };

  const apply = (id: string | null, filter: SettingsFilter) => {
    setRows(
      id === null
        ? [...rows, { id: nextId(), filter }]
        : rows.map((r) => (r.id === id ? { ...r, filter } : r)),
    );
    setEditing(null);
  };

  const dirty =
    JSON.stringify(rows.map((r) => r.filter)) !== JSON.stringify(initial) ||
    settings.search.facets !== undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-600">Filters appear in the search sidebar, in list order.</span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge variant="warning">unsaved changes</Badge>}
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty}
            onClick={() => setRows(initial.map((filter) => ({ id: nextId(), filter })))}
          >
            Reset
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save to Draft
          </Button>
        </span>
      </div>
      {save.error && <ErrorMessage error={save.error} />}
      {model.isLoading && <Spinner label="Loading data model…" />}

      <Table>
        <THead>
          <tr>
            <Th>Type</Th>
            <Th>Field / Label</Th>
            <Th>Levels</Th>
            <Th>Views</Th>
            <Th />
          </tr>
        </THead>
        <TBody>
          {rows.map((row, index) => (
            <Tr key={row.id}>
              <Td>
                <Badge variant="node">{row.filter.type}</Badge>
              </Td>
              <Td>
                <span className="font-mono text-xs">{row.filter.field ?? "—"}</span>
                {row.filter.label && <span className="ml-1 text-gray-600">{row.filter.label}</span>}
              </Td>
              <Td className="text-xs text-gray-600">
                {(row.filter.levels ?? []).join(", ") || "all"}
              </Td>
              <Td className="text-xs text-gray-600">
                {(row.filter.views ?? []).join(", ") || "all"}
              </Td>
              <Td className="whitespace-nowrap">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>{" "}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Move down"
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>{" "}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing({ id: row.id, filter: row.filter })}
                >
                  Edit
                </Button>{" "}
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setRows(rows.filter((r) => r.id !== row.id))}
                >
                  Delete
                </Button>
              </Td>
            </Tr>
          ))}
          {rows.length === 0 && (
            <Tr>
              <Td className="text-gray-500">No filters yet.</Td>
            </Tr>
          )}
        </TBody>
      </Table>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setEditing({ id: null, filter: { type: "facet" } })}
      >
        + Add Filter
      </Button>

      {editing && (
        <FilterModal
          id={editing.id}
          filter={editing.filter}
          facetColumns={facetColumns}
          rangeFields={rangeFields}
          levelNames={levelNames}
          onClose={() => setEditing(null)}
          onApply={apply}
        />
      )}
    </div>
  );
}

/** The edit form for one filter, one <Modal>. Numbers are strings while typing. */
function FilterModal({
  id,
  filter,
  facetColumns,
  rangeFields,
  levelNames,
  onClose,
  onApply,
}: {
  id: string | null;
  filter: SettingsFilter;
  facetColumns: Map<string, Set<string>>;
  rangeFields: string[];
  levelNames: string[];
  onClose: () => void;
  onApply: (id: string | null, filter: SettingsFilter) => void;
}) {
  const [type, setType] = useState<SettingsFilter["type"]>(filter.type);
  const [field, setField] = useState(filter.field ?? "");
  const [label, setLabel] = useState(filter.label ?? "");
  const [levels, setLevels] = useState<string[]>(filter.levels ?? []);
  const [views, setViews] = useState<string[]>(filter.views ?? []);
  const [unit, setUnit] = useState(filter.unit ?? "");
  const [scale, setScale] = useState(filter.scale != null ? String(filter.scale) : "");
  const [min, setMin] = useState(filter.min != null ? String(filter.min) : "");
  const [max, setMax] = useState(filter.max != null ? String(filter.max) : "");
  const facetListId = useId();
  const rangeListId = useId();

  const submit = () => {
    const out: SettingsFilter = { type };
    if (type !== "bbox" && field.trim()) out.field = field.trim();
    if (label.trim()) out.label = label.trim();
    if (levels.length) out.levels = levels;
    if (views.length) out.views = views;
    if (type === "range") {
      if (unit.trim()) out.unit = unit.trim();
      const s = Number(scale);
      if (scale.trim() && !Number.isNaN(s) && s !== 1) out.scale = s;
      if (min.trim() && !Number.isNaN(Number(min))) out.min = Number(min);
      if (max.trim() && !Number.isNaN(Number(max))) out.max = Number(max);
    }
    onApply(id, out);
  };

  const fieldError = type !== "bbox" && !field.trim() ? "required" : null;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={id === null ? "New Filter" : "Edit Filter"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!fieldError} onClick={submit}>
            Apply
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as SettingsFilter["type"])}
            className="w-full rounded-md border border-gray-300 px-3 py-2"
          >
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Label" hint="Shown in the sidebar; defaults to the field's label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>

        {type === "facet" && (
          <div className="sm:col-span-2">
            <Field
              label="Field"
              hint={fieldError ?? "A data-model column, aggregated on summary._all"}
            >
              <Input list={facetListId} value={field} onChange={(e) => setField(e.target.value)} />
              <datalist id={facetListId}>
                {[...facetColumns.entries()].sort().map(([name, tables]) => (
                  <option key={name} value={name} label={`in ${[...tables].sort().join(", ")}`} />
                ))}
              </datalist>
            </Field>
          </div>
        )}
        {type === "range" && (
          <div className="sm:col-span-2">
            <Field
              label="Field"
              hint={
                fieldError ??
                "A summary.* path a plugin indexes numerically; plain row values are text and will not range-filter"
              }
            >
              <Input list={rangeListId} value={field} onChange={(e) => setField(e.target.value)} />
              <datalist id={rangeListId}>
                {rangeFields.map((path) => (
                  <option key={path} value={path} />
                ))}
              </datalist>
            </Field>
          </div>
        )}

        {type === "range" && (
          <>
            <Field label="Unit">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field>
            <Field label="Scale" hint="Typed value × scale is what is queried (Ma → years: 1e6)">
              <Input type="number" value={scale} onChange={(e) => setScale(e.target.value)} />
            </Field>
            <Field label="Min">
              <Input type="number" value={min} onChange={(e) => setMin(e.target.value)} />
            </Field>
            <Field label="Max">
              <Input type="number" value={max} onChange={(e) => setMax(e.target.value)} />
            </Field>
          </>
        )}

        <div className="sm:col-span-2">
          <Field label="Levels" hint="Search levels to show it on; empty = everywhere">
            <TagInput
              values={levels}
              options={levelNames}
              placeholder="Add a level"
              onChange={setLevels}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Views" hint="Result sub-tabs to show it on; empty = everywhere">
            <TagInput values={views} options={VIEWS} placeholder="Add a view" onChange={setViews} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/** A list of chip values with a datalist-backed input that also accepts typing. */
function TagInput({
  values,
  options,
  placeholder,
  onChange,
}: {
  values: string[];
  options: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const add = () => {
    const value = draft.trim();
    if (value && !values.includes(value)) onChange([...values, value]);
    setDraft("");
  };
  return (
    <div className="space-y-1">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => (
            <Badge key={value} variant="node">
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="ml-0.5 text-node-dark hover:text-red-700"
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <Input
          list={listId}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <datalist id={listId}>
          {options
            .filter((option) => !values.includes(option))
            .map((option) => (
              <option key={option} value={option} />
            ))}
        </datalist>
        <Button size="sm" variant="secondary" onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}
