"""Validation engine.

Interprets the validation DSL embedded in data-model column definitions
(`validations: ['required()', 'cv("geologic_classes")', 'min(-90)', ...]`)
against parsed contribution rows, using the node's controlled/suggested
vocabularies and those its active plugins supply (FiestaPlugin.vocabularies).
Ported from the legacy validate_contribution.js (MagIC, KArAr, CDR, KdD),
with its per-table `requiredIfGroup` fixed to check each row (MagIC #564).

Errors fail a contribution; warnings never do. The DSL:

- table and column names: an unrecognized table or column is an error; one
  that differs from the data model only in case says how it is spelled
  (MagIC #363). A column with values but no name says which column it is.
- column `type`: Integer (within OpenSearch's signed 64-bit long, MagIC
  #485), Number, Timestamp. A Number with implausibly many significant
  digits (a spreadsheet's 0.30000000000000004) is a warning (MagIC #127,
  #133); the value is never changed.
- `required()`: every row needs a value. A column absent from the whole table
  is one error, not one per row; the workspace table's blank `reference` says
  to enter the contribution's reference DOI (MagIC #491, #399).
- conditional requirements, each checked within one row:
  `requiredIf("a", ...)` (when any named column has a value),
  `requiredIfGroup("g")` (when any column of group g has a value, MagIC #564),
  `requiredOneInGroup("g")` (one error per row whose group g is all blank),
  `requiredUnless("a", ...)` (when every named column is blank),
  `requiredUnlessTable("t")` (when the contribution has no table t),
  `requiredIf<Column>("v", ...)` (when the row's <column>, the CamelCase suffix
  in snake_case, is one of the values: requiredIfAgeCalculationMethod), and
  `requiredUnless<Group>()` (when no column of that group has a value:
  requiredUnlessSynthetic). A rule whose group or column the table lacks
  (requiredUnlessNatural, requiredUnlessLegacy) cannot be decided from the
  data and is not enforced; `Validator.unresolved` lists those met. The last
  two families warn rather than fail (see INFERRED_SEVERITY). A blank row
  that several columns' requiredUnless rules name each other for (age,
  age_low, age_high) is reported once.
- `cv("name")` (error) / `sv("name")` (warning): each value of a List, the key
  of each Dictionary entry (before `[`), the first element of each Matrix row.
  A term that differs only in case says how the vocabulary spells it (MagIC
  #453); the upload page's import step corrects it (importer.correct_term).
- `type("name")`: a controlled vocabulary of that name (method_codes) is
  checked as cv(); `doi`, `url` and `email` values of the wrong shape warn.
- `min(n)`, `max(n)`, `unique()`, `matrix(rows, columns)` (0 = any).
- `in("table.column")`: each value must be one of that table's column. When
  the table is missing, a required column is one error naming the table
  (MagIC #423, #454); an optional one is one warning.
- `recommended()`: a column with no values at all is a warning, never an
  error (MagIC #590).
- `key()` (the merge key the upgrader uses) and `downloadOnly()` (columns the
  system writes) are data-model metadata, not checks.

The grid editor repeats the single-cell checks in the browser
(fiesta/frontend/src/lib/contribution-grid.ts `checkCell`) with the same
wording; change both together.
"""

import math
import re
from dataclasses import dataclass, field
from datetime import datetime

from fiesta.domain.data_model import LIST_TYPES
from fiesta.domain.parse import ParsedContribution
from fiesta.nodeconfig import NodeConfig

