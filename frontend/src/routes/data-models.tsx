import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, Navigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ErrorMessage } from "../components/error-message";
import { Icon } from "../components/ui/icon";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { useNodeConfig } from "../lib/config";
import type { DataModel, DataModelColumn, DataModelTable } from "../lib/types";
import { cx, formatDate } from "../lib/utils";

const routeApi = getRouteApi("/data-models/$version");
const TAB_BORDER = "#d4d4d5";

/** /data-models redirects to the node's latest data model version. */
export function DataModelsIndex() {
  const { data: config } = useNodeConfig();
  if (!config) return <PageSpinner />;
  return (
    <Navigate to="/data-models/$version" params={{ version: config.data_model_latest }} replace />
  );
}

function unwrapModel(data: unknown): DataModel | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.tables && typeof record.tables === "object") return record as unknown as DataModel;
  for (const value of Object.values(record)) {
    if (value && typeof value === "object" && "tables" in (value as object)) {
      return value as DataModel;
    }
  }
  return null;
}

// --- Validation-derived status labels (data_model_column.jsx) --------------------

interface StatusBadge {
  label: string;
  background: string;
  color?: string;
}

/** ui <color> horizontal small label: font-weight normal, color rgba(0,0,0,.6), padding .4em */
function validationBadges(validations: string[] | undefined): StatusBadge[] {
  const badges = new Map<string, StatusBadge>();
  for (const validation of validations ?? []) {
    if (/^(required\(|key\()/.test(validation)) {
      badges.set("required", { label: "Required", background: "#db2828" });
    } else if (/^required/i.test(validation)) {
      badges.set("required-if", { label: "Required (?)", background: "#21ba45" });
    } else if (/^recommended/i.test(validation)) {
      badges.set("recommended", { label: "Recommended", background: "#fbbd08" });
    } else if (/^downloadOnly/i.test(validation)) {
      badges.set("download", {
        label: "Download Only",
        background: "#1b1c1d",
        color: "rgba(255,255,255,0.9)",
      });
    } else if (/^foundIn/i.test(validation)) {
      badges.set("found-in", { label: "Found In", background: "#00b5ad" });
    } else if (/^(cv\(|sv\()/.test(validation)) {
      badges.set("vocabulary", { label: "Vocabulary", background: "#f2711c" });
    } else if (/^(min\(|max\(|type\(|in\(|unique\(|matches\()/.test(validation)) {
      badges.set("validation", { label: "Validation", background: "#a333c8" });
    }
  }
  return [...badges.values()];
}

function StatusLabel({ badge }: { badge: StatusBadge }) {
  return (
    <span
      className="rounded-sm text-[11px]"
      style={{
        backgroundColor: badge.background,
        color: badge.color ?? "rgba(0,0,0,0.6)",
        fontWeight: "normal",
        padding: "0.4em",
      }}
    >
      {badge.label}
    </span>
  );
}

function typeUnitLabel(column: DataModelColumn): string {
  const type = column.type ?? "";
  if (!type) return "";
  if (/^flag$/i.test(type)) return "Flag";
  const unit = column.unit ?? "";
  if (!unit || /^(custom|dimensionless)$/i.test(unit)) return type;
  return `${type} in ${unit}`;
}

function previousColumnText(entry: { table: string; column: string } | string): string {
  return typeof entry === "string" ? entry : `${entry.table}.${entry.column}`;
}

/** Circular basic count badge. */
function CountBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-block rounded-full border border-gray-300 bg-white text-center text-[11px]"
      style={{ color: "#0C0C0C", minWidth: "3.5em", padding: "0.3em 0.5em", lineHeight: 1 }}
    >
      {children}
    </span>
  );
}

/** Accordion title-row layout: flex, children nowrap shrink-0 mr-0.5em, description grows. */
const titleChildStyle = { whiteSpace: "nowrap", flexShrink: 0, marginRight: "0.5em" } as const;

// --- Column row -------------------------------------------------------------

function ColumnRow({
  version,
  tableName,
  tablePosition,
  name,
  column,
}: {
  version: string;
  tableName: string;
  tablePosition: number;
  name: string;
  column: DataModelColumn;
}) {
  const [open, setOpen] = useState(false);
  const badges = validationBadges(column.validations);
  const typeLabel = typeUnitLabel(column);

  return (
    <li className="border-t border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center text-left text-[13px] hover:bg-gray-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{ padding: "0.5em 0" }}
      >
        <span
          aria-hidden="true"
          style={titleChildStyle}
          className={cx("text-gray-400 transition-transform", open && "rotate-90")}
        >
          <Icon name="caret-right" size="small" />
        </span>
        <span style={titleChildStyle} className="font-bold text-gray-800">
          {tablePosition}.{column.position ?? "?"} {column.label ?? name}
          <span className="font-normal text-gray-400">, {name}</span>
        </span>
        {typeLabel && (
          <span
            style={titleChildStyle}
            className="rounded-sm border border-gray-400 px-[0.4em] py-[0.2em] text-[11px] font-normal text-gray-600"
          >
            {typeLabel}
          </span>
        )}
        <span
          className={cx(
            "grow overflow-hidden text-ellipsis whitespace-nowrap font-normal text-gray-500",
            open && "invisible",
          )}
          style={{ marginRight: "0.5em" }}
        >
          {column.description}
        </span>
        <span className="flex gap-1" style={{ flexShrink: 0 }}>
          {badges.map((badge) => (
            <StatusLabel key={badge.label} badge={badge} />
          ))}
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 1.75em 0.5em" }}>
          <table className="w-full text-left text-[13px]">
            <tbody>
              {column.description && (
                <tr>
                  <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">Description</th>
                  <td className="py-1 text-gray-700">{column.description}</td>
                </tr>
              )}
              {column.notes && (
                <tr>
                  <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">Notes</th>
                  <td className="py-1 text-gray-700">{column.notes}</td>
                </tr>
              )}
              {column.type && (
                <tr>
                  <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">Type</th>
                  <td className="py-1 text-gray-700">{column.type}</td>
                </tr>
              )}
              {column.unit && (
                <tr>
                  <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">Unit</th>
                  <td className="py-1 text-gray-700">{column.unit}</td>
                </tr>
              )}
              {column.examples && column.examples.length > 0 && (
                <tr>
                  <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">Examples</th>
                  <td className="py-1 font-mono text-gray-700">{column.examples.join(", ")}</td>
                </tr>
              )}
              {column.validations && column.validations.length > 0 && (
                <tr>
                  <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">Validations</th>
                  <td className="py-1 font-mono text-gray-700">
                    {column.validations.map((validation) => (
                      <div key={validation}>{validation}</div>
                    ))}
                  </td>
                </tr>
              )}
              <tr>
                <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">
                  {version} Column
                </th>
                <td className="py-1 font-mono text-gray-700">
                  {tableName}.{name}
                </td>
              </tr>
              {column.previous_columns && column.previous_columns.length > 0 && (
                <tr>
                  <th className="w-36 py-1 pr-3 align-top font-bold text-gray-700">
                    Previous Columns
                  </th>
                  <td className="py-1 font-mono text-gray-700">
                    {column.previous_columns.map((entry) => (
                      <div key={previousColumnText(entry)}>{previousColumnText(entry)}</div>
                    ))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

// --- Group and table accordions ----------------------------------------------

type ColumnEntry = [string, DataModelColumn];

function GroupSection({
  version,
  tableName,
  tablePosition,
  group,
  columns,
  filtering,
}: {
  version: string;
  tableName: string;
  tablePosition: number;
  group: string;
  columns: ColumnEntry[];
  filtering: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || filtering;

  return (
    <div className="border-t border-gray-200">
      {/* Group title row: bg #aaaaaa (data_model.less:29-32) */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={expanded}
        className="flex w-full items-center text-left text-[13px] font-bold text-gray-900 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{
          padding: "0.5em 0.5em",
          background: "#aaaaaa",
          boxShadow: "inset 0px -5px 35px 15px white",
        }}
      >
        <span
          aria-hidden="true"
          style={titleChildStyle}
          className={cx("transition-transform", expanded && "rotate-90")}
        >
          <Icon name="caret-right" size="small" />
        </span>
        <span style={titleChildStyle}>{group} Group</span>
        <CountBadge>{columns.length}</CountBadge>
      </button>
      {expanded && (
        <ul style={{ padding: "0 1.75em 0.5em" }}>
          {columns.map(([name, column]) => (
            <ColumnRow
              key={name}
              version={version}
              tableName={tableName}
              tablePosition={tablePosition}
              name={name}
              column={column}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TableSection({
  version,
  name,
  table,
  columns,
  totalColumns,
  filtering,
}: {
  version: string;
  name: string;
  table: DataModelTable;
  columns: ColumnEntry[];
  totalColumns: number;
  filtering: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || (filtering && columns.length > 0);

  const groups = useMemo(() => {
    const map = new Map<string, ColumnEntry[]>();
    for (const entry of columns) {
      const group = entry[1].group ?? "General";
      const list = map.get(group) ?? [];
      list.push(entry);
      map.set(group, list);
    }
    return [...map.entries()].sort(
      ([, a], [, b]) => (a[0]?.[1].position ?? 0) - (b[0]?.[1].position ?? 0),
    );
  }, [columns]);

  return (
    <div className="border-t border-gray-200 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={expanded}
        className="flex w-full items-center px-3 text-left hover:bg-gray-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{ padding: "0.5em 0.75em" }}
      >
        <span
          aria-hidden="true"
          style={titleChildStyle}
          className={cx("text-gray-400 transition-transform", expanded && "rotate-90")}
        >
          <Icon name="caret-right" size="small" />
        </span>
        <span style={titleChildStyle} className="text-[14px] font-bold text-gray-900">
          {table.position ?? "?"}. {table.label ?? name}
          <span className="font-normal text-gray-400">, {name}</span>
        </span>
        <span style={titleChildStyle}>
          <CountBadge>
            {filtering ? `${columns.length} of ${totalColumns}` : totalColumns}
          </CountBadge>
        </span>
        <span className="grow overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-normal text-gray-500">
          {table.description}
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "0 1.75em 0.5em" }}>
          {groups.map(([group, groupColumns]) => (
            <GroupSection
              key={group}
              version={version}
              tableName={name}
              tablePosition={table.position ?? 0}
              group={group}
              columns={groupColumns}
              filtering={filtering}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Page --------------------------------------------------------------------

export function DataModelPage() {
  const { version } = routeApi.useParams();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const { data: config } = useNodeConfig();

  const query = useQuery({
    queryKey: ["data-model", version],
    queryFn: () => api<unknown>(`/config/data-models/${version}`),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const model = useMemo(() => unwrapModel(query.data), [query.data]);
  const filter = (search.q ?? "").trim().toLowerCase();

  const tables = useMemo(() => {
    if (!model) return [];
    return Object.entries(model.tables)
      .sort(([, a], [, b]) => (a.position ?? 0) - (b.position ?? 0))
      .map(([name, table]) => {
        const all = Object.entries(table.columns).sort(
          ([, a], [, b]) => (a.position ?? 0) - (b.position ?? 0),
        );
        const tableMatches =
          !!filter &&
          (name.toLowerCase().includes(filter) ||
            (table.label ?? "").toLowerCase().includes(filter));
        const visible = !filter
          ? all
          : tableMatches
            ? all
            : all.filter(([columnName, column]) =>
                [columnName, column.label, column.description]
                  .filter(Boolean)
                  .some((text) => String(text).toLowerCase().includes(filter)),
              );
        return { name, table, all, visible };
      });
  }, [model, filter]);

  const totalColumns = tables.reduce((sum, entry) => sum + entry.all.length, 0);
  const visibleColumns = tables.reduce((sum, entry) => sum + entry.visible.length, 0);
  const shownTables = filter ? tables.filter((entry) => entry.visible.length > 0) : tables;

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(query.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${config?.slug ?? "fiesta"}-data-model-${version}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // Version tabs newest-first
  const versions = [...(config?.data_model_versions ?? [version])].reverse();

  return (
    <div className="data-model">
      {/* Version tab bar: Semantic tabular menu (bottom border only) */}
      <div className="flex flex-wrap items-end" style={{ borderBottom: `1px solid ${TAB_BORDER}` }}>
        <span
          className="text-[13px] font-bold text-gray-400"
          style={{ padding: "0.92857143em 1.42857143em", marginBottom: -1 }}
        >
          Version:
        </span>
        {versions.map((entry) => {
          const active = entry === version;
          return (
            <Link
              key={entry}
              to="/data-models/$version"
              params={{ version: entry }}
              search={{ q: search.q }}
              className={cx(
                "flex items-center text-[13px]",
                !active && "hover:bg-[rgba(0,0,0,0.03)]",
              )}
              style={{
                padding: "0.92857143em 1.42857143em",
                color: "rgba(0,0,0,.87)",
                fontWeight: active ? 700 : 400,
                background: active ? "#fff" : "transparent",
                border: `1px solid ${active ? TAB_BORDER : "transparent"}`,
                borderBottomColor: active ? "#fff" : "transparent",
                borderTopLeftRadius: 4,
                borderTopRightRadius: 4,
                marginBottom: -1,
              }}
            >
              {entry}
              {active && filter && (
                <span
                  className="inline-block rounded-full border border-gray-300 bg-white text-center text-[11px]"
                  style={{
                    color: "#0C0C0C",
                    margin: "-1em -0.5em -1em 0.5em",
                    minWidth: "4em",
                    padding: "0.5em",
                  }}
                >
                  {visibleColumns} of {totalColumns}
                </span>
              )}
            </Link>
          );
        })}
        {/* Right: transparent icon search input (min-width 200px) */}
        <span className="ml-auto flex items-center self-center" style={{ padding: "0 1em" }}>
          <label htmlFor="model-search" className="sr-only">
            Search the columns
          </label>
          <input
            id="model-search"
            type="search"
            placeholder="Search the columns ..."
            value={search.q ?? ""}
            onChange={(event) =>
              navigate({ search: { q: event.target.value || undefined }, replace: true })
            }
            className="border-0 bg-transparent text-sm placeholder:text-[#AAAAAA] focus:outline-hidden"
            style={{ minWidth: 200, borderRadius: 0, padding: "0.5em 0" }}
          />
          {filter ? (
            <button
              type="button"
              onClick={() => navigate({ search: { q: undefined }, replace: true })}
              aria-label="Clear column search"
              className="px-2 text-sm font-bold text-node hover:opacity-70"
            >
              <Icon name="close" size="small" />
            </button>
          ) : (
            <span aria-hidden="true" className="px-2 text-sm text-node">
              <Icon name="search" size="small" />
            </span>
          )}
        </span>
      </div>

      {/* Bottom attached segment (joined under the tab row, min-height 200px) */}
      <div
        className="bg-white"
        style={{
          border: `1px solid ${TAB_BORDER}`,
          borderTop: "none",
          minHeight: 200,
          padding: "1em",
          borderBottomLeftRadius: "0.28571429rem",
          borderBottomRightRadius: "0.28571429rem",
        }}
      >
        {query.isPending && <PageSpinner label="Loading data model…" />}
        {query.error && <ErrorMessage error={query.error} />}
        {!query.isPending && !query.error && !model && (
          <ErrorMessage error={new Error("Unrecognized data model format")} />
        )}

        {model && (
          <>
            {/* Header grid: 6/4/6 columns */}
            <div className="flex flex-wrap items-center text-[13px] text-gray-600">
              <span className="w-full sm:w-[37.5%]">Click on a table/group/column name:</span>
              <span className="w-full sm:w-[25%]">
                {model.updated_day && <>Updated on {formatDate(model.updated_day)}.</>}
              </span>
              <span className="w-full text-right sm:w-[37.5%]">
                <button
                  type="button"
                  onClick={downloadJson}
                  className="inline-flex items-center gap-1 text-node hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
                >
                  <Icon name="download" size="small" /> Download as .json
                </button>
              </span>
            </div>

            {/* ui styled fluid accordion: bordered rounded box, mt 1em, no shadow */}
            <div
              className="bg-white"
              style={{
                border: `1px solid ${TAB_BORDER}`,
                borderRadius: "0.28571429rem",
                marginTop: "1em",
                boxShadow: "none",
              }}
            >
              {shownTables.map(({ name, table, all, visible }) => (
                <TableSection
                  key={name}
                  version={version}
                  name={name}
                  table={table}
                  columns={visible}
                  totalColumns={all.length}
                  filtering={!!filter}
                />
              ))}
              {shownTables.length === 0 && (
                <p className="px-4 py-6 text-center text-[13px] font-medium text-[#9F3A38]">
                  No columns match your search.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
