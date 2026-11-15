// The Settings tab's Logo fieldset: upload the node's logo SVG (sanitized by
// the API into <slug>/assets/logo.svg on save), choose how it shows (tile or
// full) and the name on the tile, with a live preview of the node tile.

import { useQuery } from "@tanstack/react-query";
import { type DragEvent, useRef, useState } from "react";
import { type AdminNode, adminKeys, readFile } from "../../lib/admin";
import { inkColor } from "../../lib/config";
import { contrastOnWhite, parseLogo, tileInk, tileSvg } from "../../lib/node-logo";
import type { LogoStyle } from "../../lib/types";
import { cx } from "../../lib/utils";
import { NodeMark } from "../node-mark";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field } from "./admin-ui";

/** A chosen, not yet uploaded logo file. */
export interface LogoUpload {
  name: string;
  text: string;
}

export interface LogoFields {
  color: string;
  logo_style: LogoStyle;
  logo_label: string;
}

const MAX_BYTES = 100 * 1024; // fiesta/backend/fiesta/svg.py MAX_BYTES
const LABEL_MAX = 12;

export function LogoFieldset({
  node,
  logo,
  form,
  update,
  file,
  setFile,
}: {
  node: AdminNode;
  /** `node.logo` in the draft (a path under <slug>/assets/). */
  logo: string | null;
  form: LogoFields;
  update: (patch: Partial<LogoFields>) => void;
  file: LogoUpload | null;
  setFile: (file: LogoUpload | null) => void;
}) {
  const path = logo ? `${node.slug}/assets/${logo}` : null;
  const current = useQuery({
    queryKey: [...adminKeys.node(node.slug), "file", path],
    queryFn: () => readFile(node.slug, path as string),
    enabled: Boolean(path),
  });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const svg =
    file?.text ?? (current.data?.encoding === "utf-8" ? current.data.content : null) ?? null;
  const label = form.logo_label.trim() || node.key;
  const color = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(form.color) ? form.color : "#666666";
  const ink = tileInk(color);
  const ratio = contrastOnWhite(color);

  async function choose(chosen: File | undefined) {
    setError(null);
    if (!chosen) return;
    if (chosen.size > MAX_BYTES) {
      setError(`${chosen.name} is ${Math.ceil(chosen.size / 1024)} KB; the limit is 100 KB.`);
      return;
    }
    const text = await chosen.text();
    if (!parseLogo(text)) {
      setError(`${chosen.name} is not an SVG with a viewBox and basic shapes.`);
      return;
    }
    setFile({ name: chosen.name, text });
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  }

  const mark = (size: number, named = true) => (
    <NodeMark
      size={size}
      color={color}
      label={label}
      named={named}
      svg={svg}
      style={form.logo_style}
    />
  );
  // The favicon: the unnamed tile on its white badge in either color scheme.
  const favicon = `data:image/svg+xml,${encodeURIComponent(
    tileSvg({
      key: node.key,
      color,
      logo_svg: svg,
      logo_style: form.logo_style,
      logo_label: label,
    }),
  )}`;

  return (
    <fieldset className="rounded-md border border-gray-200 p-3">
      <legend className="px-1 text-xs font-semibold text-gray-700">Logo</legend>
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div className="min-w-0 space-y-3">
          <div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cx(
                "w-full cursor-pointer rounded-md border border-dashed px-3 py-4 text-center text-sm text-gray-600",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                dragging ? "border-node bg-node-soft" : "border-gray-300 hover:bg-gray-50",
              )}
            >
              <strong className="text-gray-800">Choose an SVG</strong> or drop one here
            </button>
            {file && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setFile(null)}>
                Keep the current logo
              </Button>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".svg,image/svg+xml"
              className="hidden"
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <p className="mt-2 text-xs text-gray-500">
              {file ? (
                <>
                  New: <strong>{file.name}</strong>, saved as {node.slug}/assets/logo.svg with the
                  draft.
                </>
              ) : path ? (
                <>Current: {path}</>
              ) : (
                <>No logo: the tile shows the name alone.</>
              )}{" "}
              One color, drawn with <code>currentColor</code>, with a viewBox cropped to the
              drawing; up to 100 KB. Only basic shapes are kept (no text, images, scripts or
              styles).
            </p>
            {error && <p className="mt-1 text-xs text-danger">{error}</p>}
          </div>

          <div className="text-sm">
            <span className="mb-1 block text-xs font-semibold text-gray-700">Show it as</span>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="logo_style"
                checked={form.logo_style === "tile"}
                onChange={() => update({ logo_style: "tile" })}
                className="mt-0.5"
              />
              <span>
                <strong>Tile</strong> (recommended): framed, drawn in the node color, with the name
                under it
              </span>
            </label>
            <label className="mt-1 flex items-start gap-2">
              <input
                type="radio"
                name="logo_style"
                checked={form.logo_style === "full"}
                onChange={() => update({ logo_style: "full" })}
                className="mt-0.5"
              />
              <span>
                <strong>Full</strong>: the SVG as drawn, in its own colors, without frame or name
              </span>
            </label>
          </div>

          <Field
            label="Name on the tile"
            hint={`Empty shows the key (${node.key}). Shown on tiles 44px and larger.`}
          >
            <Input
              value={form.logo_label}
              placeholder={node.key}
              maxLength={LABEL_MAX}
              onChange={(event) => update({ logo_label: event.target.value })}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-semibold text-gray-700">Preview</span>
          <div className="flex items-end gap-3">
            {mark(128)}
            {/* The page header's tile: unnamed, the title beside it names the node. */}
            {mark(58, false)}
            {mark(24)}
            <img src={favicon} alt="Favicon" title="Favicon" width={32} height={32} />
          </div>
          {/* The portal home's node card (components/icon-button.tsx, card variant). */}
          <div
            className="bg-panel-soft text-center"
            style={{
              width: 200,
              fontSize: 14,
              padding: "0.875em",
              borderRadius: "0.28571429rem",
              boxShadow: `inset 0 0 0 1px ${color}`,
            }}
          >
            <div className="flex justify-center" style={{ marginBottom: "0.5rem" }}>
              {mark(88)}
            </div>
            <div
              className="font-bold"
              style={{
                color: inkColor(color),
                fontSize: "1.28571429em",
                lineHeight: "1.28571429em",
              }}
            >
              {node.key}
            </div>
            <div className="truncate text-ink-secondary" style={{ lineHeight: 1.2 }}>
              {node.title}
            </div>
          </div>
          <p className="max-w-[16rem] text-xs text-gray-600">
            {form.logo_style === "full"
              ? "Full: the logo keeps its own colors."
              : ratio >= 4.5
                ? `The node color passes 4.5:1 on white (${ratio.toFixed(1)}:1).`
                : `Too light for text (${ratio.toFixed(1)}:1): the drawing and name use ${ink}.`}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
