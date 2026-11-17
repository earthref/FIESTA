// node --test (npm test): a geologic time unit as an age filter's range.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TIMESCALE, unitSpan } from "./timescale.ts";

const unit = (name: string) => {
  const found = TIMESCALE.find((u) => u.name === name);
  assert.ok(found, name);
  return found;
};

test("a unit reaching the present has no younger bound (ages after 1950 are negative BP)", () => {
  for (const name of ["Holocene", "Quaternary", "Cenozoic", "Phanerozoic"]) {
    const [min, max] = unitSpan(unit(name));
    assert.equal(min, Number.NEGATIVE_INFINITY, name);
    assert.equal(max, unit(name).max, name);
  }
});

test("an older unit keeps both boundaries", () => {
  assert.deepEqual(unitSpan(unit("Cretaceous")), [unit("Cretaceous").min, unit("Cretaceous").max]);
  assert.ok(unitSpan(unit("Pleistocene"))[0] > 0);
});
