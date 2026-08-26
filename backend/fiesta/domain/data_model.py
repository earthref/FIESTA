"""Helpers over the JSON data models (config/<node>/data_models/*.json).

A model is `{data_model_version, tables: {name: {label, position, columns:
{name: {label, type, unit, validations: [...], ...}}}}}`. Column `type` is one
of Integer, Number, String, Text, Timestamp, List, Matrix, Dictionary.
"""

from typing import Any

LIST_TYPES = {"List", "Matrix", "Dictionary"}


def tables_in_order(model: dict) -> list[str]:
    return sorted(model["tables"], key=lambda t: model["tables"][t].get("position", 0))


def columns(model: dict, table: str) -> dict[str, dict]:
    return model["tables"].get(table, {}).get("columns", {})


def split_list(value: str) -> list[str]:
    """MagIC-style colon-delimited list cell."""
    return [v.strip() for v in str(value).split(":") if v.strip()]


def column_values(column_def: dict, value: Any) -> list[str]:
    """A cell's value(s) as a list, honoring List/Matrix column types."""
    if value is None or value == "":
        return []
    if column_def.get("type") in LIST_TYPES:
        return split_list(value)
    return [str(value)]


def parent_key_column(parent_table: str) -> str:
    """Child rows reference their parent row by the singular of the parent
    table name (sites.location, samples.site, sections.core, ...)."""
    return parent_table[:-1] if parent_table.endswith("s") else parent_table
