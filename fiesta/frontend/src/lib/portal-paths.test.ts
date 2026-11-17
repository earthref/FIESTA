// node --test (npm test): References and Users show the FIESTA identity
// wherever they are served; a node's own pages keep the node's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPortalPage, isPortalPath, showsPortalIdentity } from "./portal-paths.ts";

test("References and Users show the FIESTA identity under a node too", () => {
  for (const path of ["/references", "/users", "/users/", "/references/"]) {
    assert.equal(showsPortalIdentity(false, path), true, path);
    assert.equal(showsPortalIdentity(true, path), true, path);
  }
});

test("a node's own pages keep the node identity", () => {
  for (const path of ["/", "/search", "/contributions/1", "/referencesx", "/users/12/edit"]) {
    assert.equal(showsPortalIdentity(false, path), false, path);
  }
});

test("every portal page shows the FIESTA identity", () => {
  assert.equal(showsPortalIdentity(true, "/"), true);
  assert.equal(isPortalPath("/"), true);
  assert.equal(isPortalPage("/"), false);
});

test("Admin is a portal section, under a node too", () => {
  for (const path of ["/admin", "/admin/", "/admin/nodes/magic"]) {
    assert.equal(isPortalPath(path), true, path);
    assert.equal(showsPortalIdentity(false, path), true, path);
  }
  assert.equal(isPortalPath("/administration"), false);
});
