// node --test (npm test): the Geospatial filter's lasso, read as the API reads it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeLasso,
  encodeLasso,
  extendsLasso,
  finishLasso,
  isLasso,
  type LonLat,
  lassoOutline,
  lassoRing,
  MAX_LASSO_VERTICES,
} from "./lasso.ts";

test("a lasso round-trips through its code, longitudes within ±180°", () => {
  const code = encodeLasso([
    [170, -10],
    [190.123456, -10],
    [190, 10],
  ]);
  assert.ok(isLasso(code));
  assert.equal(code, "lasso:170_-10~-169.8765_-10~-170_10");
  assert.deepEqual(decodeLasso(code), [
    [170, -10],
    [-169.8765, -10],
    [-170, 10],
  ]);
  assert.equal(decodeLasso("lasso:1_2~x"), null);
});

test("lassoRing unwraps across the antimeridian and closes over a pole", () => {
  const fiji = lassoRing([
    [170, -10],
    [-170, -10],
    [-170, 10],
    [170, 10],
  ]);
  assert.deepEqual(
    fiji?.ring.map(([lon]) => lon),
    [170, 190, 190, 170],
  );
  assert.equal(fiji?.closure, 0);
  const arctic = lassoRing(Array.from({ length: 8 }, (_, i): LonLat => [100 + 45 * i, 70]));
  assert.equal(arctic?.closure, 3);
  assert.deepEqual(arctic?.ring.slice(-2), [
    [460, 90],
    [100, 90],
  ]);
  // A bow tie crosses itself; two vertices are no lasso.
  const bowTie: LonLat[] = [
    [0, 0],
    [10, 10],
    [10, 0],
    [0, 10],
  ];
  assert.equal(lassoRing(bowTie), null);
  assert.equal(lassoRing(bowTie.slice(0, 2)), null);
});

test("a lasso circling a pole is outlined without the edges over it", () => {
  const code = encodeLasso(Array.from({ length: 4 }, (_, i): LonLat => [90 * i, -60]));
  const outline = lassoOutline(code);
  assert.ok(outline);
  assert.ok(outline.every(([, lat]) => lat === -60));
  assert.equal(outline.length, 5);
});

test("drawing skips a step that would cross the path", () => {
  const path: LonLat[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  assert.equal(extendsLasso(path, [5, -5]), false);
  assert.equal(extendsLasso(path, [0, 10]), true);
});

test("finishLasso simplifies, and cuts back a closing edge that would cross", () => {
  // A hook: closing its last vertex straight back to the first would cross
  // its first edge, so it is cut back until it doesn't.
  const lonLats: LonLat[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [5, 10],
    [5, -5],
  ];
  const drawn = lonLats.map((lonLat) => ({ lonLat, x: lonLat[0] * 10, y: -lonLat[1] * 10 }));
  const vertices = finishLasso(drawn);
  assert.ok(vertices && lassoRing(vertices));
  assert.deepEqual(vertices, lonLats.slice(0, 4));
  // A long circle comes down to at most MAX_LASSO_VERTICES.
  const circle = Array.from({ length: 2000 }, (_, i) => {
    const a = (2 * Math.PI * i) / 2000;
    const lonLat: LonLat = [20 * Math.cos(a), 20 * Math.sin(a)];
    return { lonLat, x: lonLat[0] * 40, y: -lonLat[1] * 40 };
  });
  const simplified = finishLasso(circle);
  assert.ok(simplified && simplified.length <= MAX_LASSO_VERTICES && lassoRing(simplified));
});
