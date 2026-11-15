"""Upgrade a contribution written against an older data-model version to a
newer one (legacy MagIC upgrade_contribution.js + data_model_changes.js).

The version chain and every rename, move, split and merge of a column come
from the node's data models: each column of version N lists the columns of
version N-1 it takes its values from in `previous_columns` ([{table, column}]).
`upgrade_map` turns that into old (table, column) -> new [(table, column)],
and `upgrade` walks the chain one step at a time:

1. map: every old row becomes at most one row per new table its columns map
   into (an `er_sites` row can feed `sites` and `locations`);
2. merge: rows of a table that several old tables feed, describing the same
   entity (same merge keys) and not contradicting each other, become one row;
3. stamp the new version on the contribution table.

Restructuring a model cannot express in `previous_columns` (MagIC 2.5 -> 3.0:
splitting results by level, the wide criteria table, method-code renames, ...)
is an `UpgradeStep` a plugin supplies (FiestaPlugin.upgrade_steps); the core
never names a node, table or column of one.

Nothing is dropped silently: the `UpgradeReport` lists what was renamed or
moved, merged, dropped (columns the new version no longer has, values whose
level has no such column, rows, whole tables), the columns and tables the old
model does not define (kept by default, so the importer can map or skip them,
MagIC #308) and every blank the step filled with the old model's documented
default (each one a choice, MagIC #521).
"""

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal

from fiesta.domain.parse import ParsedContribution

Row = dict[str, str]
WORD_END = re.compile(r"\w$")
Tables = dict[str, list[Row]]
UpgradeMap = dict[str, dict[str, list[tuple[str, str]]]]
Level = Literal["error", "warning", "info"]

# Contribution-table columns that carry the data-model version (the 2.x
# models call it magic_version), as fiesta.domain.validate reads them.
VERSION_COLUMNS = ("data_model_version", "magic_version")


def upgrade_map(new_model: dict) -> UpgradeMap:
    """Where each column of the previous version goes in `new_model`: old
    table -> old column -> [(new table, new column), ...] in model order. A
    column several new columns name is split (copied into each); a new column
    naming several old columns merges them."""
    out: UpgradeMap = {}
    for new_table, table_def in new_model.get("tables", {}).items():
        for new_column, column_def in (table_def.get("columns") or {}).items():
            for previous in column_def.get("previous_columns") or []:
                targets = out.setdefault(previous["table"], {}).setdefault(previous["column"], [])
                if (new_table, new_column) not in targets:
                    targets.append((new_table, new_column))
    return out


def model_changes(new_model: dict, old_model: dict | None = None) -> dict:
    """The changes `new_model` makes to the version before it, by new
    table and column: `inserted` (no previous column), `renamed` (one previous
    column with another table or name: {table, column} it was), `merged`
    (several previous columns) and, given `old_model`, `deleted` (old columns
    no new column names), {table: [column, ...]}. Unchanged columns are not
    listed. Raises ValueError for a model without `tables` or a previous
    column without `table` and `column`."""
    if not new_model or "tables" not in new_model:
        raise ValueError('the data model has no "tables"')
    changes: dict[str, dict] = {"inserted": {}, "renamed": {}, "merged": {}, "deleted": {}}
    named: set[tuple[str, str]] = set()
    for table, table_def in new_model["tables"].items():
        if "columns" not in table_def:
            raise ValueError(f'table "{table}" has no "columns"')
        for column, column_def in table_def["columns"].items():
            previous = column_def.get("previous_columns") or []
            for p in previous:
                if "table" not in p or "column" not in p:
                    raise ValueError(
                        f'a previous column of "{table}.{column}" lacks its table or column'
                    )
                named.add((p["table"], p["column"]))
            if not previous:
                changes["inserted"].setdefault(table, []).append(column)
            elif len(previous) > 1:
                changes["merged"].setdefault(table, {})[column] = [
                    {"table": p["table"], "column": p["column"]} for p in previous
                ]
            elif (previous[0]["table"], previous[0]["column"]) != (table, column):
                changes["renamed"].setdefault(table, {})[column] = {
                    "table": previous[0]["table"],
                    "column": previous[0]["column"],
                }
    for table, table_def in ((old_model or {}).get("tables") or {}).items():
        gone = [c for c in table_def.get("columns") or {} if (table, c) not in named]
        if gone:
            changes["deleted"][table] = gone
    return changes


