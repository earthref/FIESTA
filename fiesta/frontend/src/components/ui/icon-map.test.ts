// node --test (npm test): the icon table covers every icon the node YAMLs
// name, and an unknown name falls back instead of rendering nothing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FALLBACK_ICON, ICONS, iconName, isIconName, normalizeIconName } from "./icon-map.ts";

const CONFIGURATIONS = new URL("../../../../../configurations/", import.meta.url);

/** Every `icon:` / `corner_icon:` value in configurations/*.yaml and the plugin UIs. */
function configuredIconNames(): Set<string> {
  const names = new Set<string>();
  const pattern =
    /\b(?:corner_icon|icon)\s*:\s*["']?([A-Za-z][A-Za-z0-9 _-]*?)["']?\s*(?:[,}\n]|$)/g;
  const read = (url: URL) => {
    for (const match of readFileSync(url, "utf8").matchAll(pattern)) names.add(match[1]);
  };
  for (const file of readdirSync(CONFIGURATIONS)) {
    if (file.endsWith(".yaml")) read(new URL(file, CONFIGURATIONS));
  }
  const plugins = new URL("plugins/", CONFIGURATIONS);
  for (const plugin of readdirSync(plugins)) {
    const index = new URL(`${plugin}/index.tsx`, plugins);
    try {
      read(index);
    } catch {
      // a plugin without a UI
    }
  }
  names.delete("null");
  return names;
}

test("every icon a node configuration names is in the table", () => {
  const names = configuredIconNames();
  assert.ok(names.size > 10, `found only ${names.size} configured icon names`);
  const missing = [...names].filter((name) => !isIconName(normalizeIconName(name)));
  assert.deepEqual(missing, []);
});

test("Semantic UI spellings resolve like the kebab-case ones", () => {
  assert.equal(iconName("file text outline"), "file-text-outline");
  assert.equal(iconName("Question Circle icon"), "question-circle");
  assert.equal(iconName("bar chart"), "bar-chart");
  assert.equal(ICONS[iconName("remove circle")], ICONS["remove-circle"]);
});

test("unknown or missing names fall back", () => {
  assert.equal(iconName("no-such-icon"), FALLBACK_ICON);
  assert.equal(iconName("constructor"), FALLBACK_ICON);
  assert.equal(iconName(""), FALLBACK_ICON);
  assert.equal(iconName(undefined), FALLBACK_ICON);
  assert.equal(iconName(null, "file-text"), "file-text");
  assert.equal(iconName("nonsense", "file-text"), "file-text");
  assert.ok(isIconName(FALLBACK_ICON));
});

test("every table entry is a renderable component", () => {
  for (const [name, glyph] of Object.entries(ICONS)) {
    assert.ok(glyph && typeof glyph === "object", `${name} is not a Lucide component`);
  }
});
