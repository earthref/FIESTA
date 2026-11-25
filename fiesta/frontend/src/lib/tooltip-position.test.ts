// node --test (npm test): the tooltip stays inside the viewport, flipping
// below its anchor at the top edge and shifting sideways at the left and right.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorBox, GAP, MARGIN, placeTooltip } from "./tooltip-position.ts";

const viewport = { width: 1000, height: 600 };
const size = { width: 200, height: 40 };
const anchor = (left: number, top: number, width = 40, height = 20) => ({
  left,
  top,
  width,
  height,
});

test("centred above the anchor when there is room", () => {
  assert.deepEqual(placeTooltip(anchor(480, 300), size, viewport), {
    left: 400,
    top: 300 - GAP - 40,
    side: "top",
  });
});

test("flips below an anchor at the top edge", () => {
  const placed = placeTooltip(anchor(480, 10), size, viewport);
  assert.equal(placed.side, "bottom");
  assert.equal(placed.top, 10 + 20 + GAP);
});

test("flips above an anchor at the bottom edge when below is preferred", () => {
  const placed = placeTooltip(anchor(480, 570), size, viewport, "bottom");
  assert.equal(placed.side, "top");
  assert.equal(placed.top, 570 - GAP - 40);
});

test("shifts sideways at the left and right edges", () => {
  assert.equal(placeTooltip(anchor(0, 300), size, viewport).left, MARGIN);
  assert.equal(placeTooltip(anchor(960, 300), size, viewport).left, 1000 - MARGIN - 200);
});

test("takes the roomier side and stays on screen when neither side fits", () => {
  const tall = { width: 200, height: 400 };
  const placed = placeTooltip(anchor(480, 200, 40, 250), tall, viewport);
  assert.equal(placed.side, "top");
  assert.equal(placed.top, MARGIN);
  const lower = placeTooltip(anchor(480, 100, 40, 250), tall, viewport);
  assert.equal(lower.side, "bottom");
  assert.equal(lower.top, 600 - MARGIN - 400);
});

test("a tooltip wider than the viewport starts at the left margin", () => {
  assert.equal(placeTooltip(anchor(480, 300), { width: 1200, height: 40 }, viewport).left, MARGIN);
});

test("a large anchor is replaced by the pointer, a small one is kept", () => {
  const small = anchor(100, 100);
  assert.deepEqual(anchorBox(small, { x: 5, y: 5 }), { box: small, prefer: "top" });
  const large = anchor(0, 0, 800, 400);
  assert.deepEqual(anchorBox(large, null), { box: large, prefer: "top" });
  const atPointer = anchorBox(large, { x: 300, y: 200 });
  assert.equal(atPointer.prefer, "bottom");
  assert.equal(atPointer.box.left, 300);
  assert.equal(atPointer.box.top, 200);
});
