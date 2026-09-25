// Editor for the node's plugins: which of the plugins the code declares are
// switched on (the YAML `features.plugins` list) and how each is tuned (the
// `plugins.<name>` map, validated by the backend against the plugin's pydantic
// Options model). Each plugin's options are edited through SchemaForm, seeded
// from the schema defaults so every field is present; saving writes only the
// keys that differ from the defaults, and a plugin left at its defaults drops
// its map entry (`value: null`). Options are kept even while a plugin is off.
// Saving records the draft; publishing (a separate step) validates the options
// against the node's data model and search levels.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  adminKeys,
  type NodeSettings,
  type PluginInfo,
  patchSettings,
  type SettingsOp,
} from "../../lib/admin";
import { ErrorMessage } from "../error-message";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SchemaForm, schemaDefaults } from "./schema-form";

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The schema defaults with the node's stored overrides layered on top. */
function merge(
  defaults: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    const base = out[key];
    out[key] = isPlain(base) && isPlain(value) ? merge(base, value) : value;
  }
  return out;
}

/** The top-level options keys whose value differs from the schema default. */
function diff(
  value: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(value), ...Object.keys(defaults)])) {
    if (JSON.stringify(value[key]) !== JSON.stringify(defaults[key])) out[key] = value[key];
  }
  return out;
}

export function PluginsEditor({
  slug,
  settings,
  settingsLock,
  plugins,
}: {
  slug: string;
  settings: NodeSettings;
  /** lockOf() the settings the parent loaded (for edits to the node YAML). */
  settingsLock: number | null;
  /** Every plugin the code declares (name, description, Options JSON schema). */
  plugins: PluginInfo[];
}) {
  const queryClient = useQueryClient();

  // Full defaults per plugin, the enabled list, and each plugin's starting map.
  const defaults = useMemo<Record<string, Record<string, unknown>>>(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const p of plugins) out[p.name] = schemaDefaults(p.schema);
    return out;
  }, [plugins]);
  const enabledInitial = useMemo(() => settings.features?.plugins ?? [], [settings.features]);
  const optionsInitial = useMemo<Record<string, Record<string, unknown>>>(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const p of plugins)
      out[p.name] = merge(defaults[p.name], settings.plugins?.[p.name] ?? {});
    return out;
  }, [plugins, defaults, settings.plugins]);

  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [options, setOptions] = useState<Record<string, Record<string, unknown>>>({});
  useEffect(() => {
    const on: Record<string, boolean> = {};
    for (const p of plugins) on[p.name] = enabledInitial.includes(p.name);
    setEnabled(on);
    setOptions(optionsInitial);
  }, [plugins, enabledInitial, optionsInitial]);

  // The `features.plugins` list, keeping the stored order and appending new ones.
  const enabledNames = useMemo(() => {
    const kept = enabledInitial.filter((name) => enabled[name]);
    const added = plugins
      .map((p) => p.name)
      .filter((name) => enabled[name] && !enabledInitial.includes(name));
    return [...kept, ...added];
  }, [plugins, enabled, enabledInitial]);

  // The patch: the enabled list when it changed, plus every plugin whose options
  // changed (its diff from the defaults, or null to delete a now-default map).
  const ops = useMemo<SettingsOp[]>(() => {
    const out: SettingsOp[] = [];
    if (JSON.stringify(enabledNames) !== JSON.stringify(enabledInitial))
      out.push({ path: ["features", "plugins"], value: enabledNames });
    for (const p of plugins) {
      const current = options[p.name];
      if (!current || JSON.stringify(current) === JSON.stringify(optionsInitial[p.name])) continue;
      const changed = diff(current, defaults[p.name]);
      out.push({ path: ["plugins", p.name], value: Object.keys(changed).length ? changed : null });
    }
    return out;
  }, [plugins, options, defaults, optionsInitial, enabledNames, enabledInitial]);

  const save = useMutation({
    mutationFn: () => patchSettings(slug, ops, settingsLock),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.node(slug) }),
  });

  const reset = () => {
    const on: Record<string, boolean> = {};
    for (const p of plugins) on[p.name] = enabledInitial.includes(p.name);
    setEnabled(on);
    setOptions(optionsInitial);
  };

  const dirty = ops.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-600">
          Turn a plugin on to add its views, and tune its options below. Options are kept even while
          a plugin is off.
        </span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <Badge variant="warning">unsaved changes</Badge>}
          <Button type="button" variant="ghost" disabled={!dirty} onClick={reset}>
            Reset
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save to Draft
          </Button>
        </span>
      </div>
      {save.error && <ErrorMessage error={save.error} />}
      {plugins.length === 0 && (
        <p className="text-sm text-gray-500">No plugins are available in this build.</p>
      )}

      {plugins.map((p) => {
        const current = options[p.name] ?? defaults[p.name] ?? {};
        const isDefault = Object.keys(diff(current, defaults[p.name] ?? {})).length === 0;
        return (
          <section key={p.name} className="rounded-md border border-gray-200 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 font-semibold text-gray-900">
                <input
                  type="checkbox"
                  checked={enabled[p.name] ?? false}
                  onChange={(e) => setEnabled({ ...enabled, [p.name]: e.target.checked })}
                  className="h-4 w-4 rounded-sm border-gray-300"
                />
                {p.name}
              </label>
              {enabled[p.name] ? (
                <Badge variant="success">enabled</Badge>
              ) : (
                <Badge variant="muted">off</Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={isDefault}
                onClick={() => setOptions({ ...options, [p.name]: defaults[p.name] ?? {} })}
              >
                Reset to defaults
              </Button>
            </div>
            <p className="mb-3 text-sm text-gray-600">{p.description}</p>
            {/* A switched-off plugin's options stay editable, folded away. */}
            <details open={enabled[p.name] ?? false}>
              <summary className="cursor-pointer text-xs font-semibold text-gray-700">
                Options{isDefault ? " (defaults)" : ""}
              </summary>
              <div className="mt-2">
                <SchemaForm
                  schema={p.schema}
                  value={current}
                  onChange={(next) => setOptions({ ...options, [p.name]: next })}
                />
              </div>
            </details>
          </section>
        );
      })}

      <p className="text-xs text-gray-500">
        Publishing the draft validates each enabled plugin's options against the node's data model
        and search levels; saving here only records them.
      </p>
    </div>
  );
}
