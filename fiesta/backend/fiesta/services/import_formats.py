"""Import formats: files the upload page's import step converts to the node's
text format on the server, supplied by plugins (FiestaPlugin.import_formats;
MagIC's lab instrument formats are the pmag-lab-formats plugin). The core
lists them, asks each which files it recognises, and runs a conversion in a
temporary directory; the converted text then goes through the import step
like a node text file the contributor uploaded. Nothing is stored here: the
upload keeps the original files and the report this returns as attachments.
"""

import json
import logging
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from fiesta.domain.parse import ParseError, parse_text
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import (
    FiestaPlugin,
    ImportConversionError,
    ImportFormat,
    ImportInput,
    ImportNote,
)

log = logging.getLogger(__name__)

#: The most of a file's start a sniffer sees.
HEAD_BYTES = 16384
#: The confidence at which the import step picks a format by itself.
AUTO_PICK = 0.8


@dataclass
class UploadedFile:
    name: str
    data: bytes


def import_formats(node: NodeConfig) -> dict[str, tuple[FiestaPlugin, ImportFormat]]:
    """The active plugins' import formats by key."""
    from fiesta.plugins import active_plugins

    formats: dict[str, tuple[FiestaPlugin, ImportFormat]] = {}
    for plugin in active_plugins(node):
        for fmt in plugin.import_formats(node):
            if not fmt.key:
                raise ValueError(f"plugin {plugin.name!r} supplies an import format with no key")
            if fmt.key in formats:
                raise ValueError(f"two plugins supply the import format {fmt.key!r}")
            formats[fmt.key] = (plugin, fmt)
    return formats


def describe(node: NodeConfig) -> list[dict]:
    """What the import step's file-type menu and options form need."""
    return [
        {
            "key": key,
            "label": fmt.label or key,
            "description": fmt.description,
            "extensions": list(fmt.extensions),
            "multi_file": fmt.multi_file,
            "example": [path.name for path in fmt.example],
            "plugin": plugin.name,
            "options_schema": fmt.options_schema(),
        }
        for key, (plugin, fmt) in import_formats(node).items()
    ]


def example_file(node: NodeConfig, key: str, name: str) -> Path:
    """One of a format's example files, by name. KeyError for an unknown
    format or a name that is not one of its example files."""
    _plugin, fmt = import_formats(node)[key]
    for path in fmt.example:
        if path.name == name and path.is_file():
            return path
    raise KeyError(name)


def sniff(node: NodeConfig, files: list[UploadedFile]) -> list[dict]:
    """Per file (by its name and first HEAD_BYTES bytes), the format most
    sure of it and how sure, and, for a file a confident multi-file format's
    conversion reads with another (a CIT .sam file's specimen files), the
    name of that file (`companion_of`)."""
    formats = import_formats(node)
    names = [f.name for f in files]
    results = []
    for f in files:
        best_key, best = None, 0.0
        for key, (_, fmt) in formats.items():
            try:
                confidence = float(fmt.sniff(f.name, f.data[:HEAD_BYTES]))
            except Exception:  # a sniffer's bug must not break the import step
                log.exception("import format %s: sniff failed on %s", key, f.name)
                continue
            if confidence > best:
                best_key, best = key, confidence
        results.append(
            {
                "name": f.name,
                "format": best_key,
                "confidence": round(min(best, 1.0), 3),
                "companion_of": None,
            }
        )
    for f, result in zip(files, results, strict=True):
        if result["format"] is None or result["confidence"] < AUTO_PICK:
            continue
        fmt = formats[result["format"]][1]
        if not fmt.multi_file:
            continue
        others = [name for name in names if name != f.name]
        for other in fmt.companions(f.name, f.data[:HEAD_BYTES], others):
            if other not in names:
                continue
            companion = results[names.index(other)]
            # A file confidently in a format of its own, or already claimed, stays so.
            if companion["companion_of"] or (
                companion["confidence"] >= AUTO_PICK and companion["format"] != result["format"]
            ):
                continue
            companion.update(format=result["format"], companion_of=f.name)
    return results


def _safe_name(name: str) -> str:
    base = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if base in ("", ".", "..") or "\x00" in base:
        raise ImportConversionError(f"{name!r} is not a usable file name")
    return base


def _note_line(note: ImportNote) -> str:
    times = f" (x{note.count})" if note.count > 1 else ""
    return f"  [{note.level}] {note.message}{times}"


def report_text(result: dict) -> str:
    """The conversion report kept beside the original files in the upload:
    the converter and its version, the options, the counts and the notes."""
    tool = result["tool"]
    hierarchy = " -> ".join(f"{h['count']} {h['table']}" for h in reversed(result["hierarchy"]))
    lines = [
        f"{result['label']} conversion (plugin {result['plugin']})",
        "Converter: "
        + " ".join(v for v in (tool.get("name"), tool.get("version"), tool.get("function")) if v),
        f"Files: {', '.join(result['files'])}",
        f"Options: {json.dumps(result['options'], sort_keys=True)}",
        f"Options set by the contributor: {', '.join(result['options_set']) or '(none)'}",
        "Tables: " + ", ".join(f"{n} {t}" for t, n in result["tables"].items()),
    ]
    if hierarchy:
        lines.append(f"Hierarchy: {hierarchy}")
    if result["notes"]:
        lines.append("Notes:")
        lines += [_note_line(ImportNote(**note)) for note in result["notes"]]
    return "\n".join(lines) + "\n"


def convert(node: NodeConfig, key: str, files: list[UploadedFile], options: dict) -> dict:
    """`files` (the first the one read as `key`, the rest its companions)
    converted with `options`. Raises KeyError for a format the node does not
    have, pydantic's ValidationError for options that do not fit its schema,
    and ImportConversionError when the conversion fails."""
    plugin, fmt = import_formats(node)[key]
    parsed_options = fmt.Options.model_validate(options)
    names = [_safe_name(f.name) for f in files]
    if len(set(names)) != len(names):
        raise ImportConversionError("two of the files have the same name")
    with tempfile.TemporaryDirectory(prefix="fiesta-import-") as tmp:
        directory, work_dir = Path(tmp) / "in", Path(tmp) / "out"
        directory.mkdir()
        work_dir.mkdir()
        for name, f in zip(names, files, strict=True):
            (directory / name).write_bytes(f.data)
        try:
            result = fmt.convert(node, ImportInput(directory, names, work_dir), parsed_options)
        except ImportConversionError:
            raise
        except Exception as exc:
            log.exception("import format %s: conversion failed", key)
            message = f"the {fmt.label or key} conversion failed: {exc}"
            raise ImportConversionError(message) from None
    try:
        parsed = parse_text(result.text)
    except ParseError as exc:
        raise ImportConversionError(
            f"the converted text cannot be read: {exc}", result.notes
        ) from None
    tables = {table: len(rows) for table, rows in parsed.tables.items() if rows}
    if not tables:
        raise ImportConversionError("the conversion produced no rows", result.notes)
    out = {
        "format": key,
        "label": fmt.label or key,
        "plugin": plugin.name,
        "files": names,
        "tool": result.tool,
        "options": parsed_options.model_dump(mode="json"),
        "options_set": sorted(parsed_options.model_fields_set),
        "text": result.text,
        "tables": tables,
        "hierarchy": [
            {"table": table, "count": tables[table]} for table in node.hierarchy if table in tables
        ],
        "notes": [asdict(note) for note in result.notes],
    }
    out["report_text"] = report_text(out)
    return out
