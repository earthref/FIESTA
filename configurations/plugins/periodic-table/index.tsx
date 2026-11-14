// The periodic-table plugin's UI: a sidebar filter (legacy KdD "Periodic
// Table of Elements") whose modal lays the elements out as the periodic table,
// each with its count in the search (its other filters applied). Picked
// elements are `<column>:"<value>"` query tokens, OR'd like a facet's values;
// the backend lets the search API count the column (`search_facets`).
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type FilterChip, FilterEntry } from "@/components/search-filters";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import type { NodeConfig, SearchPage } from "@/lib/types";
import { abbreviateNumber, buildQuery, cx, parseQueryTokens, queryWithout } from "@/lib/utils";
import type { PluginFilterContext, PluginModule } from "@/plugins";
import { ELEMENT_ROWS } from "./elements";

interface Element {
  number: number;
  symbol: string;
  name: string;
  column: number;
  row: number;
  category: string;
}

interface Options {
  column: string;
  levels: string[];
  label: string;
}

const ELEMENTS: Element[] = ELEMENT_ROWS.map(([number, symbol, name, column, row, category]) => ({
  number,
  symbol,
  name,
  column,
  row,
  category,
}));
const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));
const BY_LOWER = new Map(
  ELEMENTS.flatMap((e) => [
    [e.name.toLowerCase(), e],
    [e.symbol.toLowerCase(), e],
  ]),
);

/** A column value's element: its symbol ("Na"), else its name or symbol in
 * any case ("Sodium", "NA"); the column may hold either. */
function elementOf(value: string): Element | undefined {
  const text = value.trim();
  return BY_SYMBOL.get(text) ?? BY_LOWER.get(text.toLowerCase());
}

/** Values a facet modal lists; a few hundred at most here. */
const FACET_SIZE = 2000;

function optionsOf(config: NodeConfig): Options {
  const raw = (config.plugins["periodic-table"] ?? {}) as Record<string, unknown>;
  return {
    column: typeof raw.column === "string" ? raw.column : "element",
    levels: Array.isArray(raw.levels) ? raw.levels.map(String) : [],
    label: typeof raw.label === "string" ? raw.label : "Periodic Table",
  };
}

/** The column's values counted for the search without its own picks, so
 * each element's count is what picking it adds; keyed by element number,
 * with the column values that are each element. */
function useElementCounts(ctx: PluginFilterContext, column: string, enabled: boolean) {
  const params = ctx.paramsFor(queryWithout(ctx.q, [column]));
  const buckets = useQuery({
    queryKey: ["periodic-table", ctx.table, column, params],
    queryFn: () =>
      api<SearchPage>(`/search/${ctx.table}`, {
        params: { ...params, size: 1, facet: [column], facet_size: FACET_SIZE, totals: true },
      }),
    enabled,
    staleTime: 60_000,
  });
  const counts = useMemo(() => {
    const out = new Map<number, { count: number; values: string[] }>();
    for (const bucket of buckets.data?.aggregations?.[column] ?? []) {
      const element = elementOf(bucket.key);
      const count = (ctx.count?.(bucket) ?? bucket.doc_count) || 0;
      if (!element || count <= 0) continue;
      const entry = out.get(element.number) ?? { count: 0, values: [] };
      entry.count += count;
      entry.values.push(bucket.key);
      out.set(element.number, entry);
    }
    return out;
  }, [buckets.data, column, ctx.count]);
  return { counts, loading: enabled && buckets.isPending, error: buckets.isError };
}

