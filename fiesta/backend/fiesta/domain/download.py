"""The text a contribution download serves, made from its stored canonical file.

Stored revision content is immutable (a published file is never edited), so
every fix-up a download needs happens here, on output:

- a leading UTF-8 BOM is dropped (MagIC #621) and line endings become "\\n";
- table separators are normalized (MagIC #311): every `>>>` line becomes the
  format's `>>>>>>>>>>`, separators with no table between them, before the
  first table or after the last are dropped, and so are rows holding nothing
  but `>`s (legacy exports left a "\\t\\t\\t>>>>>>>>>>" row after a table) or
  only whitespace;
- the `contribution` table's download-only columns (`downloadOnly()` in the
  data model) are filled from the contribution's workflow record (MagIC #291,
  #315): `id`, `version`, `timestamp`, `contributor`, `data_model_version` —
  whichever of them the node's data model declares. Those columns belong to
  the system, so a stored value (a legacy `@handle` contributor, a stale id)
  is overwritten; an empty value never blanks one. The identifiers every
  save writes (`stamp_ids`: the contribution's `id`, each row's
  `contribution_id` and `row_id`) are written too, for files stored before it.

A file that is not UTF-8 is served as stored. A file that does not parse gets
the BOM, line-ending and separator fixes but no metadata.
"""

from fiesta.domain.parse import (
    TABLE_SEPARATOR,
    ParseError,
    parse_text,
    set_table_values,
    stamp_ids,
)

BOM = "﻿"

# Download-only contribution columns the platform fills, by column name. Only
# those the data model declares for the `contribution` table are written.
CONTRIBUTION_COLUMNS = ("id", "version", "timestamp", "contributor", "data_model_version")


def download_only_columns(model: dict, table: str = "contribution") -> list[str]:
    columns = model.get("tables", {}).get(table, {}).get("columns", {})
    return [
        name
        for name, definition in columns.items()
        if "downloadOnly()" in (definition.get("validations") or [])
    ]


def contribution_values(model: dict, record: dict[str, object]) -> dict[str, str]:
    """The download-only contribution cells to write: RECORD's non-empty
    values for the CONTRIBUTION_COLUMNS the data model declares download-only."""
    declared = set(download_only_columns(model))
    values = {}
    for column in CONTRIBUTION_COLUMNS:
        value = record.get(column)
        if column in declared and value not in (None, ""):
            values[column] = str(value)
    return values


def _stray(line: str) -> bool:
    """A row that is only whitespace, or whose only content is `>`s."""
    cells = [c.strip() for c in line.split("\t")]
    content = [c for c in cells if c]
    return not content or all(set(c) == {">"} for c in content)


def clean_text(text: str) -> str:
    """TEXT without a leading BOM, with "\\n" line endings, proper separators
    only, no stray or blank rows, and a final newline."""
    lines = text.lstrip(BOM).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    for line in lines:
        if line.startswith(">>>"):
            # Only between two tables: never first, never twice in a row.
            if out and out[-1] != TABLE_SEPARATOR:
                out.append(TABLE_SEPARATOR)
        elif not _stray(line):
            out.append(line)
    while out and out[-1] == TABLE_SEPARATOR:
        out.pop()
    return "\n".join(out) + "\n" if out else ""


def prepare_download(raw: bytes, model: dict, record: dict[str, object]) -> bytes:
    """The bytes a download serves for the stored file RAW: see the module
    docstring. RECORD holds the contribution's workflow values by column name."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw
    text = clean_text(text)
    values = contribution_values(model, record)
    if not text or not (values or record.get("id")):
        return text.encode()
    try:
        parse_text(text)
    except ParseError:
        return text.encode()
    if record.get("id"):
        # The identifiers every save writes (a file stored before stamp_ids
        # lacks them): the contribution's `id` first in its table, as the
        # data-model order puts it, and each row's contribution_id / row_id.
        text = stamp_ids(text, int(record["id"]), model)
    if values:
        text = set_table_values(text, "contribution", values)
    return (text if text.endswith("\n") else text + "\n").encode()