# --------------------------------------------------------------------------
# Version detection


def detect_version(
    parsed: ParsedContribution, versions: list[str], load_model: Callable[[str], dict]
) -> tuple[str | None, bool]:
    """The data-model version a contribution is written in, and whether it
    was guessed: the contribution table's `data_model_version` (or 2.x
    `magic_version`) when it names one of `versions`; else the version whose
    model leaves the fewest of its tables, then columns, undefined (the newest
    on a tie). None when nothing fits at all (no table any version defines)."""
    for row in parsed.tables.get("contribution", [])[:1]:
        for key in VERSION_COLUMNS:
            if row.get(key) in versions:
                return row[key], False
    best: tuple[int, int, int] | None = None
    chosen = None
    for index, version in enumerate(versions):
        tables = load_model(version)["tables"]
        unknown_tables = unknown_columns = 0
        for table, rows in parsed.tables.items():
            if table not in tables:
                unknown_tables += 1
                continue
            columns = tables[table].get("columns", {})
            unknown_columns += len({c for row in rows for c in row} - set(columns))
        score = (unknown_tables, unknown_columns, -index)
        if best is None or score < best:
            best, chosen = score, version
    if best is None or best[0] == len(parsed.tables) and parsed.tables:
        return None, True
    return chosen, True


# --------------------------------------------------------------------------
# Report


@dataclass
class UpgradeNote:
    """One line of the report, counted over every row it applies to."""

    level: Level
    kind: str  # renamed | merged | dropped_column | dropped_value | dropped_row |
    # dropped_table | unknown_table | unknown_column | converted | default |
    # merged_rows | collision | version
    message: str
    step: str = ""
    table: str | None = None
    column: str | None = None
    to: list[str] = field(default_factory=list)
    count: int = 1

    def as_dict(self) -> dict:
        return {
            "level": self.level,
            "kind": self.kind,
            "message": self.message,
            "step": self.step,
            "table": self.table,
            "column": self.column,
            "to": self.to,
            "count": self.count,
        }


@dataclass(frozen=True)
class BlankDefault:
    """A value the old model documented for a blank cell (MagIC 2.5: "g, the
    default"). The newer model has no defaults, so a step may write it into the
    blank cells it applies to — only when `on` (the step's choice unless the
    contributor overrides it in UpgradeOptions.defaults)."""

    key: str
    label: str
    on: bool = True


@dataclass
class UpgradeOptions:
    #: Columns and tables the old model does not define: kept (under their
    #: own name, for the importer to map or skip, or validation to report)
    #: or dropped.
    unknown_columns: Literal["keep", "drop"] = "keep"
    #: "table.column" -> new column name in that table, applied before the
    #: first step (an empty name drops the column) — MagIC #308.
    renames: dict[str, str] = field(default_factory=dict)
    #: BlankDefault.key -> on/off, overriding the step's choice — MagIC #521.
    defaults: dict[str, bool] = field(default_factory=dict)


