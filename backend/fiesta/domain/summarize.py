"""Summarization: explode one contribution into denormalized search documents.

For a node with hierarchy [contribution, A, B, ...] this produces:

- one `contribution` doc: the contribution row, per-level `_n_results`
  counts, and a cross-level `summary._all` union of facetable values and a
  representative `_geo_point`;
- one doc per row of each hierarchy level below `contribution`, carrying the
  shared `summary.contribution` block, its own row under
  `summary.<level>`, its raw row in `rows`, and per-doc `_all` values.

This is a deliberate simplification of the legacy
`summarize_contribution.js` adopt/inherit/aggregate pipeline: enough for
search, facets, counts, geolocation, and downloads. Deeper rollups (age
ranges, poles, method-code inheritance across levels) can be layered on
without changing the document contract.
"""

from typing import Any

from fiesta.domain.data_model import LIST_TYPES, column_values, split_list
from fiesta.domain.parse import ParsedContribution
from fiesta.nodeconfig import NodeConfig

# Columns whose (colon-delimited) values feed summary._all facets when present.
FACETABLE_COLUMNS = {
    "method_codes",
    "geologic_classes",
    "geologic_types",
    "lithologies",
    "location_type",
    "plate_blocks",
    "tectonic_settings",
    "citations",
}

LAT_COLUMNS = ("lat", "lat_s", "lat_n")
LON_COLUMNS = ("lon", "lon_w", "lon_e")


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _geo_point(row: dict) -> dict | None:
    lat = next((v for c in LAT_COLUMNS if (v := _to_float(row.get(c))) is not None), None)
    lon = next((v for c in LON_COLUMNS if (v := _to_float(row.get(c))) is not None), None)
    if lat is None or lon is None or not (-90 <= lat <= 90):
        return None
    lon = ((lon + 180) % 360) - 180
    return {"lat": lat, "lon": lon}


# Distinct-values cap per column in summary._all (keeps huge contributions'
# roll-up docs bounded; facets and free-text search degrade gracefully).
MAX_ALL_VALUES = 500


def _collect_all(columns_def: dict, rows: list[dict], into: dict[str, set]) -> None:
    """Union row values per column — the cross-level `summary._all` roll-up
    that powers free-text search and facets on parent-level docs."""
    for row in rows:
        for column, value in row.items():
            if value in (None, ""):
                continue
            column_def = columns_def.get(column, {})
            if column in FACETABLE_COLUMNS or column_def.get("type") in LIST_TYPES:
                values = column_values(column_def, value) or split_list(value)
            else:
                values = [str(value)]
            bucket = into.setdefault(column, set())
            if len(bucket) < MAX_ALL_VALUES:
                bucket.update(values)


def _finalize_all(collected: dict[str, set], geo_point: dict | None) -> dict:
    result: dict[str, Any] = {k: sorted(v) for k, v in collected.items() if v}
    if geo_point:
        result["_geo_point"] = geo_point
    return result


def summarize(
    node: NodeConfig,
    parsed: ParsedContribution,
    contribution_meta: dict,
) -> list[dict]:
    """Build the search docs for one contribution.

    `contribution_meta` carries the workflow fields (id, version, timestamps,
    _contributor, _contributor_id, _private_key, _is_activated, _is_latest,
    _reference, ...) merged into `summary.contribution` on every doc.
    """
    model = node.load_data_model(node.data_model.latest)
    hierarchy = node.hierarchy

    contribution_rows = parsed.tables.get("contribution", [])
    contribution_summary: dict[str, Any] = dict(contribution_rows[0]) if contribution_rows else {}
    contribution_summary.update(contribution_meta)

    docs: list[dict] = []
    all_values: dict[str, set] = {}
    first_geo: dict | None = None
    level_counts: dict[str, dict] = {}

    for level in hierarchy[1:]:
        rows = parsed.tables.get(level, [])
        level_counts[level] = {"_n_results": len(rows)}
        columns_def = model["tables"].get(level, {}).get("columns", {})
        _collect_all(columns_def, rows, all_values)

        for row in rows:
            row_all: dict[str, set] = {}
            _collect_all(columns_def, [row], row_all)
            geo = _geo_point(row)
            if geo and first_geo is None:
                first_geo = geo
            docs.append(
                {
                    "type": level,
                    "summary": {
                        "contribution": contribution_summary,
                        level: dict(row),
                        "_all": _finalize_all(row_all, geo),
                    },
                    "rows": [row],
                }
            )

    contribution_doc = {
        "type": "contribution",
        "summary": {
            "contribution": contribution_summary,
            "_all": _finalize_all(all_values, first_geo),
            **level_counts,
        },
    }
    return [contribution_doc, *docs]


def doc_id(contribution_id: int, doc_type: str, ordinal: int) -> str:
    return f"{contribution_id}-{doc_type}-{ordinal}"
