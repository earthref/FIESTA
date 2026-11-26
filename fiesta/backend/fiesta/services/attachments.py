"""A contribution's attachments: the files kept beside its canonical text.

Each revision snapshot carries, beside `files`, an `attachments` map of file
name -> `{"origin", "rows", "added_at"}` written by `save_revision`:

- `origin` "upload": the upload tool kept the file (an original the rows were
  converted from, or the upgrade/conversion report written with them); `rows`
  is how many rows of each table it brought in. These are never removed: they
  are the record of where the contribution's rows came from.
- `origin` "attachment": a file added on the editor's Attachments tab.
- no entry: a file written before this map existed, or by a path that does not
  say (legacy imports, /v1). Treated like an attachment.

An attachment is "referenced" when a row of the canonical text names it (a
cell equal to the file name, or ending in it as a path or URL); a referenced
attachment cannot be removed either.
"""

import re
from collections.abc import Iterable

from fiesta.domain.parse import table_row_counts

UPLOAD = "upload"
ATTACHMENT = "attachment"

_IMAGE = {"png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"}
_TEXT = {"txt", "csv", "tsv", "dat", "json", "xml", "md", "py", "r", "m", "ipynb", "log", "yaml"}
_SHEET = {"xls", "xlsx", "xlsm", "ods"}
_ARCHIVE = {"zip", "gz", "tgz", "tar", "7z", "bz2"}


def kind(name: str) -> str:
    """What the file is, from its extension: image | svg | pdf | text |
    spreadsheet | archive | other (the card's thumbnail and icon)."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in _IMAGE:
        return "image"
    if ext == "svg":
        return "svg"
    if ext == "pdf":
        return "pdf"
    if ext in _TEXT:
        return "text"
    if ext in _SHEET:
        return "spreadsheet"
    if ext in _ARCHIVE:
        return "archive"
    return "other"


def block_rows(text: str, sources: list[str]) -> dict[str, dict[str, int]]:
    """Rows per table that each source file brought, from the upload page's
    import text (one block per sheet, `>>>` lines between them) and
    `sources`, the file each block was converted from, in block order. When
    they do not line up nothing is attributed (the import itself still saves)."""
    blocks, current = [], []
    for line in text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.startswith(">>>"):
            blocks.append(current)
            current = []
        else:
            current.append(line)
    blocks.append(current)
    blocks = [b for b in blocks if any(line.strip() for line in b)]
    if len(blocks) != len(sources):
        return {}
    rows: dict[str, dict[str, int]] = {}
    for block, source in zip(blocks, sources, strict=True):
        per_file = rows.setdefault(source, {})
        for table, n in table_row_counts("\n".join(block)).items():
            per_file[table] = per_file.get(table, 0) + n
    return rows


def references(text: str, names: Iterable[str]) -> dict[str, dict[str, int]]:
    """Rows per table of the contribution text that name each file (in any
    cell, ignoring case, as the whole value or after a `/`, `:` or space)."""
    names = [n for n in names if n]
    found: dict[str, dict[str, int]] = {n: {} for n in names}
    if not names:
        return found
    by_lower = {n.lower(): n for n in names}
    pattern = re.compile(
        r"(?<![\w.\-])(?:"
        + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
        + r")(?![\w.\-])",
        re.IGNORECASE,
    )
    table: str | None = None
    state = 0  # as in table_row_counts: 0 table line, 1 column line, 2 rows
    for line in text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.startswith(">>>"):
            state = 0
        elif not line.strip():
            continue
        elif state == 0:
            header = line.split("\t")
            table = header[1].strip() if len(header) > 1 else None
            state = 1
        elif state == 1:
            state = 2
        elif table is not None:
            for match in {m.group(0).lower() for m in pattern.finditer(line)}:
                per_table = found[by_lower[match]]
                per_table[table] = per_table.get(table, 0) + 1
    return found


def refusal(entry: dict) -> str | None:
    """Why an attachment card's file cannot be removed (None: it can)."""
    if entry["origin"] == UPLOAD:
        return "it was kept by the upload tool as the record of the rows it brought in"
    if n := sum(entry["referenced"].values()):
        return f"{n} row{'s' if n != 1 else ''} of the contribution name{'s' if n == 1 else ''} it"
    return None


def cards(snapshot: dict, text: str | None) -> list[dict]:
    """One entry per attachment of a revision snapshot (`text`: its canonical
    text, None when it cannot be read): what the editor's cards show."""
    meta = snapshot.get("attachments") or {}
    names = [n for n in snapshot["files"] if n != snapshot["canonical"]]
    refs = references(text or "", names)
    out = []
    for name in sorted(names, key=str.lower):
        file, info = snapshot["files"][name], meta.get(name) or {}
        entry = {
            "name": name,
            "size": file["size"],
            "sha256": file["sha256"],
            "kind": kind(name),
            "origin": info.get("origin"),
            "added_at": info.get("added_at"),
            "rows": info.get("rows") or {},
            "referenced": refs.get(name, {}),
        }
        entry["locked"] = refusal(entry)
        out.append(entry)
    return out


def upload_meta(files: dict[str, bytes], canonical: str) -> dict[str, dict]:
    """The `attachments` entries of a whole-file upload (PUT .../file): the
    original, when it was upgraded, brought every row of the canonical text;
    the upgrade report brought none."""
    from fiesta.services.upgrades import REPORT_NAME

    rows = (
        table_row_counts(files[canonical].decode("utf-8", "replace")) if canonical in files else {}
    )
    return {
        name: {"origin": UPLOAD, "rows": {} if name == REPORT_NAME else rows}
        for name in files
        if name != canonical
    }
