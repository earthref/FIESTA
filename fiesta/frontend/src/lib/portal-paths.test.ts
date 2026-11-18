// node --test (npm test): References and Users show the FIESTA identity
// wherever they are served; a node's own pages keep the node's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPortalPage, isPortalPath, showsPortalIdentity } from "./portal-paths.ts";

test("References and Users show the FIESTA identity under a node too", () => {
  for (const path of ["/References", "/Users", "/users/", "/references/"]) {
    assert.equal(showsPortalIdentity(false, path), true, path);
    assert.equal(showsPortalIdentity(true, path), true, path);
  }
});

test("a node's own pages keep the node identity", () => {
  for (const path of ["/", "/Search", "/16901/Contribution", "/referencesx", "/users/12/edit"]) {
    assert.equal(showsPortalIdentity(false, path), false, path);
  }
});

test("every portal page shows the FIESTA identity", () => {
  assert.equal(showsPortalIdentity(true, "/"), true);
  assert.equal(isPortalPath("/"), true);
  assert.equal(isPortalPage("/"), false);
});

test("Admin is served at the portal; its portal tabs keep the FIESTA identity under a node", () => {
  for (const path of [
    "/Admin",
    "/admin/",
    "/Admin/Nodes",
    "/admin/nodes/magic",
    "/Admin/Accounts",
  ]) {
    assert.equal(isPortalPath(path), true, path);
  }
  for (const path of ["/Admin/Nodes", "/admin/nodes/magic", "/Admin/Accounts"]) {
    assert.equal(showsPortalIdentity(false, path), true, path);
  }
  assert.equal(isPortalPath("/administration"), false);
});

test("a node's own Admin page keeps the node identity", () => {
  for (const path of ["/Admin", "/Admin/Settings", "/admin/data-source"]) {
    assert.equal(showsPortalIdentity(false, path), false, path);
  }
});
