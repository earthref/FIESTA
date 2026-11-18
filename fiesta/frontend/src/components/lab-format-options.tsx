/**
 * A lab file's conversion in the upload page's import step: what the
 * converter made (the hierarchy's counts, its tool and version), its report
 * (hints, errors and warnings in full, the defaults it used, other messages
 * collapsed) and its options as a form generated from the format's JSON
 * schema; converting again with changed options re-reads the file's sheets.
 */
import { type ReactNode, useEffect, useState } from "react";
import type { JsonSchema } from "../lib/admin";
import type { LabConversion, LabFormat, LabNote } from "../lib/lab-formats";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type Values = Record<string, unknown>;

const times = (n: number) => (n > 1 ? ` (×${n.toLocaleString()})` : "");

function NoteList({ notes, className }: { notes: LabNote[]; className: string }) {
  return (
    <ul className={`list-disc space-y-0.5 pl-5 ${className}`}>
      {notes.map((note) => (
        <li key={`${note.level}|${note.kind}|${note.message}`}>
          {note.message}
          {times(note.count)}
        </li>
      ))}
    </ul>
  );
}

/** A nullable property (`anyOf` with `{type: "null"}`) as its other branch. */
function unwrap(schema: JsonSchema): { schema: JsonSchema; optional: boolean } {
  if (!schema.anyOf) return { schema, optional: false };
  const kept = schema.anyOf.filter((branch) => branch.type !== "null");
  return { schema: { ...kept[0], ...schema, anyOf: undefined }, optional: true };
}

const enumLabels = (schema: JsonSchema): Record<string, string> =>
  ((schema as Record<string, unknown>)["x-enum-labels"] as Record<string, string>) ?? {};

const inputClass = "w-full rounded-md border border-gray-300 bg-surface px-2 py-1 text-[13px]";

