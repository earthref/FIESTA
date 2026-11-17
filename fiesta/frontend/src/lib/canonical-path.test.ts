// node --test (npm test): canonical (PascalCase) path spellings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { casedPath, pathSegment, withRouteCase } from "./canonical-path.ts";

test("slugs become capitalized path segments", () => {
  assert.equal(pathSegment("about"), "About");
  assert.equal(pathSegment("grand-challenges"), "Grand-Challenges");
  assert.equal(pathSegment("MagIC-help"), "MagIC-Help");
  assert.equal(casedPath("/method-codes"), "/Method-Codes");
  assert.equal(casedPath("/search?q=basalt-lava"), "/Search?q=basalt-lava");
});

test("a route's static segments take the pattern's case; params keep theirs", () => {
  assert.equal(withRouteCase("/Search/{-$level}/{-$view}", "/search"), "/Search");
  assert.equal(
    withRouteCase("/Search/{-$level}/{-$view}", "/search/locations/data"),
    "/Search/locations/data",
  );
  assert.equal(
    withRouteCase("/Admin/Nodes/$slug/{-$section}", "/admin/nodes/magic"),
    "/Admin/Nodes/magic",
  );
  assert.equal(withRouteCase("/Data-Models/$version", "/data-models/3.0"), "/Data-Models/3.0");
  assert.equal(withRouteCase("/References", "/References"), "/References");
  assert.equal(withRouteCase("/$page", "/about"), "/about");
  assert.equal(withRouteCase("/References", "/references/"), "/References/");
});