@dataclass
class UpgradeReport:
    from_version: str
    to_version: str
    guessed: bool = False
    steps: list[str] = field(default_factory=list)
    notes: list[UpgradeNote] = field(default_factory=list)
    #: Each blank default a step offered: {key, label, on, count, step}.
    defaults: list[dict] = field(default_factory=list)
    rows_in: dict[str, int] = field(default_factory=dict)
    rows_out: dict[str, int] = field(default_factory=dict)
    _index: dict[tuple, UpgradeNote] = field(default_factory=dict, repr=False)
    #: Undefined (table, column) pairs the last step kept, reported already
    #: (column None: a whole table).
    _carried: set[tuple[str, str | None]] = field(default_factory=set, repr=False)

    def add(
        self,
        level: Level,
        kind: str,
        message: str,
        *,
        step: str = "",
        table: str | None = None,
        column: str | None = None,
        to: Iterable[str] = (),
        key: tuple | None = None,
        count: int = 1,
    ) -> UpgradeNote:
        """Add a note, or count one more row against the note with the same
        `key` (default: step, kind, table, column, to)."""
        to = list(to)
        key = (step, kind, table, column, tuple(to)) if key is None else (step, kind, *key)
        note = self._index.get(key)
        if note is None:
            note = UpgradeNote(level, kind, message, step, table, column, to, count)
            self._index[key] = note
            self.notes.append(note)
        else:
            note.count += count
        return note

    @property
    def errors(self) -> list[UpgradeNote]:
        return [n for n in self.notes if n.level == "error"]

    @property
    def warnings(self) -> list[UpgradeNote]:
        return [n for n in self.notes if n.level == "warning"]

    def as_dict(self) -> dict:
        return {
            "from_version": self.from_version,
            "to_version": self.to_version,
            "guessed": self.guessed,
            "steps": self.steps,
            "notes": [n.as_dict() for n in self.notes],
            "defaults": self.defaults,
            "rows_in": self.rows_in,
            "rows_out": self.rows_out,
        }

    def as_text(self) -> str:
        """The report as plain text, kept beside the upgraded contribution."""
        lines = [
            f"Upgraded from data model version {self.from_version} to {self.to_version}"
            + (" (the old version was guessed)" if self.guessed else ""),
            "",
        ]
        titles = {"error": "Errors", "warning": "Warnings", "info": "Changes"}
        for level in ("error", "warning", "info"):
            notes = [n for n in self.notes if n.level == level]
            if not notes:
                continue
            lines.append(f"{titles[level]}:")
            for note in notes:
                count = f" ({note.count} rows)" if note.count > 1 else ""
                step = f"[{note.step}] " if note.step else ""
                lines.append(f"  - {step}{note.message}{count}")
            lines.append("")
        if self.defaults:
            lines.append("Blank values and the old model's defaults:")
            for d in self.defaults:
                state = "filled" if d["on"] else "left blank"
                lines.append(f"  - {d['label']}: {state} ({d['count']} rows)")
            lines.append("")
        lines.append("Rows by table: " + ", ".join(f"{t} {n}" for t, n in self.rows_out.items()))
        return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# Plugin hooks


@dataclass
class RowPlan:
    """How one old row is mapped: `row` (the old row, possibly rewritten),
    `tables` (when set, only these new tables receive its values — e.g. a
    result row that belongs to one level), `add` (new table -> values written
    as they are, bypassing the map) and `quiet` (columns dropped without a
    note, because the hook consumed them)."""

    row: Row
    tables: frozenset[str] | None = None
    add: dict[str, Row] = field(default_factory=dict)
    quiet: frozenset[str] = frozenset()


class UpgradeStep:
    """Hooks for one version step (`from_version` -> `to_version`) that a
    plugin supplies for what `previous_columns` cannot express. Every hook is
    optional; the base class maps by the models alone."""

    from_version: str = ""
    to_version: str = ""
    #: Blank defaults this step may fill (see BlankDefault).
    defaults: tuple[BlankDefault, ...] = ()
    #: New table -> the columns that identify an entity, for merging rows.
    #: Unset tables merge by their key() columns when several old tables
    #: feed them.
    merge_keys: dict[str, list[str]] = {}
    #: Old tables the new version replaces by other means (vocabularies, a
    #: citations column, ...): dropped with an info note giving the reason.
    retired_tables: dict[str, str] = {}
    #: Old columns dropped without a note when they map nowhere, or nowhere
    #: in the row's tables (names the hooks turn into structure, e.g. the
    #: parent names of a row).
    quiet_columns: frozenset[str] = frozenset()

    def prepare(self, ctx: "StepContext") -> None:
        """Rewrite `ctx.source` (the old tables) before mapping."""

    def map_row(self, ctx: "StepContext", table: str, index: int, row: Row) -> RowPlan | None:
        """Plan one old row (`index`: its position in `ctx.source[table]`);
        None drops it (add a note)."""
        return RowPlan(row)

    def map_value(
        self,
        ctx: "StepContext",
        table: str,
        column: str,
        new_table: str,
        new_column: str,
        value: str,
        new_row: Row,
    ) -> tuple[str, str] | None:
        """The (column, value) an old value lands in within `new_row`; None
        skips this target."""
        return new_column, value

    def finish_row(self, ctx: "StepContext", table: str, new_table: str, new_row: Row) -> None:
        """Adjust a new row mapped from an old row of `table` (defaults)."""

    def finish(self, ctx: "StepContext") -> None:
        """Adjust `ctx.out` after merging."""


