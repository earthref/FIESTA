// node --test (npm test): coloring map markers on a log scale.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MapColorOption } from "../../lib/types.ts";
import { colorOf, RAMP } from "./map-colors.ts";

const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(",")})`;

test("on a log scale a value ≤ 0 takes the low end's color, not none", () => {
  // Age in years BP, log: 1 ka to 100 Ma.
  const option = { label: "Age", field: "x", scale: 1e6, log: true } as MapColorOption;
  const scale = { option, low: 3, high: 8 };
  // 2010 AD (-60 years BP) and 1950 AD (0) are the youngest.
  assert.equal(colorOf(scale, -60), rgb(RAMP[0]));
  assert.equal(colorOf(scale, 0), rgb(RAMP[0]));
  assert.equal(colorOf(scale, 1e3), rgb(RAMP[0]));
  assert.equal(colorOf(scale, 1e8), rgb(RAMP[RAMP.length - 1]));
  assert.equal(colorOf(scale, Number.NaN), null);
});
