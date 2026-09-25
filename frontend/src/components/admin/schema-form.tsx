// A form generated from the JSON Schema pydantic v2 emits for a model
// (`Model.model_json_schema()`), editing a plain JSON object in place. It is
// recursive: an object with `properties` becomes labelled fields, a mapping
// (`additionalProperties`) a keyed editor, an array of objects a list of
// sub-forms, an array of primitives a chip list, and each leaf a typed input.
// A `$ref` resolves against the root schema's `$defs`, and an `anyOf` carrying a
// `{type:"null"}` branch is treated as that branch made optional (an empty input
// omits the key). Values are kept as the JSON they will be written as (numbers as
// numbers, absent optional keys omitted), so the result drops straight into the
// node YAML's `plugins.<name>` map.

import { useEffect, useState } from "react";
import type { JsonSchema } from "../../lib/admin";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field } from "./admin-ui";

// --- schema helpers -----------------------------------------------------------

/** A "#/$defs/Name" ref resolved and merged with the node's sibling keywords. */
function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace("#/$defs/", "");
  return { ...(root.$defs?.[name] ?? {}), ...schema, $ref: undefined };
}

/** An `anyOf` carrying a `{type:"null"}` branch → the other branch, optional. */
function nullable(schema: JsonSchema): { schema: JsonSchema; optional: boolean } {
  if (!schema.anyOf) return { schema, optional: false };
  const kept = schema.anyOf.filter((branch) => branch.type !== "null");
  const inner = kept.length === 1 ? kept[0] : ({ anyOf: kept } as JsonSchema);
  return {
    schema: { ...inner, ...schema, anyOf: undefined },
    optional: kept.length !== schema.anyOf.length,
  };
}

/** Resolve a ref and unwrap an optional (nullable) wrapper in one step. */
function normalize(
  schema: JsonSchema,
  root: JsonSchema,
): { schema: JsonSchema; optional: boolean } {
  const { schema: inner, optional } = nullable(schema);
  return { schema: deref(inner, root), optional };
}

type Kind = "enum" | "boolean" | "number" | "array" | "map" | "object" | "string";

function kindOf(s: JsonSchema): Kind {
  if (s.enum || s.const !== undefined) return "enum";
  if (s.type === "boolean") return "boolean";
  if (s.type === "number" || s.type === "integer") return "number";
  if (s.type === "array") return "array";
  if (s.type === "object") {
    if (s.properties) return "object";
    if (s.additionalProperties && typeof s.additionalProperties === "object") return "map";
    return "object";
  }
  return "string";
}

/** The default value for a schema, walking objects so every field is present. */
export function defaultFor(schema: JsonSchema, root: JsonSchema): unknown {
  const { schema: s, optional } = normalize(schema, root);
  if (s.default !== undefined) return structuredClone(s.default);
  if (optional) return undefined;
  switch (kindOf(s)) {
    case "boolean":
      return false;
    case "number":
      return s.minimum ?? 0;
    case "enum":
      return s.const ?? s.enum?.[0];
    case "array":
      return [];
    case "map":
      return {};
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        const value = defaultFor(prop, root);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    default:
      return "";
  }
}

/** The full defaults object for a model's Options schema. */
export function schemaDefaults(schema: JsonSchema): Record<string, unknown> {
  const value = defaultFor(schema, schema);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const titleize = (key: string): string =>
  key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** `obj` with `key` set to `value`, or removed when `value` is undefined. */
function withKey(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...obj, [key]: value };
  if (value === undefined) delete next[key];
  return next;
}

// --- leaf editors -------------------------------------------------------------

/** A number input with its own text draft, so decimals and `-` survive typing. */
function NumberField({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [draft, setDraft] = useState(value === undefined || value === null ? "" : String(value));
  useEffect(() => {
    setDraft(value === undefined || value === null ? "" : String(value));
  }, [value]);
  return (
    <Input
      type="number"
      step={schema.type === "integer" ? 1 : "any"}
      min={schema.minimum ?? schema.exclusiveMinimum}
      max={schema.maximum}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = Number(e.target.value);
        onChange(e.target.value.trim() === "" || Number.isNaN(parsed) ? undefined : parsed);
      }}
    />
  );
}

