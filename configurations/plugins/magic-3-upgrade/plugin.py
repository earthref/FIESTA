"""MagIC 3.0 upgrade: the 2.5 -> 3.0 restructuring `previous_columns` cannot express.

The core upgrade (fiesta.domain.upgrade) renames, moves, splits and merges
columns from the data models' `previous_columns` and merges rows that describe
the same entity. Data model 3.0 also joined the er_*/pmag_*/rmag_* tables into
nine and dropped 2.5's defaults; this step ports the rest of the legacy
upgrade_contribution.js special cases: result rows assigned to their level and
split by coordinate system and polarity, the wide pmag_criteria table turned
into criteria rows (the 3.0 model's `criteria_map`), renamed method codes,
relative-intensity normalisations, geoids and direction types moved into method
codes, combined matrix/list columns, 2.5 dates read in their time zone,
synthetic names, measurement parents, and ages adopted up to sites.

Fixed against the legacy upgrade (each pinned by test_magic_3_upgrade.py):
blank polarities and NRM origins stay blank (MagIC #295, #296, #374) and so
does a blank tilt correction (#521) unless the contributor asks for the 2.5
default; measurements get a `sequence` in file order (#374); values a level
cannot hold are reported, not dropped silently (#342); dates that do not parse
are kept and reported, never written as "Invalid date" (#374); 24-hour times;
"-999" criteria are skipped; a CHI normalisation lands in `int_rel_chi`.
"""

import contextlib
import re
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field

from fiesta.domain.upgrade import (
    BlankDefault,
    Row,
    RowPlan,
    StepContext,
    UpgradeStep,
    split_terms,
)
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions

METHOD_CODE_RENAMES = {
    "ST-BC": "ST-C",
    "ST-BC-Q1": "ST-BCQ-1",
    "ST-BC-Q2": "ST-BCQ-2",
    "ST-BC-Q3": "ST-BCQ-3",
    "ST-BC-Q4": "ST-BCQ-4",
    "ST-BC-Q5": "ST-BCQ-5",
    "ST-CT": "ST-G",
    "ST-IC": "ST-C-I",
    "ST-IFC": "ST-G-IF",
    "ST-VV-Q1": "ST-VVQ-1",
    "ST-VV-Q2": "ST-VVQ-2",
    "ST-VV-Q3": "ST-VVQ-3",
    "ST-VV-Q4": "ST-VVQ-4",
    "ST-VV-Q5": "ST-VVQ-5",
    "ST-VV-Q6": "ST-VVQ-6",
    "ST-VV-Q7": "ST-VVQ-7",
}

# 2.5 time-zone spellings (legacy moment-timezone aliases) -> IANA zones.
TIME_ZONES = {
    "CDT": "America/Chicago",
    "PDT": "America/Los_Angeles",
    "SAN": "America/Los_Angeles",
    "JER": "Asia/Jerusalem",
    "+8 GMT": "Asia/Shanghai",
    "0": "UTC",
}

STRATIGRAPHIC = (
    "average_inc",
    "average_dec",
    "average_sigma",
    "average_alpha95",
    "average_n",
    "average_nn",
    "average_k",
    "average_r",
)
TILT_CORRECTED = (
    "tilt_inc_corr",
    "tilt_dec_corr",
    "tilt_k_corr",
    "tilt_alpha95_corr",
    "tilt_k_ratio",
)
TILT_UNCORRECTED = ("tilt_inc_uncorr", "tilt_dec_uncorr", "tilt_k_uncorr", "tilt_alpha95_uncorr")
NORMAL = ("normal_inc", "normal_dec", "normal_k", "normal_n", "normal_alpha95")
REVERSED = ("reversed_inc", "reversed_dec", "reversed_k", "reversed_n", "reversed_alpha95")

