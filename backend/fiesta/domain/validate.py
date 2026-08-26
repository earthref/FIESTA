"""Validation engine.

Interprets the validation DSL embedded in data-model column definitions
(`validations: ['required()', 'cv("geologic_classes")', 'min(-90)', ...]`)
against parsed contribution rows, using the node's controlled/suggested
vocabularies and method codes.

Implemented checks: unknown table/column, column type coercion
(Integer/Number/Timestamp), required(), cv(), sv() (warning), min(), max(),
recommended() (warning), unique(). Other DSL calls (downloadOnly, key,
requiredIf/Unless variants, in, matrix, type) are accepted but not enforced
yet — they never fail a contribution that legacy FIESTA would accept.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime

from fiesta.domain.data_model import column_values
from fiesta.domain.parse import ParsedContribution
from fiesta.nodeconfig import NodeConfig

CALL_RE = re.compile(r'^(\w+)\((.*)\)$')


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
    match = CALL_RE.match(validation.strip())
    if not match:
        return validation, []
    name, raw_args = match.group(1), match.group(2)
    args = [a.strip().strip('"').strip("'") for a in raw_args.split(",")] if raw_args else []
    return name, args


def _coerce_number(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def _check_type(column_type: str, value: str) -> str | None:
    """Return an error message if the raw cell fails the column type."""
    if column_type == "Integer":
        try:
            int(value)
        except ValueError:
            return f"expected an integer, got {value!r}"
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


class Validator:
    def __init__(self, node: NodeConfig, model_version: str | None = None):
        self.node = node
        version = model_version or node.data_model.latest
        self.model = node.load_data_model(version)
        self.cvs = node.load_controlled_vocabularies()
        self.svs = node.load_suggested_vocabularies()
        self.method_codes = self._flatten_method_codes(node.load_method_codes())
        self._cv_items_cache: dict[str, set[str]] = {}

    @staticmethod
    def _flatten_method_codes(method_codes: dict | None) -> set[str] | None:
        if not method_codes:
            return None
        codes: set[str] = set()
        for group in method_codes.values():
            for entry in group.get("codes", []):
                if entry.get("code"):
                    codes.add(str(entry["code"]).upper())
        return codes

    def _cv_items(self, name: str) -> set[str] | None:
        if name in self._cv_items_cache:
            return self._cv_items_cache[name]
        vocab = self.cvs.get(name)
        items = None
        if vocab is not None:
            items = {str(i["item"]) for i in vocab.get("items", []) if "item" in i}
        elif name == "method_codes" and self.method_codes is not None:
            items = self.method_codes
        self._cv_items_cache[name] = items
        return items

    def validate(self, parsed: ParsedContribution) -> ValidationReport:
        report = ValidationReport()
        model_tables = self.model["tables"]

        for table, rows in parsed.tables.items():
            table_def = model_tables.get(table)
            if table_def is None:
                report.errors.append(Issue(table, None, None, f"unrecognized table {table!r}"))
                continue
            columns_def = table_def.get("columns", {})
            self._validate_table(table, rows, columns_def, report)

        return report

    def _validate_table(
        self, table: str, rows: list[dict[str, str]], columns_def: dict, report: ValidationReport
    ) -> None:
        present_columns: set[str] = set()
        for row in rows:
            present_columns.update(row)
        for column in sorted(present_columns - set(columns_def)):
            report.errors.append(
                Issue(table, None, column, f"unrecognized column {column!r} in table {table!r}")
            )

        # Column-level required/recommended (a required column must appear in every row).
        for column, column_def in columns_def.items():
            validations = column_def.get("validations") or []
            calls = dict(_parse_call(v) for v in validations)
            if "required()" in validations or "required" in calls:
                for i, row in enumerate(rows, start=1):
                    if not row.get(column):
                        report.errors.append(
                            Issue(table, i, column, f"missing required value for {column!r}")
                        )
            elif ("recommended" in calls) and rows and not any(row.get(column) for row in rows):
                report.warnings.append(
                    Issue(table, None, column, f"recommended column {column!r} has no values")
                )

        seen_unique: dict[str, set[str]] = {}
        for i, row in enumerate(rows, start=1):
            for column, raw_value in row.items():
                column_def = columns_def.get(column)
                if column_def is None:
                    continue
                self._validate_cell(table, i, column, column_def, raw_value, seen_unique, report)

    def _validate_cell(
        self,
        table: str,
        row_number: int,
        column: str,
        column_def: dict,
        raw_value: str,
        seen_unique: dict[str, set[str]],
        report: ValidationReport,
    ) -> None:
        type_error = None
        column_type = column_def.get("type", "String")
        if column_type in ("Integer", "Number", "Timestamp"):
            type_error = _check_type(column_type, raw_value)
        if type_error:
            report.errors.append(Issue(table, row_number, column, type_error))
            return

        values = column_values(column_def, raw_value)
        for validation in column_def.get("validations") or []:
            name, args = _parse_call(validation)
            if name == "cv" and args:
                self._check_vocabulary(
                    table, row_number, column, args[0], values, report, error=True
                )
            elif name == "sv" and args:
                self._check_vocabulary(
                    table, row_number, column, args[0], values, report, error=False
                )
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
            # Remaining DSL calls are intentionally not enforced yet (see module docstring).

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
        for value in values:
            candidate = value.upper() if vocab_name == "method_codes" else value
            if candidate not in items:
                target.append(
                    Issue(
                        table,
                        row_number,
                        column,
                        f"{value!r} is not in the {kind} vocabulary {vocab_name!r}",
                    )
                )

    def _sv_items(self, name: str) -> set[str] | None:
        vocab = self.svs.get(name)
        if vocab is None:
            return None
        return {str(i["item"]) for i in vocab.get("items", []) if "item" in i}


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