class StepContext:
    """One step's state, handed to the hooks."""

    def __init__(
        self,
        source: Tables,
        old_version: str,
        new_version: str,
        old_model: dict,
        new_model: dict,
        hooks: UpgradeStep,
        options: UpgradeOptions,
        report: UpgradeReport,
        model_name: str,
    ):
        self.source = source
        self.old_version = old_version
        self.new_version = new_version
        self.old_model = old_model
        self.new_model = new_model
        self.hooks = hooks
        self.options = options
        self.report = report
        self.model_name = model_name
        self.step = f"{old_version} → {new_version}"
        self.upgrade_map = upgrade_map(new_model)
        #: Old table -> extra columns treated as defined in the old model.
        self.known_columns: dict[str, set[str]] = {}
        self.out: Tables = {}
        self.state: dict = {}
        self.carried = report._carried
        self.carry_out: set[tuple[str, str | None]] = set()
        self._defaults = {
            d.key: {
                "key": d.key,
                "label": d.label,
                "on": options.defaults.get(d.key, d.on),
                "count": 0,
                "step": self.step,
            }
            for d in hooks.defaults
        }

    # -- helpers for hooks -------------------------------------------------

    def note(self, level: Level, kind: str, message: str, **kwargs) -> UpgradeNote:
        return self.report.add(level, kind, message, step=self.step, **kwargs)

    def default(self, key: str) -> bool:
        """Whether blank default `key` is on; counts one more blank it fills
        (or would fill, when off)."""
        entry = self._defaults[key]
        entry["count"] += 1
        return entry["on"]

    def emit(self, table: str, row: Row) -> None:
        """Add a row to a new table directly (merged with the others)."""
        if row:
            self.out.setdefault(table, []).append(row)

    def column_def(self, table: str, column: str) -> dict:
        return self.new_model["tables"].get(table, {}).get("columns", {}).get(column, {})

    def old_columns(self, table: str) -> set[str]:
        columns = set(self.old_model["tables"].get(table, {}).get("columns", {}))
        return columns | self.known_columns.get(table, set()) | set(self.upgrade_map.get(table, {}))

    @property
    def defaults_offered(self) -> list[dict]:
        return list(self._defaults.values())


# --------------------------------------------------------------------------
# The engine


def split_terms(value: str) -> list[str]:
    return [t.strip() for t in str(value).split(":") if t.strip()]


def normalise_list(value: str) -> str:
    """A List/Dictionary cell as sorted unique terms, so rows that list the
    same terms in another order merge (legacy upgrade). Terms are trimmed."""
    return ":".join(sorted(set(split_terms(value))))


def _number_or_text(value) -> tuple:
    if value is None or value == "":
        return (2, 0.0, "")
    try:
        return (0, float(value), "")
    except (TypeError, ValueError):
        return (1, 0.0, str(value))


def _primary_table(ctx: StepContext, table: str) -> str:
    """The new table most of an old table's columns map into (its rows'
    home for columns the old model does not define)."""
    counts: dict[str, int] = {}
    for targets in ctx.upgrade_map.get(table, {}).values():
        for new_table, _ in targets:
            counts[new_table] = counts.get(new_table, 0) + 1
    if not counts:
        return table
    position = {t: d.get("position", 0) for t, d in ctx.new_model["tables"].items()}
    return min(counts, key=lambda t: (-counts[t], position.get(t, 0)))


