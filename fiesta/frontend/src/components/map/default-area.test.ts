// node --test (npm test): the Geospatial filter's default area.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AREA_DEGREES, defaultArea } from "./default-area.ts";

const close = (actual: number[] | null, expected: number[]) => {
  assert.ok(actual, "an area");
  for (const [i, value] of actual.entries()) {
    assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual}`);
  }
};

test("records that fit get the area around them, with a margin", () => {
  close(
    defaultArea({ total: 2, bounds: [-21.25, 64.1, -21.14, 64.12] }),
    [-21.35, 64.0, -21.04, 64.22],
  );
  close(defaultArea({ total: 9, bounds: [0, 0, 10, 5] }), [-0.2, -0.1, 10.2, 5.1]);
});

test("spread records get 20° around where most of them are", () => {
  const area = defaultArea({
    total: 8496,
    bounds: [-155, -82.6, 156.6, 82.1],
    center: [-39.1, -58.9],
  });
  close(area, [-49.1, -68.9, -29.1, -48.9]);
  const [w, s, e, n] = area ?? [];
  assert.ok(Math.abs(e - w - DEFAULT_AREA_DEGREES) < 1e-9);
  assert.ok(Math.abs(n - s - DEFAULT_AREA_DEGREES) < 1e-9);
});

test("each axis is sized on its own; 20° spans fit around their middle", () => {
  // Narrow in longitude, spread in latitude.
  close(
    defaultArea({ total: 5, bounds: [10, -60, 12, 60], center: [11, 40] }),
    [9.9, 30, 12.1, 50],
  );
  // Exactly 20° wide: no room for the margin, so 20° around the middle.
  close(defaultArea({ total: 5, bounds: [0, 0, 20, 1], center: [3, 0.5] }), [0, -0.1, 20, 1.1]);
});

test("near a pole the area moves onto the globe", () => {
  close(
    defaultArea({ total: 50, bounds: [-170, -89, 170, -60], center: [30, -85] }),
    [20, -90, 40, -70],
  );
});

test("across the antimeridian, east passes 180", () => {
  // geo_bounds wraps: west 170, east -170 (20° wide: no room for the margin).
  close(
    defaultArea({ total: 4, bounds: [170, -20, -170, -10], center: [179, -15] }),
    [170, -20.2, 190, -9.8],
  );
  close(
    defaultArea({ total: 4, bounds: [175, -20, -175, -10], center: [179, -15] }),
    [174.8, -20.2, 185.2, -9.8],
  );
  // Spread past 20°, centred on the far side of the line.
  close(
    defaultArea({ total: 4, bounds: [150, -20, -150, -10], center: [-175, -15] }),
    [175, -20.2, 195, -9.8],
  );
});

test("no positioned records, no area", () => {
  assert.equal(defaultArea({ total: 0 }), null);
});
