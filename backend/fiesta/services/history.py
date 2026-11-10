"""A contribution's published versions and its per-table row statistics (for
the contribution modal's revision history and level-tab badges)."""

import asyncio
from collections import OrderedDict
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from fiesta.db.models import Contribution, User
from fiesta.domain.compare import changed_rows, issue_rows
from fiesta.domain.parse import parse_text
from fiesta.nodeconfig import NodeConfig
from fiesta.services.contributions import latest_validation, load_file

# A chain longer than this is a data error (a previous_id loop), not history.
MAX_VERSIONS = 200


def _listed(contribution: Contribution | None) -> bool:
    return (
        contribution is not None and contribution.deleted_at is None and contribution.is_activated
    )


async def version_chain(session: AsyncSession, contribution: Contribution) -> list[Contribution]:
    """Every version linked to `contribution` through previous_id, oldest
    first: the published ones, plus `contribution` itself (whose visibility the
    caller has checked)."""
    older: list[Contribution] = []
    seen = {contribution.id}
    cursor = contribution
    while cursor.previous_id and cursor.previous_id not in seen and len(seen) < MAX_VERSIONS:
        cursor = await session.get(Contribution, cursor.previous_id)
        if cursor is None:
            break
        seen.add(cursor.id)
        older.append(cursor)
    newer: list[Contribution] = []
    cursor = contribution
    while len(seen) < MAX_VERSIONS:
        successors = (
            await session.execute(
                select(Contribution)
                .where(Contribution.previous_id == cursor.id, Contribution.deleted_at.is_(None))
                .order_by(Contribution.is_activated.desc(), Contribution.id)
            )
        ).scalars()
        cursor = next((c for c in successors if c.id not in seen), None)
        if cursor is None:
            break
        seen.add(cursor.id)
        newer.append(cursor)
    chain = [*reversed(older), contribution, *newer]
    return [c for c in chain if c is contribution or _listed(c)]


async def versions(session: AsyncSession, contribution: Contribution) -> list[dict[str, Any]]:
    chain = await version_chain(session, contribution)
    ids = {c.contributor_id for c in chain}
    names = dict(
        (await session.execute(select(User.id, User.name).where(User.id.in_(ids)))).tuples().all()
    )
    return [
        {
            "id": c.id,
            "version": c.version,
            "data_model_version": c.data_model_version,
            "timestamp": c.activated_at or c.updated_at,
            "contributor": names.get(c.contributor_id),
            "is_activated": c.is_activated,
            "is_latest": c.is_latest,
        }
        for c in chain
    ]


def _file_key(node: NodeConfig, contribution: Contribution) -> tuple:
    return (
        node.node.slug,
        contribution.id,
        contribution.head_revision,
        contribution.filename,
        contribution.updated_at,
    )


# Recently compared contributions: parsing two versions is the costly part.
_CACHE: OrderedDict[tuple, dict[str, dict[str, int]]] = OrderedDict()
_CACHE_SIZE = 8


async def _changes(
    node: NodeConfig, contribution: Contribution, previous: Contribution
) -> dict[str, dict[str, int]]:
    key = (_file_key(node, contribution), _file_key(node, previous))
    changes = _CACHE.get(key)
    if changes is None:
        current_raw, previous_raw = await asyncio.gather(
            load_file(node, contribution.id, contribution.filename),
            load_file(node, previous.id, previous.filename),
        )
        changes = await asyncio.to_thread(
            lambda: changed_rows(
                parse_text(current_raw.decode("utf-8", errors="replace")),
                parse_text(previous_raw.decode("utf-8", errors="replace")),
            )
        )
        _CACHE[key] = changes
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)
    _CACHE.move_to_end(key)
    return changes


async def row_stats(
    session: AsyncSession, node: NodeConfig, contribution: Contribution
) -> dict[str, Any]:
    """Per table: rows flagged by the current revision's validation (`errors`,
    `warnings`, absent when it was never validated) and rows differing from
    the previous published version (`changed`, `removed`, absent when there is
    none)."""
    tables: dict[str, dict[str, int]] = {}
    report = await latest_validation(session, contribution.id)
    if report is not None:
        for kind, issues in (("errors", report.errors), ("warnings", report.warnings)):
            for table, count in issue_rows(issues or []).items():
                tables.setdefault(table, {})[kind] = count
    previous = (
        await session.get(Contribution, contribution.previous_id)
        if contribution.previous_id
        else None
    )
    if not (_listed(previous) and previous.filename and contribution.filename):
        previous = None
    if previous is not None:
        for table, counts in (await _changes(node, contribution, previous)).items():
            tables.setdefault(table, {}).update(counts)
    return {
        "validated": report is not None,
        "previous": {"id": previous.id, "version": previous.version} if previous else None,
        "tables": tables,
    }