RESULT_LEVELS = (
    ("er_synthetic_names", "specimens"),
    ("er_specimen_names", "specimens"),
    ("er_sample_names", "samples"),
    ("er_site_names", "sites"),
    ("er_location_names", "locations"),
)
PLURAL = re.compile(r".+:.+")
NORMALISATIONS = {"IE-ARM": "ARM", "IE-IRM": "IRM", "IE-CHI": "CHI"}
CRITERIA_METADATA = {
    "pmag_criteria_code",
    "criteria_definition",
    "criteria_description",
    "er_citation_names",
}
FLAG_COLUMNS = {
    "pmag_sites": "site_flag",
    "pmag_samples": "sample_flag",
    "pmag_specimens": "specimen_flag",
    "rmag_anisotropy": "anisotropy_flag",
    "rmag_hysteresis": "hysteresis_flag",
    "rmag_remanence": "remanence_flag",
    "rmag_susceptibility": "susceptibility_flag",
}
AGE_PARTS = ("", "_sigma", "_low", "_high", "_unit")
PARENT = {"specimens": "sample", "samples": "site", "sites": "location", "locations": None}
LEVEL_NAMES = (
    ("locations", "location", "er_location_name"),
    ("sites", "site", "er_site_name"),
    ("samples", "sample", "er_sample_name"),
    ("specimens", "specimen", "er_specimen_name"),
)
DATE_RE = re.compile(
    r"^\s*(\d{4})(?::(\d{1,2})(?::(\d{1,2})(?::(\d{1,2})(?::(\d{1,2})"
    r"(?::(\d{1,2}(?:\.\d*)?))?)?)?)?)?\s*$"
)
POSITIVE_INTEGER = re.compile(r"^\d+$")


def _strip_colons(value: str) -> str:
    return re.sub(r"(^:|:$)", "", value)


def _append_code(row: Row, code: str) -> None:
    row["magic_method_codes"] = f"{row.get('magic_method_codes', '')}:{code}"


