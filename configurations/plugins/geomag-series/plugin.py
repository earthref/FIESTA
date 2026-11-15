"""Geomagnetic field series: intensity, declination and inclination against age.

The Plots sub-tab of a search level of dated field records (GEOMAGIA's Sites)
draws the level's matches as three stacked time series, read from the
records' own columns through GET /search/{table}/values; the options map the
columns it plots. Nothing is derived for the plots: VADM is computed in the
browser from the intensity and the site latitude, as the GEOMAGIA site does,
unless the node names a VADM column.

It also derives the query refinements a field record's columns cannot answer
as they stand (`derived_columns`), so the node YAML can make them ordinary
sidebar filters:

- `data_type` (text): "Intensity" when the record has an intensity above
  zero, "Direction" when it has a declination or an inclination;
- `pi_family` (text): the paleointensity method families (`pi_families`) its
  methods belong to;
- each `checks` name (text): "No" when every value of its column is one of
  `check_none` (the names that mean nothing was done), "Yes" when any other
  value is there (none: neither);
- `age_error` (number): the larger of the age's two errors, when the record
  has an age and both errors are zero or more, so "age error at most x" is a
  range filter's maximum;
- `direction_n` (number): the greatest of the `direction_counts` columns, so
  "at least n directional specimens or samples" is a range filter's minimum.

The names (method families, which names mean nothing was done) are the
node's options, never this code's.
"""

import re
from typing import Literal

from pydantic import BaseModel, Field

from fiesta.domain.data_model import column_values
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions
from fiesta.plugins.util import to_float

NUMBER_TYPES = {"Number", "Integer"}


class MethodFamily(BaseModel):
    """A paleointensity method family and the methods in it."""

    model_config = {"extra": "forbid"}

    name: str = Field(description="The family's name, the `pi_family` value")
    methods: list[str] = Field(min_length=1, description="Method names in the family")


class GeomagSeriesOptions(PluginOptions):
    base_level: str | None = Field(
        None, description="The search level whose records the Plots sub-tab draws (unset: none)"
    )
    age: str = Field("age", description="Age column (the x axis)")
    age_minus: str | None = Field("age_min", description="Error toward older ages (bar below)")
    age_plus: str | None = Field("age_max", description="Error toward younger ages (bar above)")
    age_error_type: str | None = Field(None, description="Text column naming the age error's kind")
    age_sigmas: str | None = Field(None, description="Number of sigmas the age errors span")
    age_label: str = Field("Age (BCE − / CE +)", description="The age axis title")
    age_unit: str = Field("yr", description="Unit of the ages, for the tooltip")
    intensity: str | None = Field("ba", description="Paleointensity column")
    intensity_error: str | None = Field("sigma_ba", description="Paleointensity error column")
    intensity_unit: str = Field("µT", description="Unit of the intensity")
    vadm: str | None = Field(
        None,
        description="VADM column (10²² A·m²); unset: computed from the intensity and latitude",
    )
    vadm_error: str | None = Field(None, description="VADM error column, with `vadm`")
    declination: str | None = Field("decl", description="Declination column (drawn −180..180)")
    inclination: str | None = Field("incl", description="Inclination column")
    alpha95: str | None = Field("alpha_95", description="α95 column, for the tooltip")
    latitude: str | None = Field("lat", description="Site latitude, for the computed VADM")
    color_by: str | None = Field(
        None,
        description="Text column the points are coloured by, one hue per value, the legend "
        "listing them (hue = hash(value)·137.508°, the GEOMAGIA site's region formula)",
    )
    hover: list[str] = Field(
        [],
        description="Columns of the level's table, or summary.<block>.<name> paths, in the tooltip",
    )
    export_name: str = Field("fiesta", description="Prefix of the exported PNG and zip file names")
    name_search: str | None = Field(
        None,
        description="Text column the sidebar's name search matches (any part, ignoring case)",
    )
    name_search_label: str = Field("Site Name", description="The name search's sidebar label")
    radius_search: bool = Field(
        False, description="A sidebar radius search: records within a distance of a centre"
    )
    pi_methods: str | None = Field(
        None, description="Paleointensity method column (a list of names), for `pi_family`"
    )
    pi_families: list[MethodFamily] = Field(
        [], description="Paleointensity method families, for the derived `pi_family` facet"
    )
    checks: dict[str, str] = Field(
        {},
        description="Derived Yes/No facets by name, each from a column of names (a list): "
        "No = every value one of `check_none`, Yes = any other value",
    )
    check_none: list[str] = Field(
        [], description="Names that mean nothing was done (No) in the `checks` columns"
    )
    direction_counts: list[str] = Field(
        [], description="Number columns whose greatest is the derived `direction_n`"
    )


def _numbers(row: dict, column: str | None) -> float | None:
    return to_float(row.get(column)) if column else None


