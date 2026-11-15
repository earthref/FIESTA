// The node tile (components/node-mark.tsx): a node's one-color logo SVG
// (node YAML `node.logo`, `logo_style`, `logo_label`) drawn in a framed square
// with the node's name under it. This module holds the geometry, the ink color,
// the SVG sanitizer and the favicon; the component draws the same layout in HTML.
//
// Tile spec (approved 2026-11-14):
// - frame: s x s, 1px --er-line border, 1px inset ring in the node color,
//   radius max(3, round(0.06 s)); white in light mode. In dark mode (2026-11-15)
//   the page tile has no background (the surface shows through) and draws in
//   the dark-mode node ink (lib/config.ts darkInk); the favicon stays white.
// - ink: the node color darkened (RGB x 0.94 per step) to 4.5:1 on white; the
//   ring keeps the node color.
// - named (s >= 44 and a label): drawing area 0.62 s from 0.065 s down, the
//   label 800-weight under it, 0.065 s from the bottom; unnamed: 0.72 s, centered
//   (the node header is unnamed at 58 px: its title names the node).
// - a drawing may be strokes, fills or both; an even-odd fill's holes are
//   transparent, so they show the tile's ground (white, or the dark surface).
// - the drawing keeps its viewBox aspect, centered in the inner (s - 2) box;
//   stroke-width scales so strokes read alike at every size.
import type { LogoStyle } from "./types";

const SERIF = 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';
export const TILE_FONT = 'Inter, "Open Sans", "Helvetica Neue", Arial, Helvetica, sans-serif';
const SVG_NS = "http://www.w3.org/2000/svg";
const LINE = "rgba(34, 36, 38, 0.15)"; // --er-line (light), for the favicon

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// --- color ---------------------------------------------------------------------

function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  const full = /^[0-9a-f]{3}$/i.test(hex)
    ? [...hex].map((c) => c + c).join("")
    : /^[0-9a-f]{6}$/i.test(hex)
      ? hex
      : null;
  if (!full) return null;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** Contrast ratio of a color against white. */
export function contrastOnWhite(color: string): number {
  const rgb = parseHex(color);
  return rgb ? 1.05 / (luminance(rgb) + 0.05) : 21;
}