/** A text (or color) leaf; an empty value omits an optional key. */
function StringValue({
  schema,
  optional,
  value,
  onChange,
}: {
  schema: JsonSchema;
  optional: boolean;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const text = value === undefined || value === null ? "" : String(value);
  const set = (v: string) => onChange(v === "" && optional ? undefined : v);
  const isColor = typeof schema.default === "string" && /^#[0-9a-f]{6}$/i.test(schema.default);
  if (isColor) {
    return (
      <div className="flex gap-2">
        <input
          type="color"
          aria-label="Pick color"
          value={/^#[0-9a-f]{6}$/i.test(text) ? text : "#000000"}
          onChange={(e) => set(e.target.value)}
          className="h-9 w-12 rounded-sm border border-gray-300"
        />
        <Input value={text} onChange={(e) => set(e.target.value)} />
      </div>
    );
  }
  return <Input value={text} onChange={(e) => set(e.target.value)} />;
}

/** A chip list for an array of primitives (add on Enter/Add, remove per chip). */
function PrimitiveList({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: string[]) => void;
}) {
  const items = asArray(value).map(String);
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="space-y-1">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a plain value list may hold duplicates
            <Badge key={`${item}-${index}`} variant="node">
              {item}
              <button
                type="button"
                aria-label={`Remove ${item}`}
                className="ml-0.5 text-node-dark hover:text-red-700"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <Input
          value={draft}
          placeholder="Add a value"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="secondary" onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}

// --- composite editors --------------------------------------------------------

/** The labelled fields of an object schema (no surrounding frame). */
function ObjectFields({
  schema,
  root,
  value,
  onChange,
}: {
  schema: JsonSchema;
  root: JsonSchema;
  value: unknown;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const obj = asObject(value);
  return (
    <div className="grid gap-3">
      {Object.entries(schema.properties ?? {}).map(([key, prop]) => {
        const norm = normalize(prop, root);
        return (
          <Field
            key={key}
            label={prop.title ?? titleize(key)}
            hint={prop.description ?? norm.schema.description}
          >
            <SchemaValue
              schema={prop}
              root={root}
              value={obj[key]}
              onChange={(next) => onChange(withKey(obj, key, next))}
            />
          </Field>
        );
      })}
    </div>
  );
}

/** A reorderable list of sub-forms, one per object item in an array. */
function ObjectList({
  schema,
  root,
  value,
  onChange,
}: {
  schema: JsonSchema;
  root: JsonSchema;
  value: unknown;
  onChange: (next: unknown[]) => void;
}) {
  const items = asArray(value);
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a reorderable list keyed by position
        <div key={index} className="rounded-md border border-gray-200 p-3">
          <div className="mb-2 flex items-center gap-1">
            <span className="text-xs font-semibold text-gray-500">#{index + 1}</span>
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Move down"
                disabled={index === items.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </span>
          </div>
          <ObjectFields
            schema={schema}
            root={root}
            value={item}
            onChange={(next) => onChange(items.map((it, i) => (i === index ? next : it)))}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        onClick={() => onChange([...items, defaultFor(schema, root)])}
      >
        + Add
      </Button>
    </div>
  );
}

/** A keyed map (`additionalProperties`): add/remove keys, each value recursive. */
function MapEditor({
  schema,
  root,
  value,
  onChange,
}: {
  schema: JsonSchema;
  root: JsonSchema;
  value: unknown;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const obj = asObject(value);
  const valueSchema =
    typeof schema.additionalProperties === "object" ? schema.additionalProperties : {};
  const [newKey, setNewKey] = useState("");
  const add = () => {
    const key = newKey.trim();
    if (key && !(key in obj)) onChange({ ...obj, [key]: defaultFor(valueSchema, root) });
    setNewKey("");
  };
  const entries = Object.entries(obj);
  return (
    <div className="space-y-2">
      {entries.map(([key, item]) => (
        <div key={key} className="rounded-md border border-gray-200 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-gray-700">{key}</span>
            <Button
              size="sm"
              variant="danger"
              className="ml-auto"
              onClick={() => onChange(withKey(obj, key, undefined))}
            >
              Remove
            </Button>
          </div>
          <SchemaValue
            schema={valueSchema}
            root={root}
            value={item}
            onChange={(next) => onChange(withKey(obj, key, next))}
          />
        </div>
      ))}
      {entries.length === 0 && <p className="text-xs text-gray-500">No entries yet.</p>}
      <div className="flex gap-1">
        <Input
          value={newKey}
          placeholder="New key (e.g. a table name)"
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="secondary" onClick={add}>
          Add Key
        </Button>
      </div>
    </div>
  );
}

/** One value of any schema shape, dispatched on its normalized kind. */
function SchemaValue({
  schema,
  root,
  value,
  onChange,
}: {
  schema: JsonSchema;
  root: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { schema: s, optional } = normalize(schema, root);
  switch (kindOf(s)) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded-sm border-gray-300 align-middle"
        />
      );
    case "number":
      return <NumberField schema={s} value={value} onChange={onChange} />;
    case "enum": {
      const options = s.enum ?? (s.const !== undefined ? [s.const] : []);
      return (
        <select
          value={value === undefined ? "" : String(value)}
          onChange={(e) =>
            onChange(
              e.target.value === ""
                ? undefined
                : options.find((option) => String(option) === e.target.value),
            )
          }
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        >
          {optional && <option value="">(none)</option>}
          {options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      );
    }
    case "array": {
      const item = normalize(s.items ?? {}, root).schema;
      const isObjectItem = kindOf(item) === "object" || kindOf(item) === "map";
      return isObjectItem ? (
        <ObjectList schema={item} root={root} value={value} onChange={onChange} />
      ) : (
        <PrimitiveList value={value} onChange={onChange} />
      );
    }
    case "map":
      return <MapEditor schema={s} root={root} value={value} onChange={onChange} />;
    case "object":
      return (
        <div className="rounded-md border border-gray-200 p-3">
          <ObjectFields schema={s} root={root} value={value} onChange={onChange} />
        </div>
      );
    default:
      return <StringValue schema={s} optional={optional} value={value} onChange={onChange} />;
  }
}

/** A form for a plain JSON object, generated from `schema` (a model's schema). */
export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return <ObjectFields schema={schema} root={schema} value={value} onChange={onChange} />;
}