def _move_kind(ctx: StepContext, new_table: str, new_column: str) -> str:
    """ "merged" when the contribution has values in more than one of the old
    columns the new column takes, else "renamed" (or moved)."""
    if "present" not in ctx.state:
        ctx.state["present"] = {(t, c) for t, rows in ctx.source.items() for r in rows for c in r}
    previous = ctx.column_def(new_table, new_column).get("previous_columns") or []
    used = [p for p in previous if (p.get("table"), p.get("column")) in ctx.state["present"]]
    return "merged" if len(used) > 1 else "renamed"


def _map_table(ctx: StepContext, table: str) -> None:
    hooks, rows = ctx.hooks, ctx.source[table]
    name = ctx.model_name
    if table in hooks.retired_tables:
        ctx.note(
            "info",
            "dropped_table",
            f'Table "{table}" is not part of {name} version {ctx.new_version}: '
            f"{hooks.retired_tables[table]}",
            table=table,
            count=len(rows),
        )
        return
    defined = table in ctx.old_model["tables"] or table in ctx.upgrade_map
    if not defined:
        keep = ctx.options.unknown_columns == "keep"
        if (table, None) not in ctx.carried:
            ctx.note(
                "warning",
                "unknown_table",
                f'Table "{table}" is not defined in {name} version {ctx.old_version}'
                + ("; kept as it is" if keep else "; dropped"),
                table=table,
                count=len(rows),
            )
        if keep:
            ctx.out.setdefault(table, []).extend(dict(r) for r in rows)
            ctx.carry_out.add((table, None))
        return
    if table not in ctx.upgrade_map:
        ctx.note(
            "warning",
            "dropped_table",
            f'Table "{table}" is not part of {name} version {ctx.new_version}; '
            "its rows were dropped",
            table=table,
            count=len(rows),
        )
        return
    columns = ctx.old_columns(table)
    primary = _primary_table(ctx, table)
    table_map = ctx.upgrade_map[table]
    for index, old_row in enumerate(rows):
        plan = hooks.map_row(ctx, table, index, dict(old_row))
        if plan is None:
            continue
        new_rows: dict[str, Row] = {}
        for column, value in plan.row.items():
            if value is None or value == "" or column in plan.quiet:
                continue
            targets = table_map.get(column)
            if targets is None:
                if column not in columns:
                    home = min(plan.tables) if plan.tables else primary
                    keep = ctx.options.unknown_columns == "keep"
                    if (table, column) not in ctx.carried:
                        ctx.note(
                            "warning",
                            "unknown_column",
                            f'Column "{column}" in table "{table}" is not defined in {name} '
                            f"version {ctx.old_version}"
                            + (f'; kept in table "{home}"' if keep else "; dropped"),
                            table=table,
                            column=column,
                            to=[f"{home}.{column}"] if keep else [],
                        )
                    if keep:
                        new_rows.setdefault(home, {})[column] = value
                        ctx.carry_out.add((home, column))
                elif column not in hooks.quiet_columns:
                    ctx.note(
                        "warning",
                        "dropped_column",
                        f'Column "{column}" in table "{table}" is unnecessary in {name} '
                        f"version {ctx.new_version}; its values were dropped",
                        table=table,
                        column=column,
                    )
                continue
            kept = False
            for new_table, new_column in targets:
                if plan.tables is not None and new_table not in plan.tables:
                    continue
                target = new_rows.setdefault(new_table, {})
                mapped = hooks.map_value(ctx, table, column, new_table, new_column, value, target)
                if mapped is None:
                    kept = True
                    continue
                landed, new_value = mapped
                if ctx.column_def(new_table, landed).get("type") in ("List", "Dictionary"):
                    new_value = normalise_list(new_value)
                if landed in target and target[landed] != new_value:
                    ctx.note(
                        "error",
                        "collision",
                        f'{name} version {ctx.old_version} column "{column}" in table '
                        f'"{table}" would put "{new_value}" into version {ctx.new_version} '
                        f'column "{landed}" of table "{new_table}", which already holds '
                        f'"{target[landed]}"; the first value was kept',
                        table=table,
                        column=column,
                        to=[f"{new_table}.{landed}"],
                    )
                    kept = True
                    continue
                target[landed] = new_value
                kept = True
                if (table, column) != (new_table, landed):
                    kind = _move_kind(ctx, new_table, landed)
                    ctx.note(
                        "info",
                        kind,
                        f"{table}.{column} → {new_table}.{landed}",
                        table=table,
                        column=column,
                        to=[f"{new_table}.{landed}"],
                    )
            if not kept and column not in hooks.quiet_columns:
                levels = ", ".join(sorted(plan.tables or ()))
                ctx.note(
                    "warning",
                    "dropped_value",
                    f'Values of "{column}" in table "{table}" were dropped: in {name} version '
                    f"{ctx.new_version} the {levels} table has no column for them",
                    table=table,
                    column=column,
                    to=sorted(plan.tables or ()),
                )
        for new_table, values in plan.add.items():
            new_rows.setdefault(new_table, {}).update({k: v for k, v in values.items() if v != ""})
        for new_table, new_row in new_rows.items():
            hooks.finish_row(ctx, table, new_table, new_row)
            if new_row:
                ctx.out.setdefault(new_table, []).append(new_row)


