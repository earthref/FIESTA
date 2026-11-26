// node --test (npm test): the search sidebar's pinned filters and order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { orderSidebarEntries, pinnedFilterNames } from "./pinned-filters.ts";

const rules = [
  { levels: [], views: [], filters: ["Age", "Geospatial", "Author", "Contributor"] },
  { levels: ["Locations"], views: ["Poles"], filters: ["Age", "Pole A95", "Geospatial"] },
  { levels: [], views: ["Rock Magnetism"], filters: ["Mr/Ms"] },
  { levels: ["Specimens"], views: [], filters: ["Geospatial"] },
  { levels: ["Specimens"], views: [], filters: ["Never"] },
];

test("the most specific matching rule wins", () => {
  assert.deepEqual(pinnedFilterNames(rules, "Sites", "Summaries"), [
    "Age",
    "Geospatial",
    "Author",
    "Contributor",
  ]);
  assert.deepEqual(pinnedFilterNames(rules, "Locations", "Poles"), [
    "Age",
    "Pole A95",
    "Geospatial",
  ]);
  // A rule naming views beats one naming only levels.
  assert.deepEqual(pinnedFilterNames(rules, "Specimens", "Rock Magnetism"), ["Mr/Ms"]);
  // Between equally specific rules, the first.
  assert.deepEqual(pinnedFilterNames(rules, "Specimens", "Data"), ["Geospatial"]);
  assert.deepEqual(pinnedFilterNames(undefined, "Sites", "Data"), []);
  assert.deepEqual(pinnedFilterNames(rules.slice(1), "Sites", "Data"), []);
  assert.deepEqual(pinnedFilterNames(rules.slice(1), "Locations", undefined), []);
});

const labels = (list: { label: string }[]) => list.map((e) => e.label);
const entry = (key: string, label: string, count: number | null | undefined, applied = false) => ({
  key,
  label,
  count,
  chips: applied ? [{}] : [],
});

test("pinned first in pin order, then applied, then by count", () => {
  const entries = [
    entry("geo", "Geospatial", 50),
    entry("range:year", "Publication Year", 80),
    entry("range:age", "Age", 0),
    entry("facet:contributor", "Contributor", 90),
    entry("facet:author", "Author", 10),
    entry("facet:site", "Site", 5, true),
    entry("facet:lithology", "Lithology", 0),
    entry("facet:a", "Alpha", 20),
    entry("facet:b", "Beta", 20),
    entry("facet:c", "Gamma", undefined),
  ];
  const ordered = orderSidebarEntries(entries, ["age", "FACET:AUTHOR", "Geospatial", "Missing"]);
  // Age has no values but is pinned: shown; Lithology is hidden.
  assert.deepEqual(labels(ordered.pinned), ["Age", "Author", "Geospatial"]);
  assert.deepEqual(labels(ordered.rest), [
    "Site",
    "Contributor",
    "Publication Year",
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  const unpinned = orderSidebarEntries(entries, []);
  assert.deepEqual(unpinned.pinned, []);
  assert.deepEqual(labels(unpinned.rest), [
    "Site",
    "Contributor",
    "Publication Year",
    "Geospatial",
    "Alpha",
    "Beta",
    "Author",
    "Gamma",
  ]);
});

test("a plugin filter is ordered as the node's own", () => {
  const entries = [
    entry("range:year", "Publication Year", 40),
    entry("plugin:periodic-table", "Periodic Table of Elements", 120),
    entry("plugin:geomag-series-radius", "Radius Search", null),
    entry("facet:rock", "Rock Type", 0),
  ];
  // Unpinned: by count, an uncounted one after the counted.
  assert.deepEqual(labels(orderSidebarEntries(entries, []).rest), [
    "Periodic Table of Elements",
    "Publication Year",
    "Radius Search",
  ]);
  // Pinned by its label or its key.
  for (const pin of ["Periodic Table of Elements", "plugin:periodic-table"]) {
    const { pinned, rest } = orderSidebarEntries(entries, ["Publication Year", pin]);
    assert.deepEqual(labels(pinned), ["Publication Year", "Periodic Table of Elements"]);
    assert.deepEqual(labels(rest), ["Radius Search"]);
  }
});
