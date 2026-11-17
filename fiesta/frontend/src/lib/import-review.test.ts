// node --test (npm test): the upload page's column suggester, table guess and
// Step 2 review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchTemplate, reviewSheet } from "./import-review.ts";
import { computeSheet, guessTable, initialState, type Sheet, suggestMatch } from "./importer.ts";
import type { DataModel, ImportTemplate } from "./types.ts";

const model: DataModel = {
  tables: {
    sites: {
      position: 1,
      columns: {
        site: { label: "Site Name", type: "String", validations: ["required()"], position: 1 },
        lat: {
          label: "Latitude",
          type: "Number",
          validations: ["min(-90)", "max(90)", "required()"],
          previous_columns: [{ table: "er_sites", column: "site_lat" }],
          position: 2,
        },
        lon: {
          label: "Longitude",
          type: "Number",
          unit: "Degrees",
          validations: ["min(0)", "max(360)", "required()"],
          position: 3,
        },
        lithologies: {
          label: "Lithologies",
          type: "List",
          validations: ["required()"],
          position: 4,
        },
        n_samples: { label: "Number of Samples", type: "Integer", position: 5 },
      },
    },
    samples: {
      position: 2,
      columns: {
        sample: { label: "Sample Name", type: "String", position: 1 },
        site: { label: "Site Name", type: "String", position: 2 },
      },
    },
  },
};
const sites = model.tables.sites.columns;

test("suggestMatch: exact name, label, older name, loose, remembered", () => {
  assert.deepEqual(suggestMatch("LAT", sites), { column: "lat", kind: "name" });
  assert.deepEqual(suggestMatch("latitude", sites), { column: "lat", kind: "label" });
  assert.deepEqual(suggestMatch("site_lat", sites), { column: "lat", kind: "alias" });
  assert.deepEqual(suggestMatch("Lon (deg)", sites), { column: "lon", kind: "loose" });
  assert.deepEqual(suggestMatch("number-of-samples", sites), {
    column: "n_samples",
    kind: "loose",
  });
  assert.deepEqual(suggestMatch("rock", sites, { rock: "lithologies" }), {
    column: "lithologies",
    kind: "remembered",
  });
  assert.equal(suggestMatch("rock", sites, { rock: "nope" }), undefined);
  assert.equal(suggestMatch("", sites), undefined);
});

test("guessTable: most headers in one table, at least half", () => {
  assert.equal(guessTable(["site", "lat", "lon", "whatever"], model), "sites");
  assert.equal(guessTable(["sample", "site"], model), "samples");
  assert.equal(guessTable(["a", "b", "c", "lat"], model), undefined);
});

const sheet = (rows: string[][], tableName = ""): Sheet => ({
  label: "",
  rows,
  tableName,
  nHeaderRows: "",
});

test("initialState: a table named in the singular or guessed from the headers", () => {
  const named = initialState(sheet([["site", "lat"]], "Site"), model);
  assert.equal(named.settings.table_name, "sites");
  assert.equal(named.guessed?.table, false);
  const guessed = initialState(
    sheet([
      ["site", "lat", "lon"],
      ["a", "1", "2"],
    ]),
    model,
  );
  assert.equal(guessed.settings.table_name, "sites");
  assert.equal(guessed.guessed?.table, true);
  assert.equal(guessed.guessed?.headerRows, true);
});

test("reviewSheet: fixes, soft matches, values, required columns, dismissal", () => {
  const rows = [
    ["site", "Latitude", "lon", "n_samples", "mystery"],
    ["s1", "45", "-120", "3", "x"],
    ["s2", "abc", "240", "2.5", "y"],
    ["s3", "95", "", "4", "z"],
  ];
  const s = sheet(rows, "sites");
  const state = initialState(s, model);
  const result = computeSheet(rows, state, model);
  const review = reviewSheet(rows, state, result, model);
  assert.equal(review.status, "fix");
  const keys = review.items.map((item) => item.key);
  assert.ok(keys.includes("unmapped:4"), "mystery has no column");
  assert.ok(keys.includes("match:1:lat"), "Latitude matched by label");
  assert.ok(keys.includes("values:1:lat:type"), "abc is not a number");
  assert.ok(keys.includes("values:1:lat:max"), "95 is above 90");
  assert.ok(keys.includes("values:2:lon:min"), "-120 is below 0");
  assert.ok(keys.includes("values:2:lon:blank"), "lon is required");
  assert.ok(keys.includes("values:3:n_samples:type"), "2.5 is not an integer");
  assert.ok(keys.includes("header-rows:1"), "the header row was guessed");

  // Leaving out the unknown column clears the fix; required lithologies is missing.
  const fixed = { ...state, excludeColumns: [4] };
  const after = reviewSheet(rows, fixed, computeSheet(rows, fixed, model), model);
  assert.equal(after.status, "review");
  assert.ok(after.items.some((item) => item.key === "required:sites:lithologies"));

  // A dismissed review item goes away; a fix never does.
  const dismissed = { ...fixed, dismissed: ["values:2:lon:min", "unmapped:4"] };
  const later = reviewSheet(rows, dismissed, computeSheet(rows, dismissed, model), model);
  assert.ok(!later.items.some((item) => item.key === "values:2:lon:min"));

  // Accepting the label match makes it the contributor's pick.
  const accepted = { ...fixed, targets: [undefined, "lat"] };
  const acceptedResult = computeSheet(rows, accepted, model);
  assert.equal(acceptedResult.matches[1], "manual");
  assert.ok(
    !reviewSheet(rows, accepted, acceptedResult, model).items.some((i) => i.key === "match:1:lat"),
  );
});

test("reviewSheet: a skipped table needs nothing", () => {
  const rows = [["mystery"], ["x"]];
  const state = initialState(sheet(rows, "sites"), model);
  state.settings.exclude_table = true;
  const review = reviewSheet(rows, state, computeSheet(rows, state, model), model);
  assert.equal(review.status, "skipped");
  assert.equal(review.items.length, 0);
});

test("matchTemplate: a template covering 80% of the headers", () => {
  const template = (id: number, columns: string[]): ImportTemplate =>
    ({
      id,
      name: `t${id}`,
      settings: {
        table_name: "sites",
        n_header_rows: "1",
        column_map: Object.fromEntries(columns.map((c) => [c, c])),
        exclude_column_names: [],
        exclude_table: false,
      },
    }) as ImportTemplate;
  const templates = [template(1, ["a", "b"]), template(2, ["a", "b", "c", "d"])];
  assert.equal(matchTemplate(templates, ["a", "b", "c", "d", "e"])?.template.id, 2);
  assert.equal(matchTemplate(templates, ["a", "x", "y"]), null);
  assert.equal(matchTemplate(templates, ["Column 1", "Column 2"]), null);
});
