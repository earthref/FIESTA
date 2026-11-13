// Editor for each search level's Summaries grid (search.levels[].columns in the
// YAML): which tiles are its columns, in order, and each column's header,
// width, sort and filter. A level without columns shows the default tiles.
// Saving writes that level's list (or removes it, back to the defaults).
// Column suggestions come from the node's latest data model.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import {
  adminKeys,
  type NodeSettings,
  type PluginInfo,
  patchSettings,
  readFile,
  type SettingsColumn,
  type SettingsLine,
} from "../../lib/admin";
import { ApiError } from "../../lib/api";
import type { GridCellKind, GridShow } from "../../lib/types";
import { cx } from "../../lib/utils";
import { ErrorMessage } from "../error-message";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Spinner } from "../ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../ui/table";
import { Field } from "./admin-ui";
import { TagInput } from "./filters-editor";

type Tile = { cell: GridCellKind; label: string; hint: string };

/** The core's tiles (fiesta.search.grid); the node's plugins add theirs. */
const CORE_TILES: Tile[] = [
  { cell: "field", label: "Data column", hint: "One column of the level's rows: Label: value" },
  {
    cell: "fields",
    label: "Data columns",
    hint: "Several columns under one header, a Label: value line each (blank ones left out)",
  },
  { cell: "title", label: "Title", hint: "A column in bold over an optional subtitle column" },
  {
    cell: "record",
    label: "Record",
    hint: "Citation, then title (or the record's name), then date and contributor; filters on all",
  },
  { cell: "citation", label: "Citation", hint: "The contribution's citation and version" },
  { cell: "name", label: "Name", hint: "Reference title, or the record's name breadcrumb" },
  { cell: "contributed", label: "Contributed", hint: "Date contributed and contributor" },
  { cell: "download", label: "Download", hint: "The contribution's download button" },
  { cell: "links", label: "Links", hint: "Contribution link, data DOI, publication DOI" },
  { cell: "counts", label: "Counts", hint: "Records per level, each opening its modal tab" },
  { cell: "map", label: "Map", hint: "Map thumbnail of the record's positions" },
  { cell: "plot", label: "Plot", hint: "A plugin's plot thumbnail (age spectrum, …)" },
  { cell: "geo", label: "Geography", hint: "The node's geography columns (search.geography)" },
  { cell: "citations", label: "Citations", hint: "Additional citations" },
];

// The default tiles (fiesta.search.grid.DEFAULT_CELLS, the active plugins'
// default tiles, DEFAULT_TAIL_CELLS): what a level without columns shows;
// download and links only on contributions.
const DEFAULT_CELLS: GridCellKind[] = [
  "record",
  "download",
  "links",
  "counts",
  "map",
  "plot",
  "geo",
];
const DEFAULT_TAIL_CELLS: GridCellKind[] = ["citations"];

/** The tiles this node's columns can show, and its default ones. */
function nodeTiles(settings: NodeSettings, plugins: PluginInfo[]) {
  const enabled = plugins.filter((p) => settings.features?.plugins?.includes(p.name));
  const pluginTiles = enabled.flatMap((p) => p.grid_tiles ?? []);
  const tiles: Tile[] = [...CORE_TILES, ...pluginTiles];
  const defaults = [
    ...DEFAULT_CELLS,
    ...pluginTiles.filter((t) => t.default).map((t) => t.cell),
    ...DEFAULT_TAIL_CELLS,
  ];
  const label = (cell: string) => tiles.find((t) => t.cell === cell)?.label ?? cell;
  const defaultColumns = (table: string): SettingsColumn[] =>
    defaults
      .filter((cell) => table === "contribution" || (cell !== "download" && cell !== "links"))
      .map((cell) => ({ cell }));
  return { tiles, label, defaultColumns };
}

const isData = (column: SettingsColumn) =>
  (column.cell ?? "field") === "field" || column.cell === "title";