def _merge_keys(ctx: StepContext) -> dict[str, list[str]]:
    """Tables to merge and their keys: the step's merge_keys, else every new
    table that several old tables feed, by its key() columns."""
    keys = dict(ctx.hooks.merge_keys)
    feeders: dict[str, set[str]] = {}
    for old_table, columns in ctx.upgrade_map.items():
        for targets in columns.values():
            for new_table, _ in targets:
                feeders.setdefault(new_table, set()).add(old_table)
    for table, sources in feeders.items():
        if table in keys or len(sources) < 2:
            continue
        columns = ctx.new_model["tables"].get(table, {}).get("columns", {})
        key = [
            c
            for c, d in columns.items()
            if any(v.strip().startswith("key(") for v in d.get("validations") or [])
        ]
        if key:
            keys[table] = key
    return keys


def merge_rows(rows: list[Row], keys: list[str]) -> tuple[list[Row], int]:
    """Legacy `_mergePromise`: sort by the keys (numbers numerically), then
    fold each row into every later row with the same key values whose values
    do not contradict it (descriptions are joined), dropping the folded row.
    Returns the rows and how many were folded away."""
    rows = sorted(rows, key=lambda r: tuple(_number_or_text(r.get(k)) for k in keys))
    out: list[Row | None] = list(rows)
    folded = 0
    for i in range(len(out)):
        row = out[i]
        if row is None:
            continue
        row_keys = {k: row[k] for k in keys if k in row}
        merged_any = False
        for j in range(i + 1, len(out)):
            candidate = out[j]
            if candidate is None:
                continue
            if any(candidate.get(k) != v for k, v in row_keys.items()):
                break
            if any(
                column != "description" and column in candidate and candidate[column] != value
                for column, value in row.items()
            ):
                continue
            merged = {**row, **candidate}
            a, b = row.get("description"), candidate.get("description")
            if a and b and a != b:
                a = a.rstrip()
                separator = ";" if WORD_END.search(a) else ""
                merged["description"] = f"{a}{separator} {b}"
            out[j] = merged
            merged_any = True
        if merged_any:
            out[i] = None
            folded += 1
    return [r for r in out if r], folded


def _stamp_version(tables: Tables, new_model: dict, version: str) -> None:
    columns = new_model["tables"].get("contribution", {}).get("columns", {})
    target = next((c for c in VERSION_COLUMNS if c in columns), VERSION_COLUMNS[0])
    rows = tables.setdefault("contribution", [])
    if not rows:
        rows.append({})
    for column in VERSION_COLUMNS:
        rows[0].pop(column, None)
    rows[0][target] = version