class Magic3Step(UpgradeStep):
    """The MagIC 2.5 -> 3.0 step."""

    defaults = (
        BlankDefault(
            "result_quality", 'Blank 2.5 result flags (site_flag, specimen_flag, ...) → "g"'
        ),
        BlankDefault("result_type", 'Blank pmag_results.data_type → "i" (individual)'),
        # 3.0 requires a measurement quality; 2.5's blank flag meant good.
        BlankDefault("measurement_quality", 'Blank measurement_flag → "g" (required in 3.0)'),
        BlankDefault("orientation_quality", 'Blank orientation flag of an oriented sample → "g"'),
        BlankDefault(
            "direction_type", "Blank direction type of a direction → method code DE-BFL (line)"
        ),
        BlankDefault("int_corr", 'Blank specimen_correction of an intensity → "u" (uncorrected)'),
        BlankDefault("int_scat", 'Blank specimen_scat of Arai statistics → "t" (true)'),
        BlankDefault("dir_polarity", 'Blank polarity of a direction → "n" (normal)', on=False),
        BlankDefault("dir_nrm_origin", 'Blank NRM origin of a direction → "p" (primary)', on=False),
        BlankDefault(
            "dir_tilt_correction",
            "Blank tilt correction of a tilt-corrected direction → -3 (unknown)",
            on=False,
        ),
    )
    merge_keys = {
        "locations": ["location"],
        "sites": ["site"],
        "samples": ["sample"],
        "specimens": ["specimen"],
        "criteria": ["criterion", "table_column"],
        "ages": ["location", "site", "sample", "specimen"],
        "images": ["location", "site", "sample", "specimen"],
    }
    retired_tables = {
        "magic_methods": "method codes are a vocabulary of the data model",
        "er_citations": "citations are a column of each table",
        "er_mailinglist": "people are EarthRef accounts",
        "magic_calibrations": "calibrations are described by method codes",
        "magic_instruments": "instruments are described by method codes",
    }
    quiet_columns = frozenset(
        {
            "er_location_name",
            "er_site_name",
            "er_sample_name",
            "er_specimen_name",
            # A result's names above its level only place it.
            "er_location_names",
            "er_site_names",
            "er_sample_names",
            "er_specimen_names",
            "er_synthetic_names",
            "expedition_location",
            "location_geoid",
            "site_location_geoid",
            "sample_location_geoid",
        }
    )

    def __init__(
        self,
        from_version: str = "2.5",
        to_version: str = "3.0",
        method_code_renames: dict[str, str] | None = None,
        time_zones: dict[str, str] | None = None,
    ):
        self.from_version = from_version
        self.to_version = to_version
        self.method_code_renames = (
            METHOD_CODE_RENAMES if method_code_renames is None else method_code_renames
        )
        self.time_zones = TIME_ZONES if time_zones is None else time_zones

    # -- whole tables ---------------------------------------------------------

    def prepare(self, ctx: StepContext) -> None:
        source = ctx.source
        ctx.state["synthetics"] = {
            row["er_specimen_name"]: row["er_synthetic_name"]
            for row in source.get("er_synthetics", [])
            if row.get("er_specimen_name") and row.get("er_synthetic_name")
        }
        ctx.state["parents"] = {table: {} for table in PARENT}
        if "er_expeditions" in source:
            # 2.5 expeditions name no location: repeat each for the locations
            # it lists (or every location) so it can join locations.
            ctx.known_columns.setdefault("er_expeditions", set()).add("er_location_name")
            ctx.upgrade_map.setdefault("er_expeditions", {})["er_location_name"] = [
                ("locations", "location")
            ]
            locations = [
                r["er_location_name"]
                for r in source.get("er_locations", [])
                if r.get("er_location_name")
            ]
            rows = []
            for row in source["er_expeditions"]:
                names = split_terms(row.get("expedition_location", "")) or locations
                rows.extend({**row, "er_location_name": name} for name in names)
                if not names:
                    rows.append(dict(row))
            source["er_expeditions"] = rows
        if "pmag_results" in source:
            source["pmag_results"] = [
                split for row in source["pmag_results"] for split in self._split_result(ctx, row)
            ]

    def _split_result(self, ctx: StepContext, row: Row) -> list[Row]:
        """A result row with directions in several coordinate systems or
        polarities becomes one row per direction (3.0 has one per row)."""
        has = {
            name: any(row.get(c) for c in columns)
            for name, columns in (
                ("strat", STRATIGRAPHIC),
                ("corr", TILT_CORRECTED),
                ("uncorr", TILT_UNCORRECTED),
                ("normal", NORMAL),
                ("reversed", REVERSED),
            )
        }
        if not any(has.values()):
            return [row]

        def without(*groups: tuple[str, ...]) -> Row:
            drop = {c for group in groups for c in group}
            return {c: v for c, v in row.items() if c not in drop}

        out = []
        if has["strat"]:
            split = without(TILT_CORRECTED, TILT_UNCORRECTED, ("tilt_n",), NORMAL, REVERSED)
            # Averages are in stratigraphic coordinates (2.5 model).
            if "tilt_correction" not in split or has["corr"]:
                split["tilt_correction"] = "100"
            out.append(split)
        if has["corr"]:
            split = without(STRATIGRAPHIC, TILT_UNCORRECTED, NORMAL, REVERSED)
            if "tilt_correction" not in split and ctx.default("dir_tilt_correction"):
                split["tilt_correction"] = "-3"
            out.append(split)
        if has["uncorr"]:
            split = without(STRATIGRAPHIC, TILT_CORRECTED, NORMAL, REVERSED)
            split["tilt_correction"] = "0"
            out.append(split)
        if has["normal"]:
            out.append(
                without(STRATIGRAPHIC, TILT_CORRECTED, TILT_UNCORRECTED, ("tilt_n",), REVERSED)
            )
        if has["reversed"]:
            out.append(
                without(STRATIGRAPHIC, TILT_CORRECTED, TILT_UNCORRECTED, ("tilt_n",), NORMAL)
            )
        return out

    # -- one row ----------------------------------------------------------------

    def map_row(self, ctx: StepContext, table: str, index: int, row: Row) -> RowPlan | None:
        ctx.state["normalisation"] = None
        if table == "pmag_criteria":
            self._criteria(ctx, row)
            return None
        if table == "magic_measurements":
            return self._measurement(ctx, index, row)

        tables = None
        if table in ("pmag_results", "rmag_results"):
            level = next(
                (
                    level
                    for column, level in RESULT_LEVELS
                    if row.get(column) and not PLURAL.match(row[column])
                ),
                None,
            )
            if level is None:
                ctx.note(
                    "warning",
                    "dropped_row",
                    f'Rows in table "{table}" were deleted in {ctx.model_name} version '
                    f"{ctx.new_version} since they are contribution-level results "
                    f"(first: row {index + 1})",
                    table=table,
                )
                return None
            tables = frozenset({level})
        quiet = set()

        if row.get("magic_method_codes"):
            codes = [
                self.method_code_renames.get(code.upper(), code.upper())
                for code in split_terms(row["magic_method_codes"])
            ]
            found = [NORMALISATIONS[c] for c in dict.fromkeys(codes) if c in NORMALISATIONS]
            row["magic_method_codes"] = ":".join(c for c in codes if c not in NORMALISATIONS)
            if len(found) > 1:
                ctx.note(
                    "error",
                    "conversion",
                    f'Rows in table "{table}" include more than one type of relative intensity '
                    f"normalization in the method codes (first: row {index + 1}); their "
                    "relative intensities were kept unnormalized",
                    table=table,
                    key=(table, "normalisation"),
                )
            elif found:
                ctx.state["normalisation"] = found[0]

        if row.get("specimen_direction_type"):
            kind = row.pop("specimen_direction_type")
            _append_code(row, "DE-BFP" if kind.lower() == "p" else "DE-BFL")
        for column in ("location_geoid", "site_location_geoid", "sample_location_geoid"):
            if row.get(column):
                _append_code(row, f"GE-{row[column]}")

        synthetics = ctx.state["synthetics"]
        if table == "er_specimens" and row.get("er_specimen_name") in synthetics:
            alternatives = split_terms(row.get("er_specimen_alternatives", ""))
            alternatives.append(row["er_specimen_name"])
            row["er_specimen_alternatives"] = ":".join(dict.fromkeys(alternatives))
            row["er_specimen_name"] = synthetics[row["er_specimen_name"]]
        elif row.get("er_specimen_name") in synthetics:
            row["er_specimen_name"] = synthetics[row["er_specimen_name"]]
        elif row.get("er_specimen_names"):
            names = [synthetics.get(n, n) for n in split_terms(row["er_specimen_names"])]
            row["er_specimen_names"] = ":".join(dict.fromkeys(names))

        if table == "pmag_results" and tables == {"locations"}:
            self._combine(
                row,
                "eta_dec",
                ("eta_dec", "eta_inc", "eta_semi_angle", "zeta_dec", "zeta_inc", "zeta_semi_angle"),
            )
        if table == "rmag_anisotropy":
            self._combine(row, "anisotropy_s1", tuple(f"anisotropy_s{i}" for i in range(1, 7)))
        if table == "rmag_results":
            for i in (1, 2, 3):
                ellipse = tuple(
                    f"anisotropy_v{i}_{part}"
                    for part in (
                        "eta_dec",
                        "eta_inc",
                        "eta_semi_angle",
                        "zeta_dec",
                        "zeta_inc",
                        "zeta_semi_angle",
                    )
                )
                head = (f"anisotropy_t{i}", f"anisotropy_v{i}_dec", f"anisotropy_v{i}_inc")
                if any(row.get(c) for c in head) and any(row.get(c) for c in ellipse):
                    values = (
                        [row.get(c, "") for c in head]
                        + ["eta/zeta"]
                        + [row.get(c, "") for c in ellipse]
                    )
                    for c in (*head[1:], *ellipse):
                        row.pop(c, None)
                    row[head[0]] = ":".join(values)
                elif any(row.get(c) for c in head):
                    self._combine(row, head[0], head)

        self._dates(ctx, table, row, ("sample", "image", "plot"))

        if row.get("specimen_scat") in ("g", "b"):
            row["specimen_scat"] = "t" if row["specimen_scat"] == "g" else "f"

        if table in ("pmag_samples", "pmag_specimens") and row.get("er_site_name"):
            self._adopt_age(ctx, row, row["er_site_name"], f"{table[5:-1]}_inferred_age")
        if (
            table == "pmag_results"
            and tables
            and tables & {"samples", "specimens"}
            and row.get("er_site_names")
        ):
            self._adopt_age(ctx, row, row["er_site_names"], "average_age")

        flag = FLAG_COLUMNS.get(table)
        if flag and flag not in row and ctx.default("result_quality"):
            row[flag] = "g"
        if table == "pmag_results" and "data_type" not in row and ctx.default("result_type"):
            row["data_type"] = "i"

        if "external_database_names" in row:
            names = split_terms(_strip_colons(row["external_database_names"]))
            ids = _strip_colons(row.get("external_database_ids", "")).split(":")
            row["external_database_names"] = ":".join(
                f"{name}[{ids[i] if i < len(ids) else ''}]" for i, name in enumerate(names)
            )
            quiet.add("external_database_ids")
        elif row.get("external_database_ids"):
            ctx.note(
                "warning",
                "dropped_value",
                f'Values of "external_database_ids" in table "{table}" were dropped: '
                "they name no database (external_database_names)",
                table=table,
                column="external_database_ids",
            )
            quiet.add("external_database_ids")
        return RowPlan(row, tables, quiet=frozenset(quiet))

    @staticmethod
    def _combine(row: Row, into: str, columns: tuple[str, ...]) -> None:
        """Columns of a list into one colon-delimited cell (blanks kept)."""
        if not any(row.get(c) for c in columns):
            return
        values = [row.pop(c, "") for c in columns]
        row[into] = ":".join(values)

    def _adopt_age(self, ctx: StepContext, row: Row, site: str, prefix: str) -> None:
        """2.5 sample/specimen ages belong to the site in 3.0."""
        if not any(row.get(prefix + part) for part in AGE_PARTS):
            return
        site_row = {"site": site}
        for part in AGE_PARTS:
            value = row.pop(prefix + part, None)
            if value:
                site_row["age" + part] = value
        ctx.emit("sites", site_row)
        ctx.note(
            "info",
            "converted",
            f"{prefix}* → sites.age* (3.0 keeps ages on sites)",
            key=(prefix, "age"),
        )

    def _dates(self, ctx: StepContext, table: str, row: Row, prefixes: tuple[str, ...]) -> None:
        """2.5 `<prefix>_date` ("YYYY:MM:DD:hh:mm:ss.sss") in `<prefix>_time_zone`
        -> an ISO 8601 UTC timestamp; the time-zone column goes."""
        zones = [row.pop(f"{p}_time_zone") for p in prefixes if f"{p}_time_zone" in row]
        zone = zones[-1] if zones else "UTC"
        for prefix in prefixes:
            column = f"{prefix}_date"
            if row.get(column):
                row[column] = self._timestamp(ctx, table, column, row[column], zone)

    def _timestamp(self, ctx: StepContext, table: str, column: str, value: str, zone: str) -> str:
        match = DATE_RE.match(value)
        if not match:
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
                return value  # already ISO 8601
            except ValueError:
                ctx.note(
                    "warning",
                    "conversion",
                    f'Values of "{column}" in table "{table}" are not 2.5 dates '
                    f'(YYYY:MM:DD:hh:mm:ss) and were kept as written (first: "{value}")',
                    table=table,
                    column=column,
                    key=(table, column, "date"),
                )
                return value
        year, month, day, hour, minute, second = match.groups()
        seconds = float(second or 0)
        try:
            tz = ZoneInfo(self.time_zones.get(zone.strip(), zone.strip()) or "UTC")
        except (ZoneInfoNotFoundError, ValueError):
            ctx.note(
                "warning",
                "conversion",
                f'Time zone "{zone}" of "{column}" in table "{table}" is not recognized; '
                "the times were read as UTC",
                table=table,
                column=column,
                key=(table, column, "zone", zone),
            )
            tz = UTC
        try:
            local = datetime(
                int(year),
                int(month or 1),
                int(day or 1),
                int(hour or 0),
                int(minute or 0),
                int(seconds),
                round((seconds % 1) * 1_000_000),
                tzinfo=tz,
            )
        except ValueError:
            ctx.note(
                "warning",
                "conversion",
                f'Values of "{column}" in table "{table}" are not valid dates and were kept '
                f'as written (first: "{value}")',
                table=table,
                column=column,
                key=(table, column, "invalid"),
            )
            return value
        utc = local.astimezone(UTC)
        text = utc.strftime("%Y-%m-%dT%H:%M:%S")
        if utc.microsecond:
            text += f".{utc.microsecond // 1000:03d}"
        return text + "Z"

    def _criteria(self, ctx: StepContext, row: Row) -> None:
        """A wide 2.5 pmag_criteria row -> one 3.0 criteria row per criterion
        (the model's `criteria_map`)."""
        criteria_map = ctx.new_model.get("criteria_map", {})
        description = ", ".join(
            row[c] for c in ("criteria_definition", "criteria_description") if row.get(c)
        )
        for column, value in row.items():
            if column in CRITERIA_METADATA or value.strip() == "-999":
                continue
            mapped = criteria_map.get(column)
            if not mapped:
                ctx.note(
                    "warning",
                    "dropped_column",
                    f'Column "{column}" in table "pmag_criteria" is not a criterion '
                    f"{ctx.model_name} version {ctx.new_version} knows; its values were dropped",
                    table="pmag_criteria",
                    column=column,
                )
                continue
            criterion = {
                "table_column": mapped["table_column"],
                "criterion_operation": mapped["criterion_operation"],
                "criterion_value": value,
            }
            if row.get("pmag_criteria_code"):
                criterion["criterion"] = row["pmag_criteria_code"]
            if description:
                criterion["description"] = description
            if row.get("er_citation_names"):
                criterion["citations"] = row["er_citation_names"]
            ctx.emit("criteria", criterion)
            ctx.note(
                "info",
                "converted",
                f"pmag_criteria.{column} → criteria row ({mapped['table_column']})",
                table="pmag_criteria",
                column=column,
                to=["criteria.table_column"],
            )

    def _measurement(self, ctx: StepContext, index: int, row: Row) -> RowPlan:
        zone = row.pop("measurement_time_zone", "UTC")
        if row.get("measurement_date"):
            row["measurement_date"] = self._timestamp(
                ctx, "magic_measurements", "measurement_date", row["measurement_date"], zone
            )
        if "measurement_flag" not in row and ctx.default("measurement_quality"):
            row["measurement_flag"] = "g"
        synthetic = row.pop("er_synthetic_name", "")
        if synthetic and not row.get("er_specimen_name"):
            row["er_specimen_name"] = synthetic
        self._parents(ctx, row)
        add = {"sequence": str(index + 1)}
        number = row.get("measurement_number", "")
        if POSITIVE_INTEGER.match(number) and int(number) < 1000:
            add["treat_step_num"] = str(int(number))
            if row.get("magic_experiment_name"):
                row["measurement_number"] = f"{row['magic_experiment_name']}-{number}"
        return RowPlan(
            row,
            frozenset({"measurements"}),
            add={"measurements": add},
            quiet=frozenset({"er_location_name", "er_site_name", "er_sample_name"}),
        )

    def _parents(self, ctx: StepContext, row: Row) -> None:
        """The locations, sites, samples and specimens a measurement names, so
        upgrading the measurements alone keeps the hierarchy (legacy)."""
        parents = ctx.state["parents"]
        for i, (table, column, old) in enumerate(LEVEL_NAMES):
            name = row.get(old)
            if not name:
                continue
            parent_column = PARENT[table]
            parent = row.get(LEVEL_NAMES[i - 1][2]) if i > 0 else None
            existing = parents[table].get(name)
            if existing is None:
                existing = {column: name}
                parents[table][name] = existing
                ctx.emit(table, existing)
            if parent_column and parent and not existing.get(parent_column):
                existing[parent_column] = parent

    # -- one value ---------------------------------------------------------------

    def map_value(self, ctx, table, column, new_table, new_column, value, new_row):
        normalisation = ctx.state.get("normalisation")
        if normalisation and new_column.startswith("int_rel"):
            # int_rel[_sigma[_perc]] -> int_rel_<ARM|IRM|chi>..., as the model spells it.
            wanted = new_column.replace("int_rel", f"int_rel_{normalisation}", 1)
            columns = ctx.new_model["tables"][new_table]["columns"]
            new_column = next((c for c in columns if c.lower() == wanted.lower()), wanted)
        existing = new_row.get(new_column)
        if new_column == "description" and existing is not None:
            if value in existing:
                value = existing
            elif existing in value:
                new_row[new_column] = value
            else:
                value = f"{existing}, {value}"
                new_row[new_column] = value
        if new_column in ("lat_s", "lon_w", "lat_n", "lon_e") and existing is not None:
            pick = min if new_column in ("lat_s", "lon_w") else max
            with contextlib.suppress(ValueError):  # not numbers: validation reports them
                value = pick((value, existing), key=float)
            new_row[new_column] = value
        if column in NORMAL:
            new_row["dir_polarity"] = "n"
        elif column in REVERSED:
            new_row["dir_polarity"] = "r"
        return new_column, value

    # -- one new row ---------------------------------------------------------------

    def finish_row(self, ctx: StepContext, table: str, new_table: str, new_row: Row) -> None:
        groups = {ctx.column_def(new_table, c).get("group") for c in new_row}
        if (
            new_table == "samples"
            and "orientation_quality" not in new_row
            and "Orientation" in groups
            and ctx.default("orientation_quality")
        ):
            new_row["orientation_quality"] = "g"
        if new_table in ("sites", "samples", "specimens") and "Direction" in groups:
            if "dir_polarity" not in new_row and ctx.default("dir_polarity"):
                new_row["dir_polarity"] = "n"
            if "dir_nrm_origin" not in new_row and ctx.default("dir_nrm_origin"):
                new_row["dir_nrm_origin"] = "p"
            codes = split_terms(new_row.get("method_codes", ""))
            if not any(re.match(r"DE-BF[LP]$", c, re.I) for c in codes) and ctx.default(
                "direction_type"
            ):
                new_row["method_codes"] = ":".join(sorted({*codes, "DE-BFL"}))
        if new_table == "specimens":
            if "int_corr" not in new_row and "Paleointensity" in groups and ctx.default("int_corr"):
                new_row["int_corr"] = "u"
            if (
                "int_scat" not in new_row
                and "Paleointensity Arai Statistics" in groups
                and ctx.default("int_scat")
            ):
                new_row["int_scat"] = "t"


