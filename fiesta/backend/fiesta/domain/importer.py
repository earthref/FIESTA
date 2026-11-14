"""The upload page's import step, server half (legacy MagIC
upload_contribution.jsx `reviewUpload`).

The browser reads each file (text, CSV, spreadsheet), lets the contributor map
sheets to tables and columns to data-model columns, and sends the result as
contribution text, one block per imported sheet. Here that text is checked
(tables one upload may take from a single sheet), its values normalised against
the data model and vocabularies, and merged into the contribution's current
tables: an imported table replaces the one there, the rest are kept.
"""

import re
from collections import Counter
from collections.abc import Callable, Collection

from fiesta.domain.data_model import LIST_TYPES
from fiesta.domain.parse import ParsedContribution

INTEGER_POINT_ZERO = re.compile(r"\.0+\s*$")
TRUE_WORDS = {"t", "1", "true", "yes", "y"}
FALSE_WORDS = {"f", "0", "false", "no", "n"}

# A vocabulary name -> its items, or None when values are compared
# case-insensitively (nothing to correct) or the name is unknown.
VocabularyLookup = Callable[[str], Collection[str] | None]


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def _vocabulary_names(column_def: dict) -> list[str]:
    names = []
    for validation in column_def.get("validations") or []:
        validation = validation.strip()
        if validation.startswith('cv("') and validation.endswith('")'):
            names.append(validation[4:-2])
    return names


def correct_term(value: str, items: Collection[str]) -> str:
    """A vocabulary term as the vocabulary spells it: the item it equals
    ignoring case, else the one item a single-letter typo away (values of three
    or more characters only, and only when exactly one item is that close),
    else the value unchanged. A True/False vocabulary also reads t/f, 1/0,
    yes/no."""
    lowered = value.lower()
    by_lower = {str(item).lower(): str(item) for item in items}
    if lowered in by_lower:
        return by_lower[lowered]
    if set(by_lower) == {"true", "false"}:
        if lowered in TRUE_WORDS:
            return by_lower["true"]
        if lowered in FALSE_WORDS:
            return by_lower["false"]
        return value
    if len(value) < 3:
        return value
    close = [item for low, item in by_lower.items() if levenshtein(lowered, low) <= 1]
    return close[0] if len(close) == 1 else value


def normalise_value(column_def: dict, value: str, vocabularies: VocabularyLookup) -> str:
    """One cell as the data model expects it: an Integer column drops a
    trailing `.0` (spreadsheets write 3 as 3.0), and a controlled-vocabulary
    column's terms are corrected by `correct_term` (each term of a List)."""
    value = value.strip()
    if not value:
        return value
    if column_def.get("type") == "Integer":
        value = INTEGER_POINT_ZERO.sub("", value)
    for name in _vocabulary_names(column_def):
        items = vocabularies(name)
        if not items:
            continue
        if column_def.get("type") in LIST_TYPES:
            return ":".join(
                correct_term(term.strip(), items) if term.strip() else term
                for term in value.split(":")
            )
        return correct_term(value, items)
    return value


def normalise(
    parsed: ParsedContribution, model: dict, vocabularies: VocabularyLookup
) -> ParsedContribution:
    """`normalise_value` over every cell of the model's tables (columns and
    tables the model lacks are left for validation to report)."""
    out = ParsedContribution()
    for table, rows in parsed.tables.items():
        columns = model["tables"].get(table, {}).get("columns", {})
        out.tables[table] = [
            {
                column: normalise_value(columns[column], value, vocabularies)
                if column in columns
                else value
                for column, value in row.items()
            }
            for row in rows
        ]
    return out


def single_source_errors(block_tables: list[str], single_source: Collection[str]) -> list[str]:
    """Refuse an import that brings a single-source table from more than one
    sheet (legacy MagIC: two measurements tables)."""
    counts = Counter(block_tables)
    return [
        f"There is more than one {table} table in this upload. "
        "Please combine them before uploading."
        for table in sorted(single_source)
        if counts[table] > 1
    ]


def merge(
    existing: ParsedContribution,
    imported: ParsedContribution,
    *,
    keep_table: str | None = None,
    keep_columns: Collection[str] = (),
) -> ParsedContribution:
    """The contribution after an upload into it: every table the upload
    brings replaces the contribution's table of that name; the others are
    kept as they are. In `keep_table` (the workspace table, one row) the
    contribution's values of `keep_columns` (the workspace fields and the
    reference) survive where the uploaded row leaves them blank."""
    merged = ParsedContribution(tables={t: list(rows) for t, rows in existing.tables.items()})
    for table, rows in imported.tables.items():
        merged.tables[table] = list(rows)
    if keep_table and keep_table in imported.tables and existing.tables.get(keep_table):
        before = existing.tables[keep_table][0]
        rows = merged.tables[keep_table] or [{}]
        first = dict(rows[0])
        for column in keep_columns:
            if not first.get(column) and before.get(column):
                first[column] = before[column]
        merged.tables[keep_table] = [first, *rows[1:]]
    return merged