# --- One table of the file, sorted and paged (the contribution modal's level tabs) ---

# Recently viewed files' parsed tables, and the row orders sorted on them.
_TABLES: OrderedDict[tuple, dict[str, Any]] = OrderedDict()
_TABLES_SIZE = 4


async def _parsed_tables(node: NodeConfig, contribution: Contribution) -> dict[str, Any]:
    key = _file_key(node, contribution)
    entry = _TABLES.get(key)
    if entry is None:
        raw = await load_file(node, contribution.id, contribution.filename)
        parsed = await asyncio.to_thread(parse_text, raw.decode("utf-8", errors="replace"))
        entry = {"tables": parsed.tables, "orders": {}}
        _TABLES[key] = entry
        while len(_TABLES) > _TABLES_SIZE:
            _TABLES.popitem(last=False)
    _TABLES.move_to_end(key)
    return entry


def _as_number(value: str) -> float | None:
    try:
        number = float(value)
    except ValueError:
        return None
    return None if number != number else number  # NaN sorts as text


def sorted_order(
    rows: list[dict[str, str]], column: str, descending: bool, numeric: bool
) -> list[int]:
    """Row positions ordered by `column`: numerically when the data model says
    Number or every value parses as one (any other values after the numbers),
    otherwise as case-folded text; empty cells last either way, file order on
    ties."""
    values = [(row.get(column) or "").strip() for row in rows]
    filled = [i for i, value in enumerate(values) if value]
    empty = [i for i, value in enumerate(values) if not value]
    numbers = {i: _as_number(values[i]) for i in filled}
    if numeric or all(n is not None for n in numbers.values()):
        number_rows = [i for i in filled if numbers[i] is not None]
        text_rows = [i for i in filled if numbers[i] is None]
        number_rows.sort(key=lambda i: numbers[i], reverse=descending)
    else:
        number_rows, text_rows = [], filled
    text_rows.sort(key=lambda i: values[i].casefold(), reverse=descending)
    return number_rows + text_rows + empty


def _issues_by_row(report, table: str) -> tuple[dict[int, dict], dict[str, dict]]:
    """The table's validation issues per 1-based row and column ("" for an
    issue on the whole row), and per column for issues naming no row; an
    error wins over a warning on the same cell."""
    rows: dict[int, dict[str, dict]] = {}
    columns: dict[str, dict] = {}
    if report is None:
        return rows, columns
    for severity, issues in (("error", report.errors), ("warning", report.warnings)):
        for issue in issues or []:
            row, column = issue.get("row"), issue.get("column") or ""
            if issue.get("table") != table or (row is None and not column):
                continue
            target = columns if row is None else rows.setdefault(row, {})
            cell = target.setdefault(column, {"severity": severity, "messages": []})
            if (message := issue.get("message")) and message not in cell["messages"]:
                cell["messages"].append(message)
    return rows, columns


async def table_page(
    session: AsyncSession,
    node: NodeConfig,
    contribution: Contribution,
    table: str,
    *,
    sort: tuple[str, str] | None,
    offset: int,
    size: int,
) -> dict[str, Any]:
    """One page of a table of the contribution's current file. Each row has
    its 1-based position in the file's table (`row`, what validation issues
    name) and the issues on its cells; `columns` are in first-seen order and
    `column_issues` are those naming a column but no row. `sort` is
    (column, "asc"|"desc") over every row of the table, not just the page."""
    entry = await _parsed_tables(node, contribution)
    rows: list[dict[str, str]] = entry["tables"].get(table, [])
    columns = list(dict.fromkeys(column for row in rows for column in row))
    if sort is not None and sort[0] in columns:
        column, order = sort
        positions = entry["orders"].get((table, column, order))
        if positions is None:
            try:
                model = node.load_data_model(contribution.data_model_version)
            except KeyError:
                model = node.load_data_model(node.data_model.latest)
            kind = model["tables"].get(table, {}).get("columns", {}).get(column, {}).get("type")
            positions = await asyncio.to_thread(
                sorted_order, rows, column, order == "desc", kind == "Number"
            )
            entry["orders"][(table, column, order)] = positions
        page = positions[offset : offset + size]
    else:
        page = list(range(offset, min(offset + size, len(rows))))
    report = await latest_validation(session, contribution.id)
    by_row, by_column = _issues_by_row(report, table)
    return {
        "total": len(rows),
        "columns": columns,
        "validated": report is not None,
        "column_issues": by_column,
        "rows": [{"row": i + 1, "values": rows[i], "issues": by_row.get(i + 1, {})} for i in page],
    }
