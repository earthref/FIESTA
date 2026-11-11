"""Parse and export the FIESTA/MagIC tab-delimited contribution text format.

Format (one block per table, blocks separated by a line of `>`s):

    tab delimited\tcontribution
    id\tversion\tdata_model_version
    12345\t1\t3.0
    >>>>>>>>>>
    tab delimited\tsites
    site\tlocation\tlat\tlon
    ...

"tab" is accepted as a synonym for "tab delimited".
"""

from dataclasses import dataclass, field

TABLE_SEPARATOR = ">>>>>>>>>>"
# Download-only bookkeeping columns written by stamp_ids (not search values).
ID_COLUMNS = {"contribution_id", "row_id"}
DELIMITERS = {"tab": "\t", "tab delimited": "\t"}


@dataclass
class ParseError(Exception):
    line: int
    message: str

    def __str__(self) -> str:
        return f"line {self.line}: {self.message}"


@dataclass
class ParsedContribution:
    tables: dict[str, list[dict[str, str]]] = field(default_factory=dict)

    def row_count(self, table: str) -> int:
        return len(self.tables.get(table, []))


def parse_text(text: str) -> ParsedContribution:
    parsed = ParsedContribution()
    # Strip a leading UTF-8 BOM (real exports sometimes include one, which
    # would otherwise make the first "tab delimited" header unrecognizable).
    text = text.lstrip("﻿")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    block_start = 0
    blocks: list[tuple[int, list[str]]] = []
    current: list[str] = []
    for i, line in enumerate(lines):
        if line.startswith(">>>"):
            blocks.append((block_start, current))
            current = []
            block_start = i + 1
        else:
            current.append(line)
    blocks.append((block_start, current))

    for start, block in blocks:
        # Strip leading/trailing blank lines within the block.
        while block and not block[0].strip():
            block.pop(0)
            start += 1
        while block and not block[-1].strip():
            block.pop()
        if not block:
            continue
        header = block[0].split("\t")
        if len(header) < 2:
            raise ParseError(start + 1, f'expected "tab delimited\\t<table>", got {block[0]!r}')
        delimiter_word, table = header[0].strip().lower(), header[1].strip()
        delimiter = DELIMITERS.get(delimiter_word)
        if delimiter is None:
            raise ParseError(start + 1, f'unknown delimiter {header[0]!r}; expected "tab"')
        if len(block) < 2:
            raise ParseError(start + 1, f"table {table!r} has no column header row")
        # Legacy files carry empty column names (a trailing tab, or a blank header
        # cell over real values). "" is not a usable key (the search mapping rejects
        # it), so an unnamed column becomes `_unnamed_<n>`: it only surfaces when a
        # row has a value there, and validation then reports it as unrecognized.
        column_names = [
            c.strip() or f"_unnamed_{i + 1}" for i, c in enumerate(block[1].split(delimiter))
        ]
        rows: list[dict[str, str]] = []
        for offset, line in enumerate(block[2:], start=start + 3):
            if not line.strip():
                continue
            cells = line.split(delimiter)
            if len(cells) > len(column_names):
                raise ParseError(
                    offset, f"row has {len(cells)} cells but {len(column_names)} columns"
                )
            row = {
                name: cells[i].strip()
                for i, name in enumerate(column_names)
                if i < len(cells) and cells[i].strip() != ""
            }
            if row:
                rows.append(row)
        parsed.tables.setdefault(table, []).extend(rows)

    return parsed