function OptionField({
  name,
  property,
  value,
  onChange,
}: {
  name: string;
  property: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { schema, optional } = unwrap(property);
  const labels = enumLabels(property);
  const title = schema.title ?? name;
  let control: ReactNode;
  if (schema.enum) {
    control = (
      <select
        className={inputClass}
        value={String(value ?? "")}
        onChange={(e) => onChange(schema.enum?.find((v) => String(v) === e.target.value))}
      >
        {schema.enum.map((v) => (
          <option key={String(v)} value={String(v)}>
            {labels[String(v)] ?? (String(v) || "(none)")}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "array" && schema.items?.enum) {
    const picked = Array.isArray(value) ? (value as unknown[]) : [];
    control = (
      <span className="flex flex-wrap gap-x-3 gap-y-0.5">
        {schema.items.enum.map((v) => (
          <label key={String(v)} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={picked.includes(v)}
              onChange={(e) =>
                onChange(e.target.checked ? [...picked, v] : picked.filter((p) => p !== v))
              }
            />
            <span title={labels[String(v)]}>{String(v)}</span>
          </label>
        ))}
      </span>
    );
  } else if (schema.type === "boolean") {
    control = (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4"
      />
    );
  } else if (schema.type === "number" || schema.type === "integer") {
    control = (
      <input
        type="number"
        className={inputClass}
        value={value === undefined || value === null ? "" : String(value)}
        step={schema.type === "integer" ? 1 : "any"}
        min={schema.minimum}
        max={schema.maximum}
        onChange={(e) =>
          onChange(e.target.value === "" ? (optional ? null : undefined) : Number(e.target.value))
        }
      />
    );
  } else {
    control = (
      <input
        type="text"
        className={inputClass}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is one of the inputs above
    <label className="block">
      <span className="block text-xs font-semibold text-gray-700">{title}</span>
      {control}
      {schema.description && (
        <span className="mt-0.5 block text-xs text-gray-500">{schema.description}</span>
      )}
    </label>
  );
}

/** The options form: a draft of the values the contributor set over the
 * schema's defaults; "Convert again" sends only the set ones. */
function OptionsForm({
  schema,
  options,
  onConvert,
  busy,
}: {
  schema: JsonSchema;
  options: Values;
  onConvert: (options: Values) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<Values>(options);
  useEffect(() => setDraft(options), [options]);
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) return null;
  const changed = JSON.stringify(draft) !== JSON.stringify(options);
  const shown = (name: string, property: JsonSchema) =>
    name in draft ? draft[name] : (property.default ?? null);
  return (
    <form
      className="mt-2"
      onSubmit={(event) => {
        event.preventDefault();
        onConvert(draft);
      }}
    >
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {properties.map(([name, property]) => (
          <OptionField
            key={name}
            name={name}
            property={property}
            value={shown(name, property)}
            onChange={(value) => {
              const next = { ...draft };
              if (value === undefined) delete next[name];
              else next[name] = value;
              setDraft(next);
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !changed}>
          Convert again
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || Object.keys(options).length === 0}
          onClick={() => onConvert({})}
        >
          Reset to defaults
        </Button>
      </div>
    </form>
  );
}

export function LabConversionPanel({
  format,
  result,
  options,
  companionOf,
  onOptions,
  busy = false,
}: {
  format: LabFormat | undefined;
  /** The conversion (null when it failed or the file is a companion). */
  result: LabConversion | null;
  /** The options the contributor set. */
  options: Values;
  /** The file whose conversion reads this one. */
  companionOf: string | null;
  /** Convert again with these options. */
  onOptions: (options: Values) => void;
  busy?: boolean;
}) {
  if (companionOf) {
    return (
      <p className="mt-2 rounded-md bg-gray-50 px-3 py-2 text-[13px] text-gray-700">
        Read with <span className="font-semibold">{companionOf}</span>
        {format ? ` (${format.label})` : ""}; its rows are in that file's tables.
      </p>
    );
  }
  const notes = result?.notes ?? [];
  const hints = notes.filter((n) => n.kind === "hint");
  const errors = notes.filter((n) => n.kind === "converter" && n.level === "error");
  const warnings = notes.filter((n) => n.kind === "converter" && n.level === "warning");
  const infos = notes.filter((n) => n.kind === "converter" && n.level === "info");
  const defaults = notes.filter((n) => n.kind === "default");
  const chain = [...(result?.hierarchy ?? [])]
    .reverse()
    .map((h) => `${h.count.toLocaleString()} ${h.table}`)
    .join(" → ");
  const tool = result?.tool;
  return (
    <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] text-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">
          {result ? `Converted as ${result.label}` : `Convert as ${format?.label ?? "a lab file"}`}
        </span>
        {tool?.name && (
          <span className="text-gray-600">
            with {[tool.name, tool.version].filter(Boolean).join(" ")}
            {tool.function ? ` (${tool.function})` : ""}
          </span>
        )}
        {errors.length > 0 && <Badge variant="danger">{errors.length} Converter Error(s)</Badge>}
        {warnings.length > 0 && (
          <Badge variant="warning">{warnings.length} Converter Warning(s)</Badge>
        )}
      </div>
      {result && result.files.length > 1 && (
        <p className="mt-0.5 text-gray-600">Read together: {result.files.join(", ")}</p>
      )}
      {chain && <p className="mt-1">{chain}</p>}
      {hints.length > 0 && <NoteList notes={hints} className="mt-1 font-semibold text-amber-900" />}
      {errors.length > 0 && <NoteList notes={errors} className="mt-1 text-red-800" />}
      {warnings.length > 0 && <NoteList notes={warnings} className="mt-1 text-amber-900" />}
      {defaults.length > 0 && (
        <div className="mt-1">
          <span className="font-semibold">Defaults used:</span>
          <NoteList notes={defaults} className="text-gray-700" />
        </div>
      )}
      {infos.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer font-semibold">
            {infos.length} other converter message(s)
          </summary>
          <NoteList notes={infos} className="mt-1 text-gray-700" />
        </details>
      )}
      {format && (
        <details className="mt-2" open={!result || hints.length > 0}>
          <summary className="cursor-pointer font-semibold">Converter options</summary>
          {format.description && <p className="mt-1 text-gray-600">{format.description}</p>}
          <OptionsForm
            schema={format.options_schema}
            options={options}
            onConvert={onOptions}
            busy={busy}
          />
        </details>
      )}
    </div>
  );
}