CALL_RE = re.compile(r"^(\w+)\((.*)\)$")
# The legacy 2.x models write `in:er_sites.er_site_name`.
IN_COLON_RE = re.compile(r"^in:(\S+)$")
UNNAMED_RE = re.compile(r"^_unnamed_(\d+)$")
LONG_MAX = 2**63 - 1
LONG_MIN = -(2**63)
# A Number with this many significant digits is past what any instrument
# measures: a binary float printed in full (0.30000000000000004).
SIGNIFICANT_DIGITS = 16
# Fewer digits still look like an artefact when a run of zeros or nines ends
# a digit or three before the end (12.3000000001, 4.1999999999998).
ARTEFACT_RE = re.compile(r"(0{6,}|9{6,})\d{1,3}$")
MANTISSA_RE = re.compile(r"^[+-]?(\d*)\.?(\d*)(?:[eE][+-]?\d+)?$")
DOI_RE = re.compile(r"^(?:(?:https?://)?(?:dx\.)?doi\.org/|doi:)?10\.\d{4,9}/\S+$", re.I)
URL_RE = re.compile(r"^(?:https?|ftp)://\S+\.\S+$", re.I)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
FORMAT_TYPES = {
    "doi": (DOI_RE, "a DOI (10.xxxx/...)"),
    "url": (URL_RE, "a URL (https://...)"),
    "email": (EMAIL_RE, "an email address"),
}
# Per-cell warnings of one kind kept per column before they are summarised.
MAX_CELL_WARNINGS = 100

# The conditional requirements the legacy validators enforced (requiredIf,
# requiredIfGroup, requiredOneInGroup, requiredUnless, requiredUnlessTable)
# are errors. The two families no legacy validator implemented,
# requiredIf<Column>("v") and requiredUnless<Group>(), only warn: published
# data was never held to them, and as errors they fail thousands of rows of
# legacy-imported MagIC samples and specimens (requiredUnlessSynthetic) and
# KArAr experiments (requiredIfAgeCalculationMethod) on their next edit.
INFERRED_SEVERITY = "warning"


@dataclass
class Issue:
    table: str
    row: int | None
    column: str | None
    message: str

    def as_dict(self) -> dict:
        return {
            "table": self.table,
            "row": self.row,
            "column": self.column,
            "message": self.message,
        }


@dataclass
class ValidationReport:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict:
        return {
            "is_valid": self.is_valid,
            "errors": [e.as_dict() for e in self.errors],
            "warnings": [w.as_dict() for w in self.warnings],
        }


def _parse_call(validation: str) -> tuple[str, list[str]]:
    validation = validation.strip()
    if match := IN_COLON_RE.match(validation):
        return "in", [match.group(1)]
    match = CALL_RE.match(validation)
    if not match:
        return validation, []
    name, raw_args = match.group(1), match.group(2)
    args = [a.strip().strip('"').strip("'") for a in raw_args.split(",")] if raw_args else []
    return name, args


def _calls(column_def: dict) -> list[tuple[str, list[str]]]:
    return [_parse_call(v) for v in column_def.get("validations") or [] if v and v.strip()]


