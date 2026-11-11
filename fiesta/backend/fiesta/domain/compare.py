"""Per-table row statistics for a contribution: the rows its validation flagged,
and the rows that differ from the version before it."""

from collections import Counter

from fiesta.domain.parse import ParsedContribution


def issue_rows(issues: list[dict]) -> dict[str, int]:
    """Distinct rows per table named by validation issues (table-level issues,
    with no row, are not counted)."""
    rows: dict[str, set[int]] = {}
    for issue in issues:
        table, row = issue.get("table"), issue.get("row")
        if table and row is not None:
            rows.setdefault(table, set()).add(row)
    return {table: len(numbers) for table, numbers in rows.items()}


# The download-only identifiers parse.stamp_ids writes differ in every version.
STAMPED = {"contribution_id", "row_id"}


def _row_key(table: str, row: dict[str, str]) -> frozenset:
    # Column order and empty cells do not make a row different.
    ignored = {"id"} if table == "contribution" else STAMPED
    return frozenset(
        (column, value) for column, value in row.items() if value != "" and column not in ignored
    )


def changed_rows(
    current: ParsedContribution, previous: ParsedContribution
) -> dict[str, dict[str, int]]:
    """Per table, `changed`: this version's rows with no identical row in the
    previous version (added or edited), and `removed`: the previous version's
    rows left unmatched, ignoring the stamped identifiers. Tables with neither
    are left out."""
    stats: dict[str, dict[str, int]] = {}
    for table in dict.fromkeys([*current.tables, *previous.tables]):
        before = Counter(_row_key(table, row) for row in previous.tables.get(table, []))
        changed = 0
        for row in current.tables.get(table, []):
            key = _row_key(table, row)
            if before[key] > 0:
                before[key] -= 1
            else:
                changed += 1
        removed = sum(before.values())
        if changed or removed:
            stats[table] = {"changed": changed, "removed": removed}
    return stats
