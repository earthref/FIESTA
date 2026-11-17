// node --test (npm test): search URLs -- legacy params become a saved
// search's state, and path segments name levels and views in any case.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contributionPath,
  hasLegacyParams,
  isEmptyState,
  isSearchId,
  searchPath,
  slugMatches,
  stateFromLegacy,
  stateKey,
} from "./search-state.ts";

const ID = "0b6f7c1e-3a52-5d0e-9c1a-2f4b6d8e0a13";

test("a saved search id is not legacy free text", () => {
  assert.equal(isSearchId(ID), true);
  assert.equal(isSearchId("basalt"), false);
  assert.equal(hasLegacyParams({ q: ID }), false);
  assert.equal(hasLegacyParams({ q: "basalt" }), true);
  assert.equal(hasLegacyParams({ level: "Locations" }), true);
  assert.equal(hasLegacyParams({}), false);
});

test("legacy params become the state", () => {
  const state = stateFromLegacy({
    q: "basalt",
    level: "Locations",
    sort: "rows.dir_n_samples:asc",
    ranges: "age:0:10",
    filter: ["a:b"],
    mine: "nobody",
  });
  assert.deepEqual(state, {
    query: "basalt",
    sort: "rows.dir_n_samples:asc",
    ranges: ["age:0:10"],
    filter: ["a:b"],
  });
  assert.equal(isEmptyState(stateFromLegacy({ level: "Sites", view: "Data" })), true);
});

test("state keys ignore key order and empty fields", () => {
  assert.equal(
    stateKey({ query: "x", settings: { b: 1, a: 2 } }),
    stateKey({ settings: { a: 2, b: 1 }, ranges: [], query: "x" }),
  );
});

test("paths name levels, views and contribution tabs", () => {
  assert.equal(searchPath("Locations", "Data"), "/Search/Locations/Data");
  assert.equal(searchPath("Sites"), "/Search/Sites");
  assert.equal(searchPath(), "/Search");
  assert.equal(searchPath("Sites", "Rock Magnetism"), "/Search/Sites/Rock-Magnetism");
  assert.equal(contributionPath(667), "/667/Contribution");
  assert.equal(contributionPath(667, "Sites"), "/667/Sites");
  assert.equal(slugMatches("Rock Magnetism", "rock-magnetism"), true);
  assert.equal(slugMatches("Data", "data"), true);
  assert.equal(slugMatches("Data", "Summaries"), false);
});