/** A fields tile's lines, each as {column, …} (the YAML may give just a name). */
const linesOf = (column: SettingsColumn): SettingsLine[] =>
  (column.columns ?? []).map((line) => (typeof line === "string" ? { column: line } : line));
/** The data-model columns a column shows. */
const namesOf = (column: SettingsColumn): string[] =>
  column.cell === "fields"
    ? linesOf(column).map((line) => line.column)
    : isData(column)
      ? [column.column, column.subtitle_column].filter((n): n is string => !!n)
      : [];
/** The column's name in sort/filter requests (GridColumn.key). */
const keyOf = (column: SettingsColumn) =>
  column.cell === "fields"
    ? namesOf(column).join("-")
    : isData(column)
      ? (column.column ?? "")
      : (column.cell ?? "field");

const SHOW_LABELS: Record<GridShow, string> = {
  value: "the record's value",
  values: "every value",
  range: "range of numbers",
};

let counter = 0;
const nextId = () => `column-${counter++}`;
interface Row {
  id: string;
  column: SettingsColumn;
}
const toRows = (columns: SettingsColumn[]) => columns.map((column) => ({ id: nextId(), column }));

interface DataModelFile {
  tables: Record<string, { columns: Record<string, { label?: string; type?: string }> }>;
}

export function GridEditor({
  slug,
  settings,
  settingsLock,
  plugins,
}: {
  slug: string;
  settings: NodeSettings;
  /** lockOf() the settings the parent loaded (for edits to the node YAML). */
  settingsLock: number | null;
  /** Every plugin in the code: the ones the node switches on add their tiles. */
  plugins: PluginInfo[];
}) {
  const queryClient = useQueryClient();
  const { tiles, label: tileLabel, defaultColumns } = nodeTiles(settings, plugins);
  const levels = settings.search.levels;
  const [levelIndex, setLevelIndex] = useState(0);
  const level = levels[Math.min(levelIndex, levels.length - 1)];
  const initial = level?.columns ?? null;
  // null: the level shows the default tiles.
  const [rows, setRows] = useState<Row[] | null>(() => (initial ? toRows(initial) : null));
  const [editing, setEditing] = useState<{ id: string | null; column: SettingsColumn } | null>(
    null,
  );

  useEffect(() => {
    setRows(initial ? toRows(initial) : null);
  }, [initial]);

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
  const tableColumns = useMemo(
    () => model.data?.tables[level?.table ?? ""]?.columns ?? {},
    [model.data, level?.table],
  );
  // Every table's columns: a contribution's values / range span them all.
  const allColumns = useMemo(
    () => ({
      ...Object.assign({}, ...Object.values(model.data?.tables ?? {}).map((t) => t.columns)),
      ...tableColumns,
    }),
    [model.data, tableColumns],
  ) as Record<string, { label?: string; type?: string }>;
  // A record's values also hold its ancestors' geography (the API checks which).
  const columnsFor = (column: SettingsColumn) =>
    column.show === "values" || (column.show === "range" && level?.table === "contribution")
      ? allColumns
      : tableColumns;

  const current = rows?.map((r) => r.column) ?? null;
  const dirty = JSON.stringify(current) !== JSON.stringify(initial);
  const keys = (current ?? []).map(keyOf);
  const duplicates = [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))];
  const unknown = (current ?? []).flatMap((c) =>
    namesOf(c).filter((name) => model.data != null && !(name in columnsFor(c))),
  );

  const save = useMutation({
    mutationFn: () =>
      patchSettings(
        slug,
        [{ path: ["search", "levels", levelIndex, "columns"], value: current }],
        settingsLock,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) }),
  });

  if (!level) return <p className="text-sm text-gray-500">The node has no search levels.</p>;

  const chooseLevel = (index: number) => {
    if (dirty && !window.confirm("Discard the unsaved changes to this level's grid?")) return;
    setLevelIndex(index);
    const next = levels[index]?.columns;
    setRows(next ? toRows(next) : null);
  };

  const move = (index: number, delta: number) => {
    if (!rows) return;
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
  };

  const apply = (id: string | null, column: SettingsColumn) => {
    const base = rows ?? [];
    setRows(
      id === null
        ? [...base, { id: nextId(), column }]
        : base.map((r) => (r.id === id ? { ...r, column } : r)),
    );
    setEditing(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Each search level's Summaries tab is a grid: one row per record, one column per tile, in
        list order. Sortable columns sort on a header click; filterable ones get a filter icon whose
        menu lists the column's facets (as the sidebar does), or a text box when it has none.
      </p>
      <div className="flex flex-wrap items-center gap-1 text-sm">
        {levels.map((entry, index) => (
          <button
            key={entry.table}
            type="button"
            onClick={() => chooseLevel(index)}
            className={cx(
              "rounded-md border px-2.5 py-1",
              index === levelIndex
                ? "border-node bg-node-soft font-semibold text-node-ink-strong"
                : "border-gray-300 hover:bg-gray-50",
            )}
          >
            {entry.name}
            {entry.columns ? "" : " (default)"}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge variant="warning">unsaved changes</Badge>}
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty}
            onClick={() => setRows(initial ? toRows(initial) : null)}
          >
            Reset
          </Button>
          <Button
            disabled={!dirty || save.isPending || duplicates.length > 0 || unknown.length > 0}
            onClick={() => save.mutate()}
          >
            Save to Draft
          </Button>
        </span>
      </div>
      {save.error && <ErrorMessage error={save.error} />}
      {model.isLoading && <Spinner label="Loading data model…" />}
      {duplicates.length > 0 && (
        <p className="text-sm text-red-700">
          Columns must be unique; repeated: {duplicates.join(", ")}
        </p>
      )}
      {unknown.length > 0 && (
        <p className="text-sm text-red-700">
          The {level.table} table has no columns {unknown.join(", ")}
        </p>
      )}

      {rows === null ? (
        <div className="rounded-md border border-gray-200 p-3 text-sm">
          <p className="text-gray-700">
            {level.name} shows the default tiles:{" "}
            {defaultColumns(level.table)
              .map((c) => tileLabel(c.cell ?? "field"))
              .join(", ")}
            .
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setRows(toRows(defaultColumns(level.table)))}
          >
            Customize Columns
          </Button>
        </div>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Tile</Th>
                <Th>Column</Th>
                <Th>Header</Th>
                <Th>Width</Th>
                <Th>Sort</Th>
                <Th>Filter</Th>
                <Th />
              </tr>
            </THead>
            <TBody>
              {rows.map((row, index) => {
                const c = row.column;
                return (
                  <Tr key={row.id}>
                    <Td>
                      <Badge variant="node">{tileLabel(c.cell ?? "field")}</Badge>
                    </Td>
                    <Td className="font-mono text-xs">
                      {c.cell === "fields" ? namesOf(c).join(", ") : (c.column ?? "—")}
                      {c.subtitle_column && ` / ${c.subtitle_column}`}
                      {c.show && (
                        <span className="block font-sans text-gray-500">{SHOW_LABELS[c.show]}</span>
                      )}
                    </Td>
                    <Td>
                      {c.label ?? (c.column ? tableColumns[c.column]?.label : undefined) ?? (
                        <span className="text-gray-400">default</span>
                      )}
                    </Td>
                    <Td className="text-xs">
                      {c.width ?? <span className="text-gray-400">default</span>}
                    </Td>
                    <Td className="text-xs text-gray-600">
                      {c.sortable === false
                        ? "off"
                        : (c.sort_field ?? "default") +
                          (c.numeric === undefined ? "" : c.numeric ? " (number)" : " (text)")}
                    </Td>
                    <Td className="text-xs text-gray-600">
                      {c.filterable === false
                        ? "off"
                        : [
                            c.facets === undefined
                              ? null
                              : `facets: ${c.facets.join(", ") || "none"}`,
                            c.filter_fields?.join(", "),
                          ]
                            .filter(Boolean)
                            .join("; ") || "default"}
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
                        onClick={() => setEditing({ id: row.id, column: c })}
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
                );
              })}
              {rows.length === 0 && (
                <Tr>
                  <Td className="text-gray-500">No columns: the grid would be empty.</Td>
                </Tr>
              )}
            </TBody>
          </Table>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing({ id: null, column: { cell: "field" } })}
            >
              + Add Column
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRows(null)}>
              Use the Default Tiles
            </Button>
          </div>
        </>
      )}

      {editing && (
        <ColumnModal
          id={editing.id}
          column={editing.column}
          tiles={tiles}
          tableColumns={tableColumns}
          columnsFor={columnsFor}
          onClose={() => setEditing(null)}
          onApply={apply}
        />
      )}
    </div>
  );
}