class GeomagSeriesPlugin(FiestaPlugin):
    name = "geomag-series"
    description = (
        "Plots of a level's dated field records against age (intensity or VADM, "
        "declination, inclination), and the GEOMAGIA site's query refinements as "
        "derived facets and ranges."
    )
    Options = GeomagSeriesOptions

    def _table(self, node: NodeConfig, options: GeomagSeriesOptions) -> str | None:
        level = next((lvl for lvl in node.search.levels if lvl.name == options.base_level), None)
        return level.table if level else None

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        assert isinstance(options, GeomagSeriesOptions)
        if options.base_level is None:
            return
        table = self._table(node, options)
        if table is None:
            raise ValueError(
                f"plugin 'geomag-series': base_level {options.base_level!r} is not a search level"
            )
        columns = node.load_data_model(node.data_model.latest)["tables"].get(table, {})
        columns = columns.get("columns", {})
        numbers = [
            options.age,
            options.age_minus,
            options.age_plus,
            options.age_sigmas,
            options.intensity,
            options.intensity_error,
            options.vadm,
            options.vadm_error,
            options.declination,
            options.inclination,
            options.alpha95,
            options.latitude,
            *options.direction_counts,
        ]
        for column in filter(None, numbers):
            if columns.get(column, {}).get("type") not in NUMBER_TYPES:
                raise ValueError(
                    f"plugin 'geomag-series': {column!r} is not a number column of {table}"
                )
        texts = [
            options.age_error_type,
            options.color_by,
            options.name_search,
            options.pi_methods,
            *options.checks.values(),
            *(c for c in options.hover if not c.startswith("summary.")),
        ]
        for column in filter(None, texts):
            if column not in columns:
                raise ValueError(f"plugin 'geomag-series': {column!r} is not a column of {table}")
        for path in options.hover:
            if path.startswith("summary.") and len(path.split(".")) < 3:
                raise ValueError(
                    f"plugin 'geomag-series': hover {path!r} must be summary.<block>.<name>"
                )
        if options.pi_families and not options.pi_methods:
            raise ValueError("plugin 'geomag-series': pi_families need the pi_methods column")
        # Names the options give must be names their column's vocabulary allows.
        vocabularies = node.load_controlled_vocabularies() if node.vocabularies.controlled else {}
        named = [
            (options.pi_methods, {m for f in options.pi_families for m in f.methods}),
            *((column, set(options.check_none)) for column in options.checks.values()),
        ]
        for column, names in named:
            for validation in columns.get(column, {}).get("validations") or []:
                vocabulary = re.fullmatch(r'cv\("([^"]+)"\)', validation)
                if not vocabulary or vocabulary[1] not in vocabularies:
                    continue
                items = {str(i.get("item")) for i in vocabularies[vocabulary[1]].get("items", [])}
                if unknown := sorted(names - items):
                    raise ValueError(
                        f"plugin 'geomag-series': {unknown} are not in {column}'s vocabulary"
                    )
        if clash := sorted(set(self.derived_columns(node)) & set(columns)):
            raise ValueError(f"plugin 'geomag-series': derived {clash} are data-model columns")

    def derived_columns(self, node: NodeConfig) -> dict[str, Literal["text", "number"]]:
        options = self.options(node)
        if options.base_level is None:
            return {}
        out: dict[str, Literal["text", "number"]] = {}
        if options.intensity or options.declination or options.inclination:
            out["data_type"] = "text"
        if options.pi_families:
            out["pi_family"] = "text"
        out.update(dict.fromkeys(options.checks, "text"))
        if options.age_minus and options.age_plus:
            out["age_error"] = "number"
        if options.direction_counts:
            out["direction_n"] = "number"
        return out

    def derive_values(self, node: NodeConfig, table: str, rows: list[dict]) -> dict[str, list]:
        options = self.options(node)
        if not rows or table != self._table(node, options):
            return {}
        specs = node.load_data_model(node.data_model.latest)["tables"][table]["columns"]
        out: dict[str, set] = {}

        def add(name: str, value) -> None:
            out.setdefault(name, set()).add(value)

        families = [(f.name, set(f.methods)) for f in options.pi_families]
        nothing_done = set(options.check_none)
        for row in rows:
            intensity = _numbers(row, options.intensity)
            if intensity is not None and intensity > 0:
                add("data_type", "Intensity")
            if _numbers(row, options.declination) is not None or (
                _numbers(row, options.inclination) is not None
            ):
                add("data_type", "Direction")
            if options.pi_methods and families:
                methods = set(column_values(specs[options.pi_methods], row.get(options.pi_methods)))
                for name, members in families:
                    if methods & members:
                        add("pi_family", name)
            for name, column in options.checks.items():
                values = set(column_values(specs[column], row.get(column)))
                if values - nothing_done:
                    add(name, "Yes")
                elif values:
                    add(name, "No")
            minus = _numbers(row, options.age_minus)
            plus = _numbers(row, options.age_plus)
            if (
                _numbers(row, options.age) is not None
                and minus is not None
                and plus is not None
                and minus >= 0
                and plus >= 0
            ):
                add("age_error", max(minus, plus))
            counts = [n for c in options.direction_counts if (n := _numbers(row, c)) is not None]
            if counts:
                add("direction_n", max(counts))
        # A record's Yes wins over its other rows' No (mixed sets count as Yes).
        for name in options.checks:
            if out.get(name) == {"Yes", "No"}:
                out[name] = {"Yes"}
        return {name: sorted(values) for name, values in out.items()}

    def search_facets(self, node: NodeConfig) -> list[str]:
        # The sidebar's name search counts (and suggests) the column's values;
        # the radius search's entry is counted on it too (as a facet: no doc
        # has a `radius` column, so its count is never shown).
        options = self.options(node)
        facets = [options.name_search] if options.name_search else []
        return facets + (["radius"] if options.radius_search else [])

    def frontend_config(self, node: NodeConfig) -> dict:
        options = self.options(node)
        return {**options.model_dump(), "table": self._table(node, options)}
