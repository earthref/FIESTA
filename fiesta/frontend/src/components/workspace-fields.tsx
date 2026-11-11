import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ContributionOut, Vocabularies, WorkspaceField } from "../lib/types";
import { cx } from "../lib/utils";
import { ErrorMessage } from "./error-message";
import { Icon } from "./ui/icon";

// The private workspace's per-node editable columns (node YAML
// `workspace.fields`; legacy MagIC private_contributions.jsx Labs, Funding,
// Supplement and Description), each saved into the contribution's file as a
// new revision. Cells use the data model's delimiters: a List is joined by
// ":", a Dictionary is "title[url]" entries joined by ";".

interface Link {
  title: string;
  url: string;
}

const LIST_DELIMITER = ":";
const LINKS_DELIMITER = ";";

function parseList(cell: string): string[] {
  return cell
    .split(LIST_DELIMITER)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseLinks(cell: string): Link[] {
  return cell
    .split(LINKS_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf("[");
      if (at < 0) return { title: entry, url: "" };
      return {
        title: entry.slice(0, at).trim(),
        url: entry
          .slice(at + 1)
          .replace(/\]$/, "")
          .trim(),
      };
    });
}

function formatLinks(links: Link[]): string {
  return links
    .filter((link) => link.title.trim() || link.url.trim())
    .map((link) => `${link.title.trim()}[${link.url.trim()}]`)
    .join(LINKS_DELIMITER);
}

/** Attached-segment style shared with the private workspace's cards. */
const segment = {
  width: "calc(100% + 2px)",
  marginLeft: -1,
  padding: "0.5em",
  border: "1px solid var(--er-line)",
  borderTop: "none",
} as const;

const labelClass = (warn: boolean) =>
  cx(
    "flex shrink-0 items-center whitespace-nowrap rounded-l-sm px-[0.8em] text-[12px] font-bold",
    warn ? "bg-danger text-white" : "bg-panel-strong text-gray-700",
  );

const inputClass =
  "min-w-0 flex-1 border border-gray-300 bg-surface px-2 py-1 text-[13px] text-gray-900 placeholder:text-ink-faint focus:border-node focus:outline-hidden";