class Magic3UpgradeOptions(PluginOptions):
    from_version: str = Field("2.5", description="The data-model version this step upgrades from")
    to_version: str = Field("3.0", description="The data-model version it upgrades to")
    method_code_renames: dict[str, str] = Field(
        default_factory=lambda: dict(METHOD_CODE_RENAMES),
        description="Method codes 3.0 renamed: old code -> new code",
    )
    time_zones: dict[str, str] = Field(
        default_factory=lambda: dict(TIME_ZONES),
        description="2.5 time-zone spellings -> IANA time zones, for reading 2.5 dates",
    )


class Magic3UpgradePlugin(FiestaPlugin):
    name = "magic-3-upgrade"
    description = (
        "Upgrades MagIC 2.5 contributions to data model 3.0: the restructuring the data "
        "models' previous_columns cannot express."
    )
    Options = Magic3UpgradeOptions

    def check(self, node: NodeConfig, options: Magic3UpgradeOptions) -> None:
        versions = node.data_model.versions
        for version in (options.from_version, options.to_version):
            if version not in versions:
                raise ValueError(
                    f"plugin 'magic-3-upgrade': version {version!r} is not one of "
                    f"data_model.versions {versions}"
                )
        if versions.index(options.to_version) != versions.index(options.from_version) + 1:
            raise ValueError(
                "plugin 'magic-3-upgrade': to_version must follow from_version in "
                "data_model.versions"
            )

    def upgrade_steps(self, node: NodeConfig) -> list[UpgradeStep]:
        options = self.options(node)
        return [
            Magic3Step(
                options.from_version,
                options.to_version,
                options.method_code_renames,
                options.time_zones,
            )
        ]
