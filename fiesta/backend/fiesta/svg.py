"""Node logo SVG sanitizer.

A node's logo (`node.logo` in its YAML, a file under `configurations/<slug>/assets/`)
is inlined into the SPA's pages, so it must be inert: only basic shapes and
their presentation attributes survive. Everything else (script, style,
foreignObject, image, use, text, comments, event handlers, any url(...) or
external reference) is dropped, and a file that is not an SVG, carries a
DOCTYPE/entities or is over MAX_BYTES is refused.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

SVG_NS = "http://www.w3.org/2000/svg"
MAX_BYTES = 100 * 1024

ELEMENTS = {
    "svg",
    "g",
    "path",
    "circle",
    "ellipse",
    "rect",
    "line",
    "polyline",
    "polygon",
}

# Geometry and presentation attributes; nothing that can reference another
# resource (href, style, class, id, clip-path, mask, filter, marker-*).
ATTRIBUTES = {
    "viewBox",
    "width",
    "height",
    "preserveAspectRatio",
    "x",
    "y",
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
    "role",
    "aria-label",
    "aria-hidden",
}

# A value that could fetch or run something, wherever it appears.
_UNSAFE_VALUE = re.compile(r"url\s*\(|javascript:|data:|expression\s*\(|[<>]", re.IGNORECASE)
_NUMBER = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$")


class SvgError(ValueError):
    """The upload is not an acceptable logo SVG."""


def _local(tag: object) -> str | None:
    """`{ns}name` -> name for SVG-namespace (or un-namespaced) elements, else None."""
    if not isinstance(tag, str):  # comments and processing instructions
        return None
    if tag.startswith("{"):
        ns, _, name = tag[1:].partition("}")
        return name if ns == SVG_NS else None
    return tag


def _clean(source: ET.Element) -> ET.Element:
    name = _local(source.tag)
    assert name is not None
    out = ET.Element(f"{{{SVG_NS}}}{name}")
    for key, value in source.attrib.items():
        if key.startswith("{") or key not in ATTRIBUTES:
            continue  # namespaced (xlink:href, ...), event handlers, style, ...
        if _UNSAFE_VALUE.search(value):
            continue
        out.set(key, value)
    for child in source:
        if _local(child.tag) in ELEMENTS - {"svg"}:
            out.append(_clean(child))
    return out


def sanitize_svg(content: bytes) -> bytes:
    """The logo SVG reduced to the allowlist above, serialized as UTF-8.

    Raises SvgError when the file is too large, not well-formed XML, not an
    <svg> root, declares a DOCTYPE or entities, or has nothing left to draw."""
    if len(content) > MAX_BYTES:
        raise SvgError(
            f"the logo is {len(content) // 1024} KB; the limit is {MAX_BYTES // 1024} KB"
        )
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise SvgError("the logo is not a text SVG file") from None
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.IGNORECASE):
        raise SvgError("the logo may not declare a DOCTYPE or entities")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise SvgError(f"the logo is not well-formed SVG ({exc})") from None
    if _local(root.tag) != "svg":
        raise SvgError("the logo's root element is not <svg>")
    clean = _clean(root)
    if "viewBox" not in clean.attrib:
        width, height = (_NUMBER.match(clean.get(a, "")) for a in ("width", "height"))
        if not (width and height):
            raise SvgError("the logo needs a viewBox (or numeric width and height)")
        clean.set("viewBox", f"0 0 {width.group(1)} {height.group(1)}")
    if not len(clean):
        raise SvgError("the logo has no shapes left to draw (only basic shapes are kept)")
    # The tile sizes the drawing itself: drop fixed dimensions.
    for attr in ("width", "height"):
        clean.attrib.pop(attr, None)
    ET.register_namespace("", SVG_NS)
    return ET.tostring(clean, encoding="unicode").encode()
