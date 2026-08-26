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
        column_names = [c.strip() for c in block[1].split(delimiter)]
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
