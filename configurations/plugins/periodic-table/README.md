# `periodic-table` (KdD)

The legacy KdD "Periodic Table of Elements" filter. A sidebar entry (after the
node's own filters) opens a modal with the elements laid out as the periodic
table (18 columns × 10 rows, the lanthanides and actinides on rows 9 and 10).
Each cell shows the element's symbol over its count: the records of the
current search (its other filters applied, without the element picks) that
have it, on the open sub-tab (records, rows, mapped records). Cells at zero
are disabled; picked cells take the node colour. Apply filters the search to
records with **any** of the picked elements; the picks are listed under the
entry as chips with their counts. Clear unpicks all, Cancel keeps the search.

The column may hold symbols (`Na`, what KdD's data has) or names (`Sodium`,
what the legacy index's `_element_name` held), in any case: both resolve to
the element, and a pick is sent as the column's own spelling. A picked value
that is no element stays in the query untouched.

Options (`plugins.periodic-table` in the node YAML):

| Option | Default | What |
|---|---|---|
| `table` | `kds` | data model table that holds the element column (checked) |
| `column` | `element` | the element column; counted as a facet and matched as `<column>:"<value>"` |
| `levels` | `[]` | search levels that show the filter (empty = every level) |
| `label` | `Periodic Table` | the filter's name in the sidebar and the modal title |

No routes: the backend's `search_facets` lets `GET /v2/{node}/search/{table}?facet=<column>`
count the column, and the UI reuses the core facet counting and query tokens
(the `sidebarFilters` hook, [docs/plugins.md](../../../docs/plugins.md)).

| File | What |
|---|---|
| `plugin.py` | `PeriodicTablePlugin`: options, their check, `search_facets` |
| `index.tsx` | the sidebar entry and the periodic-table modal |
| `elements.ts` | the element layout (number, symbol, name, column, row, category), from the legacy `elements.js` |
| `test_periodic_table.py` | options, the KdD activation, the facet column |