/** The tile's ink: the node color darkened until it reads at 4.5:1 on white. */
export function tileInk(color: string): string {
  let rgb: number[] | null = parseHex(color);
  if (!rgb) return color;
  for (let step = 0; step < 60 && 1.05 / (luminance(rgb) + 0.05) < 4.5; step++) {
    rgb = rgb.map((c) => c * 0.94);
  }
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

// --- the SVG ---------------------------------------------------------------------

// The allowlist of fiesta/backend/fiesta/svg.py: the API already sanitizes a
// node's logo; this runs again on anything inlined, including an admin's
// not-yet-uploaded file in the logo editor's preview.
const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);
const ATTRIBUTES = new Set([
  "viewBox",
  "preserveAspectRatio",
  "x",
  "y",
  "width",
  "height",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "d",
  "pathLength",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "vector-effect",
]);
const UNSAFE_VALUE = /url\s*\(|javascript:|data:|expression\s*\(|[<>]/i;

interface CleanNode {
  tag: string;
  attrs: Record<string, string>;
  children: CleanNode[];
}

/** A logo SVG, sanitized and measured. */
export interface ParsedLogo {
  root: CleanNode;
  /** viewBox [x, y, width, height]. */
  viewBox: [number, number, number, number];
  /** The root's stroke-width as drawn (SVG default 1). */
  strokeWidth: number;
}

function clean(element: Element): CleanNode {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    if (!attr.namespaceURI && ATTRIBUTES.has(attr.name) && !UNSAFE_VALUE.test(attr.value)) {
      attrs[attr.name] = attr.value;
    }
  }
  const children = Array.from(element.children)
    .filter((child) => child.namespaceURI === SVG_NS && ELEMENTS.has(child.localName))
    .filter((child) => child.localName !== "svg")
    .map(clean);
  return { tag: element.localName, attrs, children };
}

const parsed = new Map<string, ParsedLogo | null>();

/** Parse and sanitize a logo SVG; null when it is not one (cached by text). */
export function parseLogo(svg: string | null | undefined): ParsedLogo | null {
  if (!svg) return null;
  if (parsed.has(svg)) return parsed.get(svg) ?? null;
  let result: ParsedLogo | null = null;
  try {
    if (!/<!DOCTYPE|<!ENTITY/i.test(svg)) {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const el = doc.documentElement;
      if (
        el.namespaceURI === SVG_NS &&
        el.localName === "svg" &&
        !doc.querySelector("parsererror")
      ) {
        const root = clean(el);
        let box = (root.attrs.viewBox ?? "")
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        if (box.length !== 4) {
          const w = Number.parseFloat(root.attrs.width ?? "");
          const h = Number.parseFloat(root.attrs.height ?? "");
          box = [0, 0, w, h];
        }
        delete root.attrs.width;
        delete root.attrs.height;
        if (box.every(Number.isFinite) && (box[2] ?? 0) > 0 && (box[3] ?? 0) > 0) {
          root.attrs.viewBox = box.join(" ");
          result = {
            root,
            viewBox: box as [number, number, number, number],
            strokeWidth: Number.parseFloat(root.attrs["stroke-width"] ?? "") || 1,
          };
        }
      }
    }
  } catch {
    result = null;
  }
  parsed.set(svg, result);
  return result;
}

function recolor(value: string | undefined): string | undefined {
  return value === undefined || value === "none" ? value : "currentColor";
}

/** Serialize a cleaned node; in a tile every paint becomes currentColor and
 * only the root carries a stroke-width (set from the tile size). */
function serialize(node: CleanNode, tile: boolean, rootAttrs?: Record<string, string>): string {
  const attrs = { ...node.attrs };
  if (tile) {
    for (const paint of ["fill", "stroke"] as const) {
      const value = recolor(attrs[paint]);
      if (value === undefined) delete attrs[paint];
      else attrs[paint] = value;
    }
    if (!rootAttrs) delete attrs["stroke-width"];
  }
  if (rootAttrs) Object.assign(attrs, rootAttrs);
  const text = Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join("");
  const xmlns = rootAttrs ? ` xmlns="${SVG_NS}"` : "";
  const inner = node.children.map((child) => serialize(child, tile)).join("");
  return `<${node.tag}${xmlns}${text}>${inner}</${node.tag}>`;
}

// --- geometry -----------------------------------------------------------------

export interface TileLayout {
  size: number;
  radius: number;
  /** The label shown, or "" when the tile is too small for it. */
  label: string;
  fontSize: number;
  /** px from the padding box's bottom edge to the label's; null: centered. */
  labelBottom: number | null;
  /** The drawing box inside the padding box (px), when there is a drawing. */
  drawing: { left: number; top: number; width: number; height: number } | null;
  /** The root stroke-width that draws the logo's strokes at this size. */
  strokeWidth: number;
}

/** Where the drawing and the name sit in an s x s tile. */
export function tileLayout(size: number, label: string, logo: ParsedLogo | null): TileLayout {
  const s = size;
  const inner = s - 2; // inside the 1px border: positions are padding-box relative
  const radius = Math.max(3, Math.round(0.06 * s));
  const named = s >= 44 && label.length > 0;
  const fit = (scale: number) => (0.86 * s) / (Math.max(label.length, 3) * scale);
  if (!logo) {
    // No drawing: the name alone, larger and centered.
    return {
      size,
      radius,
      label,
      fontSize: Math.min(0.34 * s, fit(0.8)),
      labelBottom: null,
      drawing: null,
      strokeWidth: 0,
    };
  }
  const g = named ? 0.62 * s : 0.72 * s;
  const areaTop = named ? 0.065 * s : (inner - g) / 2;
  const [, , vw, vh] = logo.viewBox;
  const aspect = vw / vh;
  const width = Math.min(0.86 * s, g * aspect);
  const height = width / aspect;
  const factor = g >= 40 ? 0.7 : g >= 24 ? 0.9 : 1.4;
  return {
    size,
    radius,
    label: named ? label : "",
    fontSize: Math.min(0.145 * s, fit(0.66)),
    labelBottom: 0.065 * s,
    drawing: { left: (inner - width) / 2, top: areaTop + (g - height) / 2, width, height },
    strokeWidth: (logo.strokeWidth * factor * (g * vw)) / (24 * width),
  };
}

/** The logo as standalone SVG markup for one tile (tile) or as drawn (full). */
export function logoMarkup(logo: ParsedLogo, style: LogoStyle, strokeWidth?: number): string {
  if (style === "full") return serialize(logo.root, false, {});
  const root: Record<string, string> = {};
  if (logo.root.attrs.fill === undefined) root.fill = "currentColor"; // SVG's default black fill
  if (strokeWidth !== undefined) root["stroke-width"] = String(+strokeWidth.toFixed(4));
  return serialize(logo.root, true, root);
}

// --- favicon ------------------------------------------------------------------

export interface TileSource {
  key: string;
  color: string;
  logo_svg?: string | null;
  logo_style?: LogoStyle | null;
  logo_label?: string | null;
}

/** The unnamed node tile (or the full-style logo) as a standalone SVG. */
export function tileSvg(node: TileSource, size = 32): string {
  const logo = parseLogo(node.logo_svg);
  const label = node.logo_label || node.key;
  if (logo && node.logo_style === "full") {
    const [x, y, w, h] = logo.viewBox;
    const side = Math.max(w, h);
    const view = `${x - (side - w) / 2} ${y - (side - h) / 2} ${side} ${side}`;
    return logoMarkup(logo, "full")
      .replace(/viewBox="[^"]*"/, `viewBox="${view}"`)
      .replace(/^<svg /, `<svg color="${escapeXml(tileInk(node.color))}" `);
  }
  const layout = tileLayout(size, logo ? "" : label, logo);
  const ink = escapeXml(tileInk(node.color));
  const color = escapeXml(node.color);
  const r = layout.radius;
  let body = "";
  if (logo && layout.drawing) {
    const d = layout.drawing;
    const markup = logoMarkup(logo, "tile", layout.strokeWidth).replace(
      /^<svg /,
      `<svg x="${1 + d.left}" y="${1 + d.top}" width="${d.width}" height="${d.height}" color="${ink}" `,
    );
    body = markup;
  } else {
    body =
      `<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family='${TILE_FONT}' font-weight="800" font-size="${layout.fontSize}" fill="${ink}">` +
      `${escapeXml(label)}</text>`;
  }
  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${size} ${size}">` +
    `<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}" fill="#fff" stroke="${LINE}"/>` +
    `<rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" rx="${Math.max(r - 1, 0)}" fill="none" stroke="${color}"/>` +
    `${body}</svg>`
  );
}

/** The FIESTA portal's letter mark (unchanged): the key's first letter, serif
 * bold in the color, in a white rounded square outlined in that color. */
export function letterLogoUrl(key: string, color: string): string {
  const letter = escapeXml(key.charAt(0) || "F");
  const fill = escapeXml(color);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    `<rect x="1" y="1" width="30" height="30" rx="4" fill="#fff" stroke="${fill}" stroke-width="2"/>` +
    `<text x="16" y="17" text-anchor="middle" dominant-baseline="central" font-family='${SERIF}' ` +
    `font-weight="700" font-size="24" fill="${fill}">${letter}</text>` +
    "</svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Point the page's favicon at a node's tile, or at the FIESTA portal's
 * letter mark for an identity without a logo field (lib/portals.ts FIESTA_PORTAL). */
export function setNodeFavicon(node: TileSource): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href =
    "logo_svg" in node
      ? `data:image/svg+xml,${encodeURIComponent(tileSvg(node))}`
      : letterLogoUrl(node.key, node.color);
}