def stamp_ids(text: str, contribution_id: int, model: dict) -> str:
    """Write the download-only identifiers into a contribution's text: the
    `contribution` table's `id`, and in every other table `contribution_id`
    plus a `row_id` numbered 1..N across all of the contribution's rows in
    file order. A column is written only where the data model declares it for
    that table, added at the front of the block when the file lacks it, and
    overwritten when present (a re-uploaded download renumbers). Nothing else
    in the text changes. Call it only on text that `parse_text` accepts."""
    tables = model.get("tables", {})
    lines = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    row_id = 0
    state, missing, index = "table", [], {}
    for n, line in enumerate(lines):
        if line.startswith(">>>"):
            state = "table"
        elif not line.strip():
            continue
        elif state == "table":
            header = line.split("\t")
            table = header[1].strip() if len(header) > 1 else ""
            declared = tables.get(table, {}).get("columns", {})
            targets = ["id"] if table == "contribution" else ["contribution_id", "row_id"]
            targets = [c for c in targets if c in declared]
            state = "columns"
        elif state == "columns":
            columns = [c.strip() for c in line.split("\t")]
            missing = [c for c in targets if c not in columns]
            columns = missing + columns
            index = {c: columns.index(c) for c in targets}
            lines[n] = "\t".join([*missing, line])
            state = "rows"
        elif index:
            cells = [""] * len(missing) + line.split("\t")
            for column, i in index.items():
                cells += [""] * (i + 1 - len(cells))
                if column == "row_id":
                    row_id += 1
                    cells[i] = str(row_id)
                else:
                    cells[i] = str(contribution_id)
            lines[n] = "\t".join(cells)
    return "\n".join(lines)


def set_table_values(text: str, table: str, values: dict[str, str]) -> str:
    """Set `values` (column -> cell) on every row of one table in a
    contribution's text, in place: a column the block lacks is appended to its
    header, a block without rows gains one, and a file without the table gains
    the block at its front. Tabs and line breaks in a value become spaces.
    Nothing else in the text changes. Call it only on text that `parse_text`
    accepts."""
    clean = {c: " ".join(v.replace("\t", " ").splitlines()).strip() for c, v in values.items()}
    lines = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    state, index, rows_seen, found = "table", {}, 0, False

    def close_block() -> None:
        if index and not rows_seen:
            cells = [""] * (max(index.values()) + 1)
            for column, i in index.items():
                cells[i] = clean[column]
            # Before the block's trailing blank lines.
            at = len(out)
            while at > 0 and not out[at - 1].strip():
                at -= 1
            out.insert(at, "\t".join(cells))

    for line in lines:
        if line.startswith(">>>"):
            close_block()
            state, index, rows_seen = "table", {}, 0
            out.append(line)
            continue
        if not line.strip():
            out.append(line)
            continue
        if state == "table":
            header = line.split("\t")
            matched = len(header) > 1 and header[1].strip() == table
            found = found or matched
            state = "columns" if matched else "other"
            out.append(line)
        elif state == "columns":
            columns = [c.strip() for c in line.split("\t")]
            missing = [c for c in clean if c not in columns]
            columns += missing
            index = {c: columns.index(c) for c in clean}
            out.append("\t".join([line, *missing]) if missing else line)
            state = "rows"
        elif state == "rows":
            cells = line.split("\t")
            cells += [""] * (max(index.values()) + 1 - len(cells))
            for column, i in index.items():
                cells[i] = clean[column]
            rows_seen += 1
            out.append("\t".join(cells))
        else:
            out.append(line)
    close_block()
    if not found:
        block = [f"tab delimited\t{table}", "\t".join(clean), "\t".join(clean.values())]
        out = [*block, TABLE_SEPARATOR, *out]
    return "\n".join(out)


def export_text(parsed: ParsedContribution, model: dict) -> str:
    """Serialize tables back to canonical text, ordered by the data model."""
    from fiesta.domain.data_model import tables_in_order

    order = [t for t in tables_in_order(model) if t in parsed.tables]
    order += [t for t in parsed.tables if t not in order]

    chunks: list[str] = []
    for table in order:
        rows = parsed.tables[table]
        if not rows:
            continue
        model_columns = list(model["tables"].get(table, {}).get("columns", {}))
        present: set[str] = set()
        for row in rows:
            present.update(row)
        column_names = [c for c in model_columns if c in present]
        column_names += sorted(present - set(column_names))
        lines = [f"tab delimited\t{table}", "\t".join(column_names)]
        lines.extend("\t".join(row.get(c, "") for c in column_names) for row in rows)
        chunks.append("\n".join(lines))
    return ("\n" + TABLE_SEPARATOR + "\n").join(chunks) + "\n"