function PeriodicTableFilter({ ctx, options }: { ctx: PluginFilterContext; options: Options }) {
  const { column, label } = options;
  const [open, setOpen] = useState(false);
  const picked = parseQueryTokens(ctx.q)
    .tokens.filter(([field]) => field === column)
    .map(([, value]) => value);
  // The chips show counts too (legacy), so count while anything is picked.
  const { counts, loading, error } = useElementCounts(ctx, column, open || picked.length > 0);

  const chips: FilterChip[] = picked.map((value) => {
    const element = elementOf(value);
    const n = element ? counts.get(element.number)?.count : undefined;
    return {
      key: value,
      label: (
        <>
          {element ? element.name : value}
          {n !== undefined && <span className="ml-1 font-normal">{abbreviateNumber(n)}</span>}
        </>
      ),
      title: element ? `${element.name} (${element.symbol})` : value,
      onRemove: () => {
        const { tokens, freeText } = parseQueryTokens(ctx.q);
        ctx.setQuery(
          buildQuery(
            freeText,
            tokens.filter(([field, v]) => field !== column || v !== value),
          ),
        );
      },
    };
  });

  return (
    <>
      <FilterEntry label={label} chips={chips} onOpen={() => setOpen(true)} />
      {open && (
        <PeriodicTableModal
          title={label}
          column={column}
          ctx={ctx}
          picked={picked}
          counts={counts}
          loading={loading}
          error={error}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PeriodicTableModal({
  title,
  column,
  ctx,
  picked,
  counts,
  loading,
  error,
  onClose,
}: {
  title: string;
  column: string;
  ctx: PluginFilterContext;
  picked: string[];
  counts: Map<number, { count: number; values: string[] }>;
  loading: boolean;
  error: boolean;
  onClose: () => void;
}) {
  // The draft: picked elements by number; a picked value that is no element
  // (a typo, "REE") stays in the query untouched.
  const initial = new Set(picked.map(elementOf).flatMap((e) => (e ? [e.number] : [])));
  const [draft, setDraft] = useState<Set<number>>(() => new Set(initial));
  const changed = draft.size !== initial.size || [...draft].some((n) => !initial.has(n));

  const toggle = (element: Element) => {
    const next = new Set(draft);
    if (next.has(element.number)) next.delete(element.number);
    else next.add(element.number);
    setDraft(next);
  };
  const apply = () => {
    const { tokens, freeText } = parseQueryTokens(queryWithout(ctx.q, [column]));
    const others = picked.filter((value) => !elementOf(value));
    const values = [
      ...others,
      ...ELEMENTS.filter((e) => draft.has(e.number)).flatMap((e) => {
        // The column's own spelling of the element (symbol or name); else
        // the one already in the query; else its symbol.
        const found = counts.get(e.number)?.values;
        if (found?.length) return found;
        const kept = picked.filter((value) => elementOf(value)?.number === e.number);
        return kept.length > 0 ? kept : [e.symbol];
      }),
    ];
    for (const value of new Set(values)) tokens.push([column, value]);
    ctx.setQuery(buildQuery(freeText, tokens));
    onClose();
  };

  return (
    <Modal
      open
      xl
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => setDraft(new Set())}
            disabled={draft.size === 0}
          >
            Clear
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!changed}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex min-h-[50vh] flex-col gap-3 text-[13px] text-ink">
        <p className="text-ink-muted">
          Pick elements to show the records with any of them; each count is the records in the
          search with that element.
          {draft.size > 0 && (
            <span className="ml-1 font-bold text-node-ink">{draft.size} picked.</span>
          )}
        </p>
        {error ? (
          <p className="text-red-700">The element counts could not be loaded.</p>
        ) : loading ? (
          <div className="flex grow items-center justify-center">
            <Spinner className="h-6 w-6" label="Counting elements…" />
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <div
              className="grid min-w-[44rem] gap-1"
              style={{
                gridTemplateColumns: "repeat(18, minmax(0, 1fr))",
                gridTemplateRows: "repeat(10, auto)",
              }}
            >
              {ELEMENTS.map((element) => {
                const count = counts.get(element.number)?.count ?? 0;
                const selected = draft.has(element.number);
                // A picked element stays clickable at zero, to unpick it.
                const disabled = count === 0 && !selected;
                return (
                  <button
                    key={element.number}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => toggle(element)}
                    title={`${element.name} (${element.number}, ${element.category}): ${count} ${count === 1 ? "record" : "records"}`}
                    className={cx(
                      "flex flex-col items-center justify-between overflow-hidden rounded-sm border pt-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                      selected
                        ? "cursor-pointer border-node bg-node text-white"
                        : disabled
                          ? "cursor-default border-line bg-panel text-ink-faint opacity-50"
                          : "cursor-pointer border-line bg-panel text-ink hover:border-node hover:text-node-ink",
                    )}
                    // The legacy table's cell: lanthanides and actinides on rows 9-10.
                    style={{ gridColumn: element.column, gridRow: element.row, height: "4.25rem" }}
                  >
                    <span className="text-[15px] font-bold leading-none">{element.symbol}</span>
                    <span
                      className={cx(
                        "w-full border-t text-center text-[13px] leading-[1.6]",
                        selected ? "border-white/40 bg-node-dark" : "border-line bg-surface",
                      )}
                    >
                      {abbreviateNumber(count)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

const plugin: PluginModule = {
  sidebarFilters: (levelName, _subTabName, config) => {
    const options = optionsOf(config);
    if (options.levels.length > 0 && !options.levels.includes(levelName)) return [];
    return [
      {
        key: "periodic-table",
        fields: [options.column],
        render: (ctx) => <PeriodicTableFilter ctx={ctx} options={options} />,
      },
    ];
  },
};

export default plugin;