function SaveButton({
  dirty,
  pending,
  onClick,
}: {
  dirty: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!dirty || pending}
      className={cx(
        "shrink-0 rounded-r-sm px-2.5 py-1 text-[12px] font-medium whitespace-nowrap disabled:cursor-not-allowed",
        dirty
          ? "bg-danger text-white hover:bg-danger-dark disabled:opacity-60"
          : "border border-l-0 border-gray-300 bg-surface text-gray-700 opacity-50",
      )}
    >
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

/** A searchable multi-select over a vocabulary's items (legacy Semantic
 * `Dropdown multiple selection search`), or free entry without one. */
function MultiSelect({
  id,
  value,
  options,
  placeholder,
  warn,
  onChange,
}: {
  id: string;
  value: string[];
  options: string[];
  placeholder: string;
  warn: boolean;
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const chosen = new Set(value);
    return options
      .filter((option) => !chosen.has(option) && option.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [options, text, value]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const add = (item: string) => {
    const trimmed = item.trim();
    if (trimmed && !value.includes(trimmed)) onChange([...value, trimmed]);
    setText("");
    setActive(0);
  };

  return (
    <div
      ref={boxRef}
      className={cx(
        "relative flex min-w-0 flex-1 flex-wrap items-center gap-1 border bg-surface px-1 py-0.5",
        warn ? "border-danger" : "border-gray-300",
      )}
    >
      {value.map((item) => (
        <span
          key={item}
          className="inline-flex items-center gap-1 rounded-sm bg-panel-strong px-1.5 py-0.5 text-[12px] text-gray-800"
        >
          {item}
          <button
            type="button"
            onClick={() => onChange(value.filter((entry) => entry !== item))}
            aria-label={`Remove ${item}`}
            className="text-gray-500 hover:text-gray-900"
          >
            <Icon name="close" size="small" />
          </button>
        </span>
      ))}
      <input
        id={id}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        value={text}
        placeholder={value.length ? "" : placeholder}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (matches[active]) add(matches[active]);
            else if (!options.length) add(text);
          } else if (event.key === "Escape") {
            setOpen(false);
          } else if (event.key === "Backspace" && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        className="min-w-[8em] flex-1 bg-transparent px-1 py-0.5 text-[13px] text-gray-900 placeholder:text-ink-faint focus:outline-hidden"
      />
      {open && matches.length > 0 && (
        <div
          id={listId}
          role="listbox"
          className="absolute top-full left-0 z-20 mt-px max-h-64 w-full overflow-y-auto rounded-b-sm border border-gray-300 bg-surface shadow-md"
        >
          {matches.map((option, index) => (
            <div
              key={option}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                add(option);
              }}
              onMouseEnter={() => setActive(index)}
              className={cx(
                "cursor-pointer px-2 py-1 text-[13px] text-gray-800",
                index === active && "bg-panel-hover",
              )}
            >
              {option}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The editable fields' segments of one in-preparation contribution card. */
export function WorkspaceFields({
  contribution,
  fields,
  disabled,
}: {
  contribution: ContributionOut;
  fields: WorkspaceField[];
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const idPrefix = `field-${contribution.id}`;
  const cells = useQuery({
    queryKey: ["private", "fields", contribution.id, contribution.head_revision],
    queryFn: () => api<Record<string, string>>(`/private/contributions/${contribution.id}/fields`),
  });
  const needsVocabularies = fields.some((field) => field.vocabulary);
  const vocabularies = useQuery({
    queryKey: ["vocabularies", "controlled"],
    queryFn: () => api<Vocabularies>("/config/vocabularies/controlled"),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: needsVocabularies,
  });

  // Unsaved edits, by column (cleared once a save lands).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      api<ContributionOut>(`/private/contributions/${contribution.id}/fields`, {
        method: "PUT",
        json: {
          values,
          expected_revision: contribution.head_revision,
          request_key: crypto.randomUUID(),
        },
      }),
    onSuccess: async (_, values) => {
      setDrafts((prev) => {
        const next = { ...prev };
        for (const column of Object.keys(values)) delete next[column];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["private", "contributions"] });
    },
    onSettled: () => setSaving(null),
  });

  if (!contribution.head_revision || !cells.data) {
    return cells.error ? (
      <div style={segment}>
        <ErrorMessage error={cells.error} />
      </div>
    ) : null;
  }

  const saved = cells.data;
  const current = (column: string) => drafts[column] ?? saved[column] ?? "";
  const setDraft = (column: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [column]: value }));
  const commit = (column: string, value = current(column)) => {
    setSaving(column);
    save.mutate({ [column]: value });
  };
  const isDirty = (column: string) => column in drafts && drafts[column] !== (saved[column] ?? "");
  const busy = disabled || save.isPending;

  const lists = fields.filter((field) => field.kind === "list");
  const links = fields.filter((field) => field.kind === "links");
  const texts = fields.filter((field) => field.kind === "text");

  const optionsFor = (field: WorkspaceField) =>
    (field.vocabulary && vocabularies.data?.[field.vocabulary]?.items.map((item) => item.item)) ||
    [];

  return (
    <>
      {(lists.length > 0 || links.length > 0) && (
        <div className="flex flex-wrap items-center gap-y-2 bg-panel-hover" style={segment}>
          {lists.map((field) => {
            const value = parseList(current(field.column));
            const warn = field.required && value.length === 0;
            return (
              <div key={field.column} className="flex min-w-0" style={{ flex: "1 1 20em" }}>
                <label htmlFor={`${idPrefix}-${field.column}`} className={labelClass(warn)}>
                  {field.label}
                </label>
                <MultiSelect
                  id={`${idPrefix}-${field.column}`}
                  value={value}
                  options={optionsFor(field)}
                  placeholder={
                    field.placeholder ?? `Select one or more${field.required ? " (required)" : ""}`
                  }
                  warn={warn}
                  onChange={(next) => setDraft(field.column, next.join(LIST_DELIMITER))}
                />
                <SaveButton
                  dirty={isDirty(field.column) && !busy}
                  pending={saving === field.column}
                  onClick={() => commit(field.column)}
                />
              </div>
            );
          })}
          {links.map((field) => (
            <button
              key={field.column}
              type="button"
              disabled={busy}
              onClick={() => setDraft(field.column, `${current(field.column)}${LINKS_DELIMITER}[]`)}
              className="ml-2 inline-flex items-center gap-1 rounded-sm bg-node px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-white hover:bg-node-dark disabled:opacity-50"
            >
              <Icon name="plus" size="small" /> {field.label}
            </button>
          ))}
        </div>
      )}

      {links.map((field) => {
        // An added, not yet filled entry is "[]": keep it on screen as a row.
        const entries = current(field.column)
          .split(LINKS_DELIMITER)
          .filter((entry) => entry.trim())
          .map((entry) => (entry.trim() === "[]" ? { title: "", url: "" } : parseLinks(entry)[0]));
        const write = (next: Link[]) =>
          next.map((link) => `${link.title}[${link.url}]`).join(LINKS_DELIMITER);
        return entries.map((entry, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id; their order is their identity
            key={`${field.column}-${index}`}
            className="flex flex-wrap items-center gap-y-2 bg-panel-hover"
            style={segment}
          >
            <div className="flex min-w-0" style={{ flex: "1 1 16em" }}>
              <label htmlFor={`${idPrefix}-${field.column}-${index}`} className={labelClass(false)}>
                {field.label} Title
              </label>
              <input
                id={`${idPrefix}-${field.column}-${index}`}
                value={entry.title}
                disabled={busy}
                onChange={(event) => {
                  const next = [...entries];
                  next[index] = { ...entry, title: event.target.value };
                  setDraft(field.column, write(next));
                }}
                className={cx(inputClass, "rounded-r-sm")}
              />
            </div>
            <div className="ml-2 flex min-w-0" style={{ flex: "1 1 16em" }}>
              <label
                htmlFor={`${idPrefix}-${field.column}-${index}-url`}
                className={labelClass(false)}
              >
                URL
              </label>
              <input
                id={`${idPrefix}-${field.column}-${index}-url`}
                type="url"
                value={entry.url}
                disabled={busy}
                placeholder="https://…"
                onChange={(event) => {
                  const next = [...entries];
                  next[index] = { ...entry, url: event.target.value };
                  setDraft(field.column, write(next));
                }}
                className={inputClass}
              />
              <SaveButton
                dirty={isDirty(field.column) && !busy}
                pending={saving === field.column}
                onClick={() => commit(field.column, formatLinks(entries))}
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                commit(field.column, formatLinks(entries.filter((_, i) => i !== index)))
              }
              className="ml-2 rounded-sm border border-gray-300 bg-surface px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        ));
      })}

      {texts.length > 0 && (
        <div className="flex flex-wrap items-center gap-y-2 bg-panel-hover" style={segment}>
          {texts.map((field, index) => {
            const warn = field.required && !current(field.column).trim();
            return (
              <div
                key={field.column}
                className={cx("flex min-w-0", index > 0 && "ml-2")}
                style={{ flex: "1 1 20em" }}
              >
                <label htmlFor={`${idPrefix}-${field.column}`} className={labelClass(warn)}>
                  {field.label}
                </label>
                <input
                  id={`${idPrefix}-${field.column}`}
                  value={current(field.column)}
                  placeholder={field.placeholder ?? ""}
                  disabled={busy}
                  onChange={(event) => setDraft(field.column, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && isDirty(field.column)) commit(field.column);
                  }}
                  className={inputClass}
                />
                <SaveButton
                  dirty={isDirty(field.column) && !busy}
                  pending={saving === field.column}
                  onClick={() => commit(field.column)}
                />
              </div>
            );
          })}
        </div>
      )}

      {save.error && (
        <div style={{ ...segment, padding: 0 }}>
          <ErrorMessage error={save.error} />
        </div>
      )}
    </>
  );
}