/** The edit form for one column, one <Modal>. Numbers are strings while typing. */
function ColumnModal({
  id,
  column,
  tiles,
  tableColumns,
  columnsFor,
  onClose,
  onApply,
}: {
  id: string | null;
  column: SettingsColumn;
  tiles: Tile[];
  tableColumns: Record<string, { label?: string; type?: string }>;
  /** The columns a column with this `show` may name. */
  columnsFor: (column: SettingsColumn) => Record<string, { label?: string; type?: string }>;
  onClose: () => void;
  onApply: (id: string | null, column: SettingsColumn) => void;
}) {
  const [cell, setCell] = useState<GridCellKind>(column.cell ?? "field");
  const [name, setName] = useState(column.column ?? "");
  const [show, setShow] = useState<GridShow | "">(column.show ?? "");
  // A fields tile's lines, numbers as strings while typing.
  const [lines, setLines] = useState(() =>
    linesOf(column).map((line) => ({
      key: nextId(),
      column: line.column,
      label: line.label ?? "",
      unit: line.unit ?? "",
      scale: line.scale != null ? String(line.scale) : "",
    })),
  );
  const editLine = (key: string, patch: Partial<(typeof lines)[number]>) =>
    setLines(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const [subtitle, setSubtitle] = useState(column.subtitle_column ?? "");
  const [label, setLabel] = useState(column.label ?? "");
  const [width, setWidth] = useState(column.width != null ? String(column.width) : "");
  const [bytes, setBytes] = useState(column.format === "bytes");
  const [sortable, setSortable] = useState(column.sortable !== false);
  const [sortField, setSortField] = useState(column.sort_field ?? "");
  const [numeric, setNumeric] = useState(
    column.numeric === undefined ? "" : column.numeric ? "number" : "text",
  );
  const [filterable, setFilterable] = useState(column.filterable !== false);
  const [filterFields, setFilterFields] = useState<string[]>(column.filter_fields ?? []);
  // undefined = the tile's default facets; [] = none (a text box instead).
  const [facets, setFacets] = useState<string[] | undefined>(column.facets);
  const columnListId = useId();
  const data = cell === "field" || cell === "title";
  const shows = cell === "field" || cell === "fields";
  const pickable = shows ? columnsFor({ show: show || undefined }) : tableColumns;
  const filled = lines.filter((line) => line.column.trim());

  const submit = () => {
    const out: SettingsColumn = cell === "field" ? {} : { cell };
    if (data) out.column = name.trim();
    if (cell === "fields")
      out.columns = filled.map((line) => {
        const entry: SettingsLine = { column: line.column.trim() };
        if (line.label.trim()) entry.label = line.label.trim();
        if (line.unit.trim()) entry.unit = line.unit.trim();
        if (line.scale.trim()) entry.scale = Number(line.scale);
        // Just the name when nothing else is set, as the YAML writes it.
        return Object.keys(entry).length === 1 ? entry.column : entry;
      });
    if (shows && show) out.show = show;
    if (cell === "title" && subtitle.trim()) out.subtitle_column = subtitle.trim();
    if (label.trim()) out.label = label.trim();
    const w = Number(width);
    if (width.trim() && Number.isInteger(w) && w >= 40) out.width = w;
    if (cell === "field" && bytes) out.format = "bytes";
    if (!sortable) out.sortable = false;
    else {
      if (sortField.trim()) out.sort_field = sortField.trim();
      if (numeric) out.numeric = numeric === "number";
    }
    if (!filterable) out.filterable = false;
    else {
      if (filterFields.length) out.filter_fields = filterFields;
      if (facets !== undefined) out.facets = facets;
    }
    onApply(id, out);
  };

  const widthNumber = Number(width);
  const errors = [
    data && !name.trim() ? "Pick the column it shows." : null,
    cell === "fields" && filled.length === 0 ? "Add the columns it shows." : null,
    cell === "fields" && filled.length > 5 ? "A tile shows at most 5 lines." : null,
    filled.some((line) => line.scale.trim() && !(Number(line.scale) > 0))
      ? "A scale is a positive number (mT: 0.001)."
      : null,
    width.trim() && !(Number.isInteger(widthNumber) && widthNumber >= 40)
      ? "Width is a whole number of pixels, at least 40."
      : null,
    [sortField, ...filterFields].some((p) => p.trim() && !p.trim().startsWith("summary."))
      ? "Sort and filter fields are summary.* paths."
      : null,
    (facets ?? []).some((f) => !/^\w+$/.test(f))
      ? "Facets are column names (lithologies), not paths."
      : null,
  ].filter(Boolean);

  const columnOptions = (
    <datalist id={columnListId}>
      {Object.entries(pickable)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, def]) => (
          <option key={key} value={key} label={def.label} />
        ))}
    </datalist>
  );

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={id === null ? "New Column" : "Edit Column"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={errors.length > 0} onClick={submit}>
            Apply
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Tile" hint={tiles.find((t) => t.cell === cell)?.hint}>
          <select
            value={cell}
            onChange={(e) => setCell(e.target.value as GridCellKind)}
            className="w-full rounded-md border border-gray-300 px-3 py-2"
          >
            {tiles.map((t) => (
              <option key={t.cell} value={t.cell}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Header" hint="Blank: the tile's name, or the column's data-model label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {data && (
          <Field label="Column" hint="A column of this level's table">
            <Input list={columnListId} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        {cell === "title" && (
          <Field label="Subtitle column" hint="Optional, shown under the title">
            <Input
              list={columnListId}
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
            />
          </Field>
        )}
        {shows && (
          <Field
            label="Show"
            hint="Of each column, per record; a range reads numbers in a unit conversion's base unit"
          >
            <select
              value={show}
              onChange={(e) => setShow(e.target.value as GridShow | "")}
              className="w-full rounded-md border border-gray-300 px-3 py-2"
            >
              <option value="">The record's value (its first row's)</option>
              <option value="values">
                Every value (on Contributions: the whole contribution's)
              </option>
              <option value="range">Range of numbers (least – greatest)</option>
            </select>
          </Field>
        )}
        {cell === "fields" && (
          <fieldset className="rounded-md border border-gray-200 p-3 sm:col-span-2">
            <legend className="px-1 text-xs font-semibold text-gray-700">Lines</legend>
            <p className="mb-2 text-xs text-gray-500">
              One "Label: value" line per column, in order; blank labels take the data-model label,
              blank units the data model's. A scale divides numbers (0.001 with unit mT shows tesla
              as millitesla).
            </p>
            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={line.key} className="grid grid-cols-[2fr_2fr_1fr_1fr_auto] gap-2">
                  <Input
                    list={columnListId}
                    aria-label="Column"
                    placeholder="dir_dec"
                    value={line.column}
                    onChange={(e) => editLine(line.key, { column: e.target.value })}
                  />
                  <Input
                    aria-label="Label"
                    placeholder={pickable[line.column]?.label ?? "Label"}
                    value={line.label}
                    onChange={(e) => editLine(line.key, { label: e.target.value })}
                  />
                  <Input
                    aria-label="Unit"
                    placeholder="unit"
                    value={line.unit}
                    onChange={(e) => editLine(line.key, { unit: e.target.value })}
                  />
                  <Input
                    aria-label="Scale"
                    placeholder="scale"
                    value={line.scale}
                    onChange={(e) => editLine(line.key, { scale: e.target.value })}
                  />
                  <span className="whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...lines];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        setLines(next);
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Remove line"
                      onClick={() => setLines(lines.filter((l) => l.key !== line.key))}
                    >
                      ✕
                    </Button>
                  </span>
                </div>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              disabled={lines.length >= 5}
              onClick={() =>
                setLines([...lines, { key: nextId(), column: "", label: "", unit: "", scale: "" }])
              }
            >
              + Add Line
            </Button>
          </fieldset>
        )}
        {(data || cell === "fields") && columnOptions}
        <Field label="Width" hint="Pixels; blank = the tile's default">
          <Input type="number" min={40} value={width} onChange={(e) => setWidth(e.target.value)} />
        </Field>
        {cell === "field" && (
          <label className="flex items-center gap-2 self-end pb-2">
            <input
              type="checkbox"
              checked={bytes}
              onChange={(e) => setBytes(e.target.checked)}
              className="h-4 w-4 rounded-sm border-gray-300"
            />
            Show as a file size (bytes → KB, MB, …)
          </label>
        )}

        <fieldset className="rounded-md border border-gray-200 p-3 sm:col-span-2">
          <legend className="px-1 text-xs font-semibold text-gray-700">Sorting</legend>
          <label className="mb-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={sortable}
              onChange={(e) => setSortable(e.target.checked)}
              className="h-4 w-4 rounded-sm border-gray-300"
            />
            Sortable (tiles without a default sort, like Map, stay unsortable unless given a field)
          </label>
          {sortable && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Sort field"
                hint="Blank = the tile's default; text sorts on a .raw path"
              >
                <Input
                  value={sortField}
                  placeholder="summary.sites.site.raw"
                  onChange={(e) => setSortField(e.target.value)}
                />
              </Field>
              <Field label="Sort as" hint="Blank = the tile's default (a Number column: number)">
                <select
                  value={numeric}
                  onChange={(e) => setNumeric(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2"
                >
                  <option value="">default</option>
                  <option value="text">text</option>
                  <option value="number">number</option>
                </select>
              </Field>
            </div>
          )}
        </fieldset>

        <fieldset className="rounded-md border border-gray-200 p-3 sm:col-span-2">
          <legend className="px-1 text-xs font-semibold text-gray-700">Filtering</legend>
          <label className="mb-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={filterable}
              onChange={(e) => setFilterable(e.target.checked)}
              className="h-4 w-4 rounded-sm border-gray-300"
            />
            Filterable (a filter icon in the header)
          </label>
          {filterable && (
            <>
              <label className="mb-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={facets !== undefined}
                  onChange={(e) => setFacets(e.target.checked ? [] : undefined)}
                  className="h-4 w-4 rounded-sm border-gray-300"
                />
                Set its facets (otherwise the tile's default: a text column lists its values)
              </label>
              {facets !== undefined && (
                <Field
                  label="Facets"
                  hint="Columns listed as checkboxes with counts, as in the sidebar; none = a text box"
                >
                  <TagInput
                    values={facets}
                    options={Object.keys(tableColumns)}
                    placeholder="lithologies"
                    onChange={setFacets}
                  />
                </Field>
              )}
              <Field
                label="Filter fields"
                hint="Text paths a text box matches (as prefixes); empty = the tile's default, shown when it has no facets"
              >
                <TagInput
                  values={filterFields}
                  options={[]}
                  placeholder="summary._all.location"
                  onChange={setFilterFields}
                />
              </Field>
            </>
          )}
        </fieldset>
        {errors.length > 0 && <p className="text-red-700 sm:col-span-2">{errors.join(" ")}</p>}
      </div>
    </Modal>
  );
}