def _snake(camel: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", camel).lower()


def _coerce_number(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def _split_outside_quotes(value: str, delimiter: str) -> list[str]:
    """Split on a delimiter that is not inside double quotes (legacy
    splitOutsideQuotes)."""
    parts, start, quoted = [], 0, False
    for i, char in enumerate(value):
        if char == '"':
            quoted = not quoted
        elif char == delimiter and not quoted:
            parts.append(value[start:i])
            start = i + 1
    parts.append(value[start:])
    return parts


def cell_values(column_def: dict, value: str) -> list[str]:
    """The values a cell holds, as list and vocabulary checks see them: each
    item of a List, the key of each Dictionary entry (`KEY[value]`), the first
    element of each Matrix row (rows split on `;`, elements on `:`)."""
    if not value:
        return []
    column_type = column_def.get("type")
    if column_type == "Matrix":
        rows = [r.strip() for r in _split_outside_quotes(value, ";") if r.strip()]
        return [r.split(":", 1)[0].strip() for r in rows]
    if column_type in LIST_TYPES:
        items = [v.strip() for v in _split_outside_quotes(value, ":") if v.strip()]
        if column_type == "Dictionary":
            items = [v.split("[", 1)[0].strip() for v in items]
        return [v for v in items if v]
    return [value]


def _check_type(column_type: str, value: str) -> str | None:
    """Return an error message if the raw cell fails the column type."""
    if column_type == "Integer":
        try:
            number = int(value)
        except ValueError:
            return f"expected an integer, got {value!r}"
        if not LONG_MIN <= number <= LONG_MAX:
            return f"{value.strip()} is too large for an integer column (at most 19 digits)"
    elif column_type == "Number":
        if _coerce_number(value) is None:
            return f"expected a number, got {value!r}"
    elif column_type == "Timestamp":
        normalized = value.replace("Z", "+00:00")
        try:
            datetime.fromisoformat(normalized)
        except ValueError:
            return f"expected an ISO 8601 timestamp, got {value!r}"
    return None


def significant_digits(value: str) -> str | None:
    """A Number cell's significant digits, when there are implausibly many
    of them (see SIGNIFICANT_DIGITS, ARTEFACT_RE), else None."""
    match = MANTISSA_RE.match(value.strip())
    if not match:
        return None
    digits = (match.group(1) + match.group(2)).lstrip("0")
    if len(match.group(2)) == 0:
        # A whole number's trailing zeros are not significant (2000000000).
        digits = digits.rstrip("0")
    if len(digits) >= SIGNIFICANT_DIGITS or (len(digits) >= 10 and ARTEFACT_RE.search(digits)):
        return digits
    return None


def _rounded(value: str) -> str:
    number = float(value)
    return f"{number:.12g}" if math.isfinite(number) else value


def _quoted(names: list[str]) -> str:
    quoted = [f"'{n}'" for n in names]
    return quoted[0] if len(quoted) == 1 else ", ".join(quoted[:-1]) + " and " + quoted[-1]


def _a(noun: str) -> str:
    return f"{'an' if noun[:1].lower() in 'aeiou' else 'a'} {noun}"


@dataclass
class _TableContext:
    """What one table's checks need to know about the rest of the contribution."""

    table: str
    rows: list[dict[str, str]]
    columns_def: dict
    groups: dict[str, list[str]]
    present_tables: set[str]


class Validator:
    def __init__(self, node: NodeConfig, model_version: str | None = None):
        self.node = node
        version = model_version or node.data_model.latest
        self.model = node.load_data_model(version)
        self.cvs = node.load_controlled_vocabularies()
        self.svs = node.load_suggested_vocabularies()
        from fiesta.plugins import active_plugins

        self.plugin_cvs = {
            name: vocabulary
            for plugin in active_plugins(node)
            for name, vocabulary in plugin.vocabularies(node).items()
        }
        self._cv_items_cache: dict[str, set[str] | None] = {}
        self._lower_cache: dict[tuple[str, str], dict[str, str]] = {}
        # Vocabularies whose values are compared upper-cased.
        self._upper: set[str] = set()
        # (table, column, rule) of conditional requirements the data cannot decide.
        self.unresolved: set[tuple[str, str, str]] = set()

    def _cv_items(self, name: str) -> set[str] | None:
        if name in self._cv_items_cache:
            return self._cv_items_cache[name]
        vocab = self.cvs.get(name)
        items = None
        if vocab is not None:
            items = {str(i["item"]) for i in vocab.get("items", []) if "item" in i}
        elif (supplied := self.plugin_cvs.get(name)) is not None:
            items = set(supplied.items)
            if supplied.case_insensitive:
                items = {i.upper() for i in items}
                self._upper.add(name)
        self._cv_items_cache[name] = items
        return items

    def vocabulary_terms(self, name: str) -> set[str] | None:
        """A controlled vocabulary's terms as spelled, or None for one whose
        values are compared case-insensitively (or that does not exist)."""
        items = self._cv_items(name)
        return None if name in self._upper else items

    def _sv_items(self, name: str) -> set[str] | None:
        vocab = self.svs.get(name)
        if vocab is None:
            return None
        return {str(i["item"]) for i in vocab.get("items", []) if "item" in i}

    def validate(self, parsed: ParsedContribution) -> ValidationReport:
        report = ValidationReport()
        model_tables = self.model["tables"]
        present = {t for t, rows in parsed.tables.items() if rows}
        self._keys: dict[tuple[str, str], set[str]] = {}
        self._parsed = parsed
        by_lower = {t.lower(): t for t in model_tables}

        for table, rows in parsed.tables.items():
            table_def = model_tables.get(table)
            if table_def is None:
                spelled = by_lower.get(table.lower())
                hint = f"; the data model spells it {spelled!r}" if spelled else ""
                report.errors.append(
                    Issue(table, None, None, f"unrecognized table {table!r}{hint}")
                )
                continue
            columns_def = table_def.get("columns", {})
            groups: dict[str, list[str]] = {}
            for column, column_def in columns_def.items():
                if column_def.get("group"):
                    groups.setdefault(column_def["group"], []).append(column)
            context = _TableContext(table, rows, columns_def, groups, present)
            self._validate_table(context, report)

        workspace = self.node.workspace.table
        if len(parsed.tables.get(workspace) or []) > 1 and workspace in model_tables:
            report.errors.append(
                Issue(
                    workspace,
                    None,
                    None,
                    f"the {workspace} table has {len(parsed.tables[workspace])} rows; "
                    "it must have exactly one",
                )
            )
        return report

    # ---- one table -------------------------------------------------------------

    def _validate_table(self, ctx: _TableContext, report: ValidationReport) -> None:
        table, rows, columns_def = ctx.table, ctx.rows, ctx.columns_def
        present_columns: set[str] = set()
        for row in rows:
            present_columns.update(row)
        by_lower = {c.lower(): c for c in columns_def}
        for column in sorted(present_columns - set(columns_def)):
            if unnamed := UNNAMED_RE.match(column):
                message = (
                    f"column {unnamed.group(1)} of table {table!r} has values but no "
                    "name in the header row"
                )
            elif spelled := by_lower.get(column.lower()):
                message = (
                    f"unrecognized column {column!r} in table {table!r}; "
                    f"the data model spells it {spelled!r}"
                )
            else:
                message = f"unrecognized column {column!r} in table {table!r}"
            report.errors.append(Issue(table, None, column, message))

        for column, column_def in columns_def.items():
            calls = _calls(column_def)
            names = {name for name, _ in calls}
            if "required" in names:
                self._check_required(ctx, column, present_columns, report)
            elif "recommended" in names and rows and column not in present_columns:
                report.warnings.append(
                    Issue(table, None, column, f"recommended column {column!r} has no values")
                )
            self._check_conditional(ctx, column, calls, report)
            for name, args in calls:
                if name == "in" and args:
                    self._check_reference(ctx, column, args[0], "required" in names, report)

        seen_unique: dict[str, set[str]] = {}
        warned: dict[tuple[str, str], int] = {}
        for i, row in enumerate(rows, start=1):
            for column, raw_value in row.items():
                column_def = columns_def.get(column)
                if column_def is None:
                    continue
                self._validate_cell(
                    table, i, column, column_def, raw_value, seen_unique, warned, report
                )
        for (column, kind), count in sorted(warned.items()):
            if count > MAX_CELL_WARNINGS:
                report.warnings.append(
                    Issue(
                        table,
                        None,
                        column,
                        f"{count - MAX_CELL_WARNINGS} more values in {column!r} {kind}",
                    )
                )

    def _check_required(
        self, ctx: _TableContext, column: str, present: set[str], report: ValidationReport
    ) -> None:
        table, rows = ctx.table, ctx.rows
        if not rows:
            return
        if table == self.node.workspace.table and column == "reference":
            if not any(row.get(column) for row in rows):
                report.errors.append(
                    Issue(
                        table,
                        1,
                        column,
                        "the contribution has no reference DOI: enter the DOI of the "
                        "publication these data come from in the contribution's "
                        "Reference field",
                    )
                )
            return
        if column not in present and len(rows) > 1:
            report.errors.append(
                Issue(
                    table,
                    None,
                    column,
                    f"the {table} table has no {column!r} column, which is required in every row",
                )
            )
            return
        for i, row in enumerate(rows, start=1):
            if not row.get(column):
                report.errors.append(
                    Issue(table, i, column, f"missing required value for {column!r}")
                )

    def _check_conditional(
        self,
        ctx: _TableContext,
        column: str,
        calls: list[tuple[str, list[str]]],
        report: ValidationReport,
    ) -> None:
        """The requiredIf/requiredUnless family, each decided within one row."""
        table, rows = ctx.table, ctx.rows
        conditions = []  # (predicate(row) -> reason or None, legacy rule?)
        one_in_groups = []
        for name, args in calls:
            if name == "required" or not name.startswith("required"):
                continue
            if name == "requiredIf" and args:
                conditions.append((self._if_columns(args), True))
            elif name == "requiredIfGroup" and args:
                if (members := ctx.groups.get(args[0])) is not None:
                    conditions.append((self._if_group(args[0], members, column), True))
                else:
                    self.unresolved.add((table, column, f"{name}({args[0]})"))
            elif name == "requiredOneInGroup" and args:
                if (members := ctx.groups.get(args[0])) is not None and column in members:
                    one_in_groups.append((args[0], members))
                else:
                    self.unresolved.add((table, column, f"{name}({args[0]})"))
            elif name == "requiredUnless" and args:
                if not self._reported_by_partner(ctx, column, args):
                    conditions.append((self._unless_columns(args), True))
            elif name == "requiredUnlessTable" and args:
                if args[0] not in ctx.present_tables:
                    conditions.append((lambda row, t=args[0]: f"there is no {t!r} table", True))
            elif name.startswith("requiredIf") and args:
                target = _snake(name[len("requiredIf") :])
                if target in ctx.columns_def:
                    conditions.append((self._if_value(target, args), False))
                else:
                    self.unresolved.add((table, column, name))
            elif name.startswith("requiredUnless") and not args:
                group = name[len("requiredUnless") :]
                if (members := ctx.groups.get(group)) is not None:
                    conditions.append((self._unless_group(group, members), False))
                else:
                    self.unresolved.add((table, column, name))
            else:
                self.unresolved.add((table, column, name))

        if conditions:
            for i, row in enumerate(rows, start=1):
                if row.get(column):
                    continue
                for predicate, legacy in conditions:
                    if reason := predicate(row):
                        strict = legacy or INFERRED_SEVERITY == "error"
                        (report.errors if strict else report.warnings).append(
                            Issue(
                                table,
                                i,
                                column,
                                f"missing required value for {column!r} since {reason}",
                            )
                        )
                        break
        for group, members in one_in_groups:
            # One issue per row, on the group's first column with the rule.
            first = next(
                c
                for c in members
                if any(n == "requiredOneInGroup" for n, _ in _calls(ctx.columns_def[c]))
            )
            if column != first:
                continue
            for i, row in enumerate(rows, start=1):
                if not any(row.get(c) for c in members):
                    report.errors.append(
                        Issue(
                            table,
                            i,
                            column,
                            f"missing a value in one of {_quoted(members)} (group {group!r})",
                        )
                    )

    @staticmethod
    def _reported_by_partner(ctx: _TableContext, column: str, others: list[str]) -> bool:
        """Whether an earlier column's requiredUnless names this one among
        its alternatives (age / age_low / age_high), so that blank row is
        reported once, on that column."""
        order = list(ctx.columns_def)
        for other in others:
            if other not in ctx.columns_def or order.index(other) > order.index(column):
                continue
            for name, args in _calls(ctx.columns_def[other]):
                if name == "requiredUnless" and column in args:
                    return True
        return False

    @staticmethod
    def _if_columns(others: list[str]):
        def predicate(row):
            filled = [c for c in others if row.get(c)]
            return (
                f"{_quoted(filled)} {'has' if len(filled) == 1 else 'have'} a value"
                if filled
                else None
            )

        return predicate

    @staticmethod
    def _if_group(group: str, members: list[str], column: str):
        others = [c for c in members if c != column]

        def predicate(row):
            filled = [c for c in others if row.get(c)]
            return f"group {group!r} has values ({_quoted(filled)})" if filled else None

        return predicate

    @staticmethod
    def _unless_columns(others: list[str]):
        def predicate(row):
            if any(row.get(c) for c in others):
                return None
            return f"{_quoted(others)} {'is' if len(others) == 1 else 'are'} empty"

        return predicate

    @staticmethod
    def _if_value(target: str, values: list[str]):
        def predicate(row):
            value = row.get(target)
            return f"{target!r} is {value!r}" if value in values else None

        return predicate

    @staticmethod
    def _unless_group(group: str, members: list[str]):
        def predicate(row):
            if any(row.get(c) for c in members):
                return None
            return f"no column of group {group!r} has a value"

        return predicate

    def _keys_of(self, table: str, column: str) -> set[str]:
        key = (table, column)
        if key not in self._keys:
            column_def = self.model["tables"].get(table, {}).get("columns", {}).get(column, {})
            self._keys[key] = {
                v
                for row in self._parsed.tables.get(table, [])
                for v in cell_values(column_def, row.get(column, ""))
            }
        return self._keys[key]

    def _check_reference(
        self,
        ctx: _TableContext,
        column: str,
        target: str,
        required: bool,
        report: ValidationReport,
    ) -> None:
        """`in("table.column")`: values must name rows of another table."""
        ref_table, _, ref_column = target.partition(".")
        if not ref_column or ref_table not in self.model["tables"]:
            return
        table, rows = ctx.table, ctx.rows
        column_def = ctx.columns_def[column]
        if ref_table not in ctx.present_tables:
            if required and rows:
                report.errors.append(
                    Issue(
                        table,
                        None,
                        column,
                        f"there is no {ref_table} table: each {table} row names {_a(ref_column)} "
                        f"from it in {column!r}, so add a {ref_table} table "
                        f"with a row for each {ref_column}",
                    )
                )
            elif any(row.get(column) for row in rows):
                report.warnings.append(
                    Issue(
                        table,
                        None,
                        column,
                        f"{column!r} names rows of the {ref_table} table, but there is "
                        f"no {ref_table} table",
                    )
                )
            return
        keys = self._keys_of(ref_table, ref_column)
        for i, row in enumerate(rows, start=1):
            for value in cell_values(column_def, row.get(column, "")):
                if value not in keys:
                    report.errors.append(
                        Issue(
                            table,
                            i,
                            column,
                            f"{value!r} is not {_a(ref_column)} in the {ref_table} table",
                        )
                    )

    # ---- one cell --------------------------------------------------------------

    def _validate_cell(
        self,
        table: str,
        row_number: int,
        column: str,
        column_def: dict,
        raw_value: str,
        seen_unique: dict[str, set[str]],
        warned: dict[tuple[str, str], int],
        report: ValidationReport,
    ) -> None:
        type_error = None
        column_type = column_def.get("type", "String")
        if column_type in ("Integer", "Number", "Timestamp"):
            type_error = _check_type(column_type, raw_value)
        if type_error:
            report.errors.append(Issue(table, row_number, column, type_error))
            return

        def warn(kind: str, message: str) -> None:
            count = warned.get((column, kind), 0) + 1
            warned[(column, kind)] = count
            if count <= MAX_CELL_WARNINGS:
                report.warnings.append(Issue(table, row_number, column, message))

        if column_type == "Number" and (digits := significant_digits(raw_value)):
            warn(
                "have implausibly many significant digits",
                f"{raw_value} has {len(digits)} significant digits, likely a spreadsheet "
                f"rounding artefact; round it to the precision measured (e.g. "
                f"{_rounded(raw_value)})",
            )

        values = cell_values(column_def, raw_value)
        for name, args in _calls(column_def):
            if name == "cv" and args:
                self._check_vocabulary(
                    table, row_number, column, args[0], values, report, error=True
                )
            elif name == "sv" and args:
                self._check_vocabulary(
                    table, row_number, column, args[0], values, report, error=False
                )
            elif name == "type" and args:
                if self._cv_items(args[0]) is not None:
                    self._check_vocabulary(
                        table, row_number, column, args[0], values, report, error=True
                    )
                elif (shape := FORMAT_TYPES.get(args[0])) is not None:
                    pattern, what = shape
                    for value in values:
                        if not pattern.match(value):
                            warn(f"are not {what}", f"{value!r} does not look like {what}")
            elif name in ("min", "max") and args:
                bound = _coerce_number(args[0])
                number = _coerce_number(raw_value)
                if bound is None or number is None:
                    continue
                if name == "min" and number < bound:
                    report.errors.append(
                        Issue(table, row_number, column, f"{number} is below the minimum {bound}")
                    )
                if name == "max" and number > bound:
                    report.errors.append(
                        Issue(table, row_number, column, f"{number} is above the maximum {bound}")
                    )
            elif name == "unique":
                seen = seen_unique.setdefault(f"{table}.{column}", set())
                if raw_value in seen:
                    report.errors.append(
                        Issue(
                            table,
                            row_number,
                            column,
                            f"duplicate value {raw_value!r} in unique column",
                        )
                    )
                seen.add(raw_value)
            elif name == "matrix" and column_type == "Matrix":
                self._check_matrix(table, row_number, column, raw_value, args, report)

    @staticmethod
    def _check_matrix(
        table: str,
        row_number: int,
        column: str,
        raw_value: str,
        args: list[str],
        report: ValidationReport,
    ) -> None:
        """`matrix(rows, columns)`: a `;`-separated list of `:`-separated rows,
        of exactly that many rows and values per row (0: any number)."""
        try:
            n_rows, n_columns = (int(a) for a in (args + ["0", "0"])[:2])
        except ValueError:
            return
        rows = [r for r in _split_outside_quotes(raw_value, ";") if r.strip()]
        if n_rows and len(rows) != n_rows:
            report.errors.append(
                Issue(
                    table,
                    row_number,
                    column,
                    f"expected a matrix of {n_rows} rows separated by ';', got {len(rows)}",
                )
            )
        if n_columns:
            for i, matrix_row in enumerate(rows, start=1):
                width = len(_split_outside_quotes(matrix_row, ":"))
                if width != n_columns:
                    report.errors.append(
                        Issue(
                            table,
                            row_number,
                            column,
                            f"matrix row {i} has {width} values separated by ':'; "
                            f"expected {n_columns}",
                        )
                    )

    def _check_vocabulary(
        self,
        table: str,
        row_number: int,
        column: str,
        vocab_name: str,
        values: list[str],
        report: ValidationReport,
        *,
        error: bool,
    ) -> None:
        items = self._cv_items(vocab_name) if error else self._sv_items(vocab_name)
        if items is None:
            return
        target = report.errors if error else report.warnings
        kind = "controlled" if error else "suggested"
        upper = error and vocab_name in self._upper
        for value in values:
            candidate = value.upper() if upper else value
            if candidate not in items:
                message = f"{value!r} is not in the {kind} vocabulary {vocab_name!r}"
                if not upper and (spelled := self._spelled(kind, vocab_name, items, value)):
                    message += f"; it is spelled {spelled!r}"
                target.append(Issue(table, row_number, column, message))

    def _spelled(self, kind: str, name: str, items: set[str], value: str) -> str | None:
        """The vocabulary's spelling of a term that differs only in case."""
        key = (kind, name)
        if key not in self._lower_cache:
            self._lower_cache[key] = {i.lower(): i for i in items}
        return self._lower_cache[key].get(value.lower())


def validate_contribution(
    node: NodeConfig, parsed: ParsedContribution, model_version: str | None = None
) -> ValidationReport:
    return Validator(node, model_version).validate(parsed)


def guess_data_model_version(node: NodeConfig, parsed: ParsedContribution) -> str:
    rows = parsed.tables.get("contribution", [])
    for row in rows:
        for key in ("data_model_version", "magic_version", "version"):
            value = row.get(key)
            if value and value in node.data_model.versions:
                return value
    return node.data_model.latest
