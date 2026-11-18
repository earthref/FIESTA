// node --test (npm test): the grid's cell checks word their errors as
// fiesta.domain.validate does (tests/test_validate.py has the server's side).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellValues, checkCell, indexVocabularies } from "./contribution-grid.ts";

const lookup = indexVocabularies(
  {
    location_type: { items: [{ item: "Outcrop" }, { item: "Region" }] },
    external_database_names: { items: [{ item: "GEOMAGIA50" }, { item: "CALS7K.2" }] },
  },
  { method_codes: { items: [{ item: "LP-DC3" }], case_insensitive: true } },
);

test("a term that differs only in case says how the vocabulary spells it", () => {
  const column = { type: "String", validations: ['cv("location_type")'] };
  assert.deepEqual(checkCell("location_type", column, "region", true, lookup), [
    "'region' is not in the controlled vocabulary 'location_type'; it is spelled 'Region'",
  ]);
  assert.deepEqual(checkCell("location_type", column, "Region", true, lookup), []);
});

test("type() checks a controlled vocabulary of that name, case-insensitively for plugins", () => {
  const column = { type: "List", validations: ['type("method_codes")'] };
  assert.deepEqual(checkCell("method_codes", column, "lp-dc3:?", true, lookup), [
    "'?' is not in the controlled vocabulary 'method_codes'",
  ]);
  const doi = { type: "String", validations: ['type("doi")'] };
  assert.deepEqual(checkCell("doi", doi, "anything", true, lookup), []);
});

test("an integer beyond OpenSearch's long is an error", () => {
  const column = { type: "Integer" };
  assert.deepEqual(checkCell("n", column, "368482598770000000000", true, lookup), [
    "368482598770000000000 is too large for an integer column (at most 19 digits)",
  ]);
  assert.deepEqual(checkCell("n", column, "9223372036854775807", true, lookup), []);
});

test("dictionary keys and matrix row keys are the vocabulary values", () => {
  const dictionary = { type: "Dictionary", validations: ['cv("external_database_names")'] };
  assert.deepEqual(cellValues(dictionary, "GEOMAGIA50[1435]:CALS7K.2[23]"), [
    "GEOMAGIA50",
    "CALS7K.2",
  ]);
  assert.deepEqual(checkCell("ids", dictionary, "GEOMAGIA50[1]:NOPE[2]", true, lookup), [
    "'NOPE' is not in the controlled vocabulary 'external_database_names'",
  ]);
  assert.deepEqual(cellValues({ type: "Matrix" }, "DD:20:124;TP:45:14"), ["DD", "TP"]);
  assert.deepEqual(cellValues({ type: "List" }, ':a:"b:c":d:'), ["a", '"b:c"', "d"]);
});