def upgrade_step(
    tables: Tables,
    old_version: str,
    new_version: str,
    old_model: dict,
    new_model: dict,
    hooks: UpgradeStep,
    options: UpgradeOptions,
    report: UpgradeReport,
    model_name: str = "data model",
) -> Tables:
    """One version step; see the module docstring."""
    source = {t: [dict(r) for r in rows] for t, rows in tables.items()}
    ctx = StepContext(
        source, old_version, new_version, old_model, new_model, hooks, options, report, model_name
    )
    hooks.prepare(ctx)
    position = {t: d.get("position", 0) for t, d in old_model["tables"].items()}
    order = sorted(ctx.source, key=lambda t: (t not in position, position.get(t, 0)))
    for table in order:
        _map_table(ctx, table)
    _stamp_version(ctx.out, new_model, new_version)
    for table, keys in _merge_keys(ctx).items():
        if table in ctx.out:
            ctx.out[table], folded = merge_rows(ctx.out[table], keys)
            if folded:
                ctx.note(
                    "info",
                    "merged_rows",
                    f'Rows of table "{table}" describing the same {", ".join(keys)} were merged',
                    table=table,
                    count=folded,
                )
    hooks.finish(ctx)
    for table in list(ctx.out):
        ctx.out[table] = [r for r in ctx.out[table] if r]
        if not ctx.out[table]:
            del ctx.out[table]
    report.defaults.extend(ctx.defaults_offered)
    report._carried = ctx.carry_out
    return ctx.out


def apply_renames(tables: Tables, renames: dict[str, str], report: UpgradeReport) -> Tables:
    """The contributor's renames ("table.column" -> column, "" drops it),
    before the upgrade."""
    if not renames:
        return tables
    out = {}
    for table, rows in tables.items():
        moves = {
            key.split(".", 1)[1]: new
            for key, new in renames.items()
            if "." in key and key.split(".", 1)[0] == table
        }
        if not moves:
            out[table] = rows
            continue
        for old, new in moves.items():
            report.add(
                "info",
                "renamed",
                f"{table}.{old} → {table}.{new}" if new else f"{table}.{old} ignored",
                step="",
                table=table,
                column=old,
                to=[f"{table}.{new}"] if new else [],
                count=0,
            )
        out[table] = [
            {moves.get(c, c): v for c, v in row.items() if moves.get(c, c) != ""} for row in rows
        ]
    return out


def upgrade(
    parsed: ParsedContribution,
    chain: list[str],
    load_model: Callable[[str], dict],
    hooks: dict[tuple[str, str], UpgradeStep] | None = None,
    options: UpgradeOptions | None = None,
    *,
    guessed: bool = False,
    model_name: str = "data model",
) -> tuple[ParsedContribution, UpgradeReport]:
    """Upgrade `parsed`, written in `chain[0]`, step by step to `chain[-1]`."""
    options = options or UpgradeOptions()
    hooks = hooks or {}
    report = UpgradeReport(chain[0], chain[-1], guessed=guessed)
    if guessed:
        report.add(
            "warning",
            "version",
            f"The contribution does not name its data model version; guessed that the "
            f"contribution is using {model_name} version {chain[0]}",
        )
    report.rows_in = {t: len(r) for t, r in parsed.tables.items()}
    tables = apply_renames(parsed.tables, options.renames, report)
    for old_version, new_version in zip(chain, chain[1:], strict=False):
        report.steps.append(f"{old_version} → {new_version}")
        step = hooks.get((old_version, new_version)) or UpgradeStep()
        tables = upgrade_step(
            tables,
            old_version,
            new_version,
            load_model(old_version),
            load_model(new_version),
            step,
            options,
            report,
            model_name,
        )
    report.rows_out = {t: len(r) for t, r in tables.items()}
    return ParsedContribution(tables=tables), report
