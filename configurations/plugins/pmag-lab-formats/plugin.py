"""PmagPy lab formats: magnetometer and instrument files converted to MagIC text.

The upload page's import step reads a node text file, a delimited file or a
workbook in the browser; this plugin adds the lab formats PmagPy's
`convert_2_magic` converters read (the "MagIC GUI" / pmag_gui conversions):
2G binary and ASCII, CIT, SIO, JR6 (.jr6 and .txt), Utrecht, LDEO, HUJI and
PmagPy's generic format. The core (fiesta.services.import_formats) writes the
uploaded files into a temporary directory and calls `convert`; the converter
writes measurements/specimens/samples/sites/locations.txt there, which become
the import step's sheets as if the contributor had uploaded a MagIC text file.

What PmagPy prints goes into the report: `-W-`/`-E-` lines and other lines
naming a warning or an error are kept (repeats counted), `-I-` progress lines
dropped. The report also names the options the contributor left at a default
that shapes the hierarchy (the sample naming convention, the location) and
flags a hierarchy that looks like a wrong naming convention: every specimen
its own sample and its own site.

The converters print to stdout and are not written for concurrent use, so one
conversion runs at a time per API process (`_LOCK`). PmagPy runs offline
(`pmag_env.set_env.OFFLINE`): the data model and method codes it ships, not a
download from earthref.org per conversion.
"""

import contextlib
import io
import re
import threading
from collections import Counter
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any, ClassVar, Literal

from pydantic import Field

from fiesta.domain.parse import ParseError, parse_text
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import (
    FiestaPlugin,
    ImportConversionError,
    ImportFormat,
    ImportInput,
    ImportNote,
    ImportOptions,
    ImportResult,
    PluginOptions,
)

# The tables PmagPy writes, in the order the import step shows them.
TABLES = ("locations", "sites", "samples", "specimens", "measurements")
_LOCK = threading.Lock()
MAX_NOTES = 40

NAMING_LABELS = {
    "1": "1: XXXXY, site XXXX and a one-character sample Y (TG001a: site TG001)",
    "2": "2: XXXX-YY, site and sample split at a dash",
    "3": "3: XXXX.YY, site and sample split at a period",
    "4": "4: XXXX[YYY], the sample is the last Z characters",
    "5": "5: the site name is the sample name",
    "7": "7: [XXX]YYY, the site is the first Z characters",
}
NAMING_2G = {**NAMING_LABELS, "8": "8: site_sample_specimen, split at underscores"}
NAMING_SIO = {**NAMING_LABELS, "8": "8: synthetic, no site", "9": "9: ODP naming"}
NAMING_HELP = (
    "How a sample name splits into its site (PmagPy's samp_con). If every specimen "
    "turns into its own sample and site, this is the setting to check."
)
ORIENTATION_LABELS = {
    "1": "1: lab arrow azimuth = mag_azimuth, dip = -field_dip",
    "2": "2: lab arrow azimuth = mag_azimuth - 90, dip = -field_dip",
    "3": "3: lab arrow azimuth = mag_azimuth, dip = 90 - field_dip",
    "4": "4: lab azimuth and dip = mag_azimuth, field_dip",
    "5": "5: lab azimuth = mag_azimuth, dip = field_dip - 90",
    "6": "6: lab arrow azimuth = mag_azimuth - 90, dip = 90 - field_dip",
}
PROTOCOLS = {
    "AF": "AF demagnetization",
    "T": "thermal (including Thellier, not TRM acquisition)",
    "S": "Shaw method",
    "I": "IRM acquisition",
    "N": "NRM only",
    "TRM": "TRM acquisition",
    "ANI": "anisotropy",
    "D": "double AF demagnetization",
    "G": "triple AF demagnetization (GRM protocol)",
    "CR": "cooling rate",
}
EXPERIMENTS = {
    "Demag": "AF and/or thermal demagnetization",
    "PI": "paleointensity, thermal (ZI/IZ/IZZI)",
    "ATRM 6": "ATRM in 6 positions",
    "AARM 6": "AARM in 6 positions",
    "CR": "cooling rate",
    "NLT": "non-linear TRM",
}

Naming = Literal["1", "2", "3", "4", "5", "7"]
Naming2G = Literal["1", "2", "3", "4", "5", "7", "8"]
NamingSIO = Literal["1", "2", "3", "4", "5", "7", "8", "9"]
Protocol = Literal["AF", "T", "S", "I", "N", "TRM", "ANI", "D", "G", "CR"]
Experiment = Literal["Demag", "PI", "ATRM 6", "AARM 6", "CR", "NLT"]


def _labels(labels: dict[str, str]) -> dict[str, Any]:
    return {"x-enum-labels": labels}


def _naming(default: str, labels: dict[str, str] = NAMING_LABELS) -> Any:
    return Field(
        default,
        title="Sample naming convention",
        description=NAMING_HELP,
        json_schema_extra=_labels(labels),
    )


def _specnum(default: int) -> Any:
    return Field(
        default,
        ge=0,
        le=20,
        title="Specimen characters",
        description="Characters at the end of a specimen name that set it apart from its "
        "sample (0: the specimen name is the sample name)",
    )


NAMING_CHARS = Field(
    2, ge=1, le=40, title="Z characters", description="Z for naming conventions 4 and 7"
)
LOCATION = Field("unknown", title="Location", description="The location every site is in")
LAT = Field(None, ge=-90, le=90, title="Latitude", description="Of every site (decimal degrees)")
LON = Field(None, ge=-180, le=360, title="Longitude", description="Of every site (decimal degrees)")
NOAVE = Field(
    False,
    title="Keep replicates",
    description="Keep replicate measurements at a step instead of averaging them",
)
USER = Field("", title="Analyst", description="Who made the measurements")
LABFIELD = Field(0.0, ge=0, title="Lab field (µT)", description="DC lab field, for TRM experiments")
PHI = Field(0.0, title="Lab field declination", description="0 to 360")
THETA = Field(0.0, ge=-90, le=90, title="Lab field inclination", description="-90 to 90")


def _codelist(default: list[str]) -> Any:
    return Field(
        default,
        min_length=1,
        title="Lab protocols",
        description="Every protocol the file holds (PmagPy's codelist)",
        json_schema_extra=_labels(PROTOCOLS),
    )


# --- options, one model per converter (field names are PmagPy's arguments) ---


class GenericOptions(ImportOptions):
    experiment: Experiment = Field(
        "Demag", title="Experiment", json_schema_extra=_labels(EXPERIMENTS)
    )
    sample_nc_kind: Literal["same", "initial", "terminal", "delimiter"] = Field(
        "same",
        title="Specimen to sample",
        description="How a specimen name gives its sample: the same name, or without N "
        "initial or terminal characters, or before a delimiter",
        json_schema_extra=_labels(
            {
                "same": "sample = specimen",
                "initial": "drop N initial characters",
                "terminal": "drop N terminal characters",
                "delimiter": "split at a delimiter",
            }
        ),
    )
    sample_nc_value: str = Field(
        "", max_length=10, title="Specimen to sample N or delimiter", description="e.g. 1 or -"
    )
    site_nc_kind: Literal["same", "initial", "terminal", "delimiter"] = Field(
        "same",
        title="Sample to site",
        description="How a sample name gives its site (as above)",
        json_schema_extra=_labels(
            {
                "same": "site = sample",
                "initial": "drop N initial characters",
                "terminal": "drop N terminal characters",
                "delimiter": "split at a delimiter",
            }
        ),
    )
    site_nc_value: str = Field(
        "", max_length=10, title="Sample to site N or delimiter", description="e.g. 2 or -"
    )
    location: str = LOCATION
    lat: float | None = LAT
    lon: float | None = LON
    labfield: float = LABFIELD
    labfield_phi: float = PHI
    labfield_theta: float = THETA
    cooling_times_list: str = Field(
        "", title="Cooling times", description="CR experiments: K/minute, comma separated"
    )
    noave: bool = NOAVE
    user: str = USER


class TwoGBinOptions(ImportOptions):
    samp_con: Naming2G = _naming("2", NAMING_2G)
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(0)
    specname: bool = Field(
        False, title="Specimen from file name", description="Name the specimen after the file"
    )
    or_con: Literal["1", "2", "3", "4", "5", "6"] = Field(
        "3", title="Orientation convention", json_schema_extra=_labels(ORIENTATION_LABELS)
    )
    dec_corr: bool = Field(
        True, title="Declination corrected", description="Azimuths are corrected to true north"
    )
    gmeths: str = Field(
        "FS-FD:SO-POM", title="Sampling method codes", description="Colon separated"
    )
    experiment: Experiment = Field(
        "Demag", title="Experiment", json_schema_extra=_labels(EXPERIMENTS)
    )
    labfield: float = LABFIELD
    labfield_phi: float = PHI
    labfield_theta: float = THETA
    location: str = LOCATION
    lat: float | None = LAT
    lon: float | None = LON
    inst: str = Field("", title="Instrument", description="Instrument code")
    noave: bool = NOAVE
    user: str = USER


class TwoGAscOptions(ImportOptions):
    samp_con: Naming2G = _naming("2", NAMING_2G)
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(0)
    or_con: Literal["1", "2", "3", "4", "5", "6"] = Field(
        "3", title="Orientation convention", json_schema_extra=_labels(ORIENTATION_LABELS)
    )
    gmeths: str = Field(
        "FS-FD:SO-POM", title="Sampling method codes", description="Colon separated"
    )
    location: str = LOCATION
    lat: float | None = LAT
    lon: float | None = LON
    inst: str = Field("", title="Instrument", description="Instrument code")
    noave: bool = NOAVE
    user: str = USER


class CitOptions(ImportOptions):
    samp_con: Naming = _naming("3")
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(0)
    locname: str = LOCATION
    methods: str = Field(
        "SO-MAG", title="Sampling method codes", description="Colon separated, e.g. SO-MAG:FS-FD"
    )
    norm: Literal["cc", "m3", "g"] = Field(
        "cc",
        title="Intensity normalization",
        json_schema_extra=_labels({"cc": "per cc (emu)", "m3": "per m³ (SI)", "g": "per gram"}),
    )
    meas_n_orient: Literal["4", "8", "12"] = Field("8", title="Orientations per measurement")
    labfield: float = LABFIELD
    phi: float = PHI
    theta: float = THETA
    noave: bool = NOAVE
    user: str = USER


class SioOptions(ImportOptions):
    codelist: list[Protocol] = _codelist(["AF"])
    samp_con: NamingSIO = _naming("1", NAMING_SIO)
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(0)
    location: str = LOCATION
    lat: float | None = LAT
    lon: float | None = LON
    labfield: float = LABFIELD
    phi: float = PHI
    theta: float = THETA
    peakfield: float = Field(0.0, ge=0, title="Peak AF field (mT)", description="For ARM")
    instrument: str = Field("", title="Instrument", description='e.g. "SIO-2G"')
    coil: Literal["", "1", "2", "3"] = Field("", title="IRM coil", description="ASC coil number")
    cooling_rates: str = Field(
        "", title="Cooling rates", description="CR experiments: K/minute, comma separated"
    )
    timezone: str = Field("UTC", title="Time zone", description="Of the dates in the file")
    noave: bool = NOAVE
    user: str = USER


class Jr6Options(ImportOptions):
    samp_con: Naming = _naming("1")
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(1)
    location: str = LOCATION
    lat: float | None = LAT
    lon: float | None = LON
    meth_code: str = Field("LP-NO", title="Method codes", description="Colon separated")
    volume: float = Field(12.0, gt=0, title="Specimen volume (cc)")
    noave: bool = NOAVE
    user: str = USER


class Jr6TxtOptions(Jr6Options):
    timezone: str = Field("UTC", title="Time zone", description="Of the dates in the file")


class UtrechtOptions(ImportOptions):
    samp_con: Naming = _naming("2")
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(1)
    location: str = LOCATION
    lat: float | None = LAT
    lon: float | None = LON
    meth_code: str = Field("LP-NO", title="Method codes", description="Colon separated")
    dmy_flag: bool = Field(False, title="Day/month/year dates", description="Not month/day/year")
    meas_n_orient: int = Field(8, ge=1, le=24, title="Orientations per measurement")
    labfield: float = LABFIELD
    phi: float = PHI
    theta: float = THETA
    noave: bool = NOAVE


class LdeoOptions(ImportOptions):
    codelist: list[Protocol] = _codelist(["AF"])
    samp_con: NamingSIO = _naming("1", NAMING_SIO)
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(0)
    location: str = LOCATION
    mass_or_vol: Literal["v", "m"] = Field(
        "v",
        title="Normalized by",
        json_schema_extra=_labels({"v": "volume", "m": "mass"}),
    )
    coil: Literal["", "1", "2", "3"] = Field("", title="IRM coil", description="ASC coil number")
    noave: bool = NOAVE


class HujiOptions(ImportOptions):
    codelist: list[Literal["AF", "T", "N", "TRM", "ANI", "CR"]] = _codelist(["AF"])
    samp_con: Naming = _naming("1")
    samp_con_chars: int = NAMING_CHARS
    specnum: int = _specnum(0)
    location: str = LOCATION
    labfield: float = LABFIELD
    phi: float = PHI
    theta: float = THETA
    noave: bool = NOAVE
    user: str = USER


# --- reading what PmagPy wrote and printed ---


def pmagpy_version() -> str:
    try:
        return package_version("pmagpy")
    except PackageNotFoundError:
        return ""


_PREFIX = re.compile(r"^-([EWI])-\s*")
_TAG = re.compile(r"^(warning|error)\s*[:!-]?\s*", re.IGNORECASE)
# Progress lines (`-I- 24 records written to measurements file`), not news.
_PROGRESS = re.compile(
    r"records? (written|to file)|^writing .* to |^done reading|^using (cached|online) "
    r"|^getting method codes|^couldn't connect to earthref",
    re.I,
)


def stdout_notes(text: str, paths: list[Path]) -> list[ImportNote]:
    """What a converter printed, as report notes: errors and warnings (by
    their `-E-`/`-W-` prefix, else by the word), `-I-` lines that are not
    progress; temporary paths removed, repeats counted."""
    counts: Counter[tuple[str, str]] = Counter()
    roots = sorted({str(p) for path in paths for p in (path, path.resolve())}, key=len)[::-1]
    for line in text.splitlines():
        message = line.strip()
        if not message:
            continue
        prefix = _PREFIX.match(message)
        lower = message.lower()
        if prefix:
            level = {"E": "error", "W": "warning", "I": "info"}[prefix.group(1)]
            message = message[prefix.end() :]
        elif "error" in lower:
            level = "error"
        elif "warning" in lower:
            level = "warning"
        else:
            continue  # the converters' debug prints
        for root in roots:
            message = message.replace(root + "/", "").replace(root, "")
        message = _TAG.sub("", message).strip()
        if not message or (level == "info" and _PROGRESS.search(message)):
            continue
        counts[(level, message)] += 1
    notes = [ImportNote(level, message, count=n) for (level, message), n in counts.items()]  # type: ignore[arg-type]
    notes.sort(key=lambda n: ("error", "warning", "info").index(n.level))
    if len(notes) > MAX_NOTES:
        hidden = len(notes) - MAX_NOTES
        notes = [*notes[:MAX_NOTES], ImportNote("info", f"{hidden} more messages not shown")]
    return notes


def read_tables(work_dir: Path) -> str:
    """The MagIC tables a converter wrote, as one multi-table text."""
    blocks = []
    for table in TABLES:
        path = work_dir / f"{table}.txt"
        if path.is_file():
            text = path.read_text(encoding="utf-8", errors="replace").strip("\n")
            if text.count("\n") >= 2:  # a header and at least one row
                blocks.append(text)
    return "\n>>>>>>>>>>\n".join(blocks) + "\n" if blocks else ""


def hierarchy_hints(text: str, naming_option: str) -> list[ImportNote]:
    """A hint when the hierarchy looks like a naming convention that does not
    fit the names: every specimen its own sample and its own site. (One
    specimen per sample, or one sample per site, alone is common.)"""
    try:
        parsed = parse_text(text)
    except ParseError:
        return []
    n = {t: parsed.row_count(t) for t in ("specimens", "samples", "sites")}
    if not n["specimens"] > 1 or not n["specimens"] == n["samples"] == n["sites"]:
        return []
    message = (
        f"{n['specimens']} specimens -> {n['samples']} samples -> {n['sites']} sites: every "
        f"specimen became its own sample and its own site; if the names encode them, check "
        f"the {naming_option}"
    )
    return [ImportNote("warning", message, kind="hint")]


def _magic_kwargs(options: ImportOptions) -> dict[str, Any]:
    """Options as PmagPy arguments: naming conventions 4 and 7 take their Z,
    a blank latitude or longitude is "", lab protocols are colon separated."""
    kwargs = options.model_dump(exclude={"samp_con_chars"})
    if kwargs.get("samp_con") in ("4", "7"):
        kwargs["samp_con"] = f"{kwargs['samp_con']}-{options.samp_con_chars}"  # type: ignore[attr-defined]
    for key in ("lat", "lon"):
        if key in kwargs and kwargs[key] is None:
            kwargs[key] = ""
    if isinstance(kwargs.get("codelist"), list):
        kwargs["codelist"] = ":".join(kwargs["codelist"])
    return kwargs


# --- the formats ---


def _text_head(head: bytes) -> list[str]:
    text = head.decode("latin-1")
    return [line for line in re.split(r"\r\n|\r|\n", text) if line.strip()]


class PmagFormat(ImportFormat):
    """One `pmagpy.convert_2_magic` converter."""

    #: The converter's name in convert_2_magic.
    function: ClassVar[str] = ""
    #: Its arguments for the input file and the input directory.
    file_arg: ClassVar[str] = "mag_file"
    input_arg: ClassVar[str] = "input_dir_path"
    #: Options whose default shapes the result: reported when left at it.
    reported_defaults: ClassVar[tuple[str, ...]] = ("samp_con", "location")
    #: The option the hierarchy hint points at.
    naming_option: ClassVar[str] = "sample naming convention and specimen characters"

    def kwargs(self, options: ImportOptions) -> dict[str, Any]:
        return _magic_kwargs(options)

    def default_notes(self, options: ImportOptions) -> list[ImportNote]:
        notes = []
        schema = self.options_schema()["properties"]
        for name in self.reported_defaults:
            if name not in schema or name in options.model_fields_set:
                continue
            value = getattr(options, name)
            labels = schema[name].get("x-enum-labels", {})
            shown = labels.get(value, value) if isinstance(value, str) else value
            if isinstance(value, list):
                shown = ", ".join(labels.get(v, v) for v in value)
            title = schema[name].get("title", name)
            notes.append(ImportNote("info", f"{title}: {shown} (the default)", kind="default"))
        return notes

    def convert(self, node: NodeConfig, files: ImportInput, options: ImportOptions) -> ImportResult:
        from pmag_env import set_env
        from pmagpy import convert_2_magic

        converter = getattr(convert_2_magic, self.function)
        kwargs = self.kwargs(options)
        kwargs[self.file_arg] = files.files[0]
        kwargs[self.input_arg] = str(files.directory)
        kwargs["dir_path"] = str(files.work_dir)
        printed = io.StringIO()
        failure: str | None = None
        with _LOCK, contextlib.redirect_stdout(printed):
            # PmagPy's own data model and method codes, not a download from
            # earthref.org on every conversion.
            set_env.OFFLINE = True
            try:
                outcome = converter(**kwargs)
            except (Exception, SystemExit) as exc:
                failure = f"{type(exc).__name__}: {exc}"
                outcome = None
        notes = stdout_notes(printed.getvalue(), [files.directory, files.work_dir])
        if failure is None:
            ok = outcome[0] if isinstance(outcome, tuple) else bool(outcome)
            if not ok:
                detail = outcome[1] if isinstance(outcome, tuple) and len(outcome) > 1 else ""
                failure = str(detail or "it reported a failure")
        if failure is not None:
            raise ImportConversionError(f"PmagPy's {self.label} converter failed: {failure}", notes)
        text = read_tables(files.work_dir)
        if not text:
            raise ImportConversionError(f"PmagPy's {self.label} converter wrote no rows", notes)
        notes += self.default_notes(options) + hierarchy_hints(text, self.naming_option)
        tool = {
            "name": "PmagPy",
            "version": pmagpy_version(),
            "function": f"convert_2_magic.{self.function}",
        }
        return ImportResult(text=text, notes=notes, tool=tool)


class GenericFormat(PmagFormat):
    key = "pmag-generic"
    label = "PmagPy Generic File"
    description = (
        "PmagPy's generic tab-delimited measurement file: specimen, treatment, "
        "treatment_type, moment, dec_s, inc_s (dec_g, inc_g, dec_t, inc_t optional)."
    )
    extensions = (".txt",)
    Options = GenericOptions
    function = "generic"
    file_arg = "magfile"
    reported_defaults = ("experiment", "sample_nc_kind", "site_nc_kind", "location")
    naming_option = "specimen-to-sample and sample-to-site naming"
    REQUIRED = frozenset({"specimen", "treatment", "treatment_type", "moment"})

    def sniff(self, filename: str, head: bytes) -> float:
        lines = _text_head(head)
        if not lines:
            return 0.0
        columns = {c.strip().lower() for c in re.split(r"[\t,]", lines[0])}
        if columns >= self.REQUIRED:
            return 0.95
        return 0.5 if len(self.REQUIRED & columns) >= 3 else 0.0

    def kwargs(self, options: ImportOptions) -> dict[str, Any]:
        kwargs = _magic_kwargs(options)
        for level in ("sample", "site"):
            kind = kwargs.pop(f"{level}_nc_kind")
            value = kwargs.pop(f"{level}_nc_value").strip()
            if kind == "same":
                kwargs[f"{level}_nc"] = [1, 0]
            elif kind == "delimiter":
                kwargs[f"{level}_nc"] = [2, value or "-"]
            else:
                if not value.isdigit():
                    raise ImportConversionError(
                        f"the {level} naming needs a number of characters, not {value!r}"
                    )
                kwargs[f"{level}_nc"] = [0 if kind == "initial" else 1, int(value)]
        times = kwargs.pop("cooling_times_list")
        kwargs["cooling_times_list"] = [t.strip() for t in times.split(",") if t.strip()]
        return kwargs


class TwoGBinFormat(PmagFormat):
    key = "pmag-2g-bin"
    label = "2G Binary File"
    description = "A 2G Enterprises magnetometer binary file (.dat), one specimen per file."
    extensions = (".dat",)
    Options = TwoGBinOptions
    function = "_2g_bin"
    input_arg = "input_dir"

    def sniff(self, filename: str, head: bytes) -> float:
        if not filename.lower().endswith(".dat") or b"\x00" not in head[:256]:
            return 0.0
        return 0.9 if re.search(rb"NRM|AF|TT|ARM|IRM", head[:2048]) else 0.7


class TwoGAscFormat(PmagFormat):
    key = "pmag-2g-asc"
    label = "2G ASCII File"
    description = "A 2G Enterprises magnetometer ASCII export (.asc)."
    extensions = (".asc",)
    Options = TwoGAscOptions
    function = "_2g_asc"
    input_arg = "input_dir"

    def sniff(self, filename: str, head: bytes) -> float:
        if not filename.lower().endswith(".asc"):
            return 0.0
        lines = _text_head(head)[:6]
        if any(line.startswith("NAME\t") for line in lines) and b"DEMAG" in head:
            return 0.95
        return 0.6


class CitFormat(PmagFormat):
    key = "pmag-cit"
    label = "CIT File (.sam and its specimen files)"
    description = (
        "The Caltech (CIT) format: a .sam file listing the site and its specimens, "
        "read with the specimen files it names (pick them all together)."
    )
    extensions = (".sam",)
    multi_file = True
    Options = CitOptions
    function = "cit"
    file_arg = "magfile"
    reported_defaults = ("samp_con", "locname")
    _SPECIMEN_STEP = re.compile(r"^(NRM|AF|TT|TRM|ARM|IRM|CHI|LT)\s*\d*\s+\d{3}\.\d")
    _NUMBERS = re.compile(r"^\s*-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s*$")

    def sniff(self, filename: str, head: bytes) -> float:
        lines = _text_head(head)
        if filename.lower().endswith(".sam"):
            return 0.97 if len(lines) > 1 and self._NUMBERS.match(lines[1]) else 0.85
        if any(self._SPECIMEN_STEP.match(line) for line in lines[1:6]):
            return 0.4  # a specimen file: read with its .sam
        return 0.0

    def companions(self, filename: str, head: bytes, others: list[str]) -> list[str]:
        listed = {line.strip().lower() for line in _text_head(head)[2:]}
        return [name for name in others if name.lower() in listed]

    def kwargs(self, options: ImportOptions) -> dict[str, Any]:
        kwargs = _magic_kwargs(options)
        kwargs["methods"] = [m.strip() for m in kwargs["methods"].split(":") if m.strip()]
        return kwargs


class SioFormat(PmagFormat):
    key = "pmag-sio"
    label = "SIO File"
    description = (
        "The Scripps (SIO) magnetometer format: specimen, treatment, CSD, intensity, "
        "declination, inclination per line."
    )
    extensions = (".dat", ".sio")
    Options = SioOptions
    function = "sio"
    reported_defaults = ("codelist", "samp_con", "location")
    _ROW = re.compile(
        r"^\S+\s+-?\d+(\.\d*)?\s+-?\d+(\.\d*)?\s+-?\d+(\.\d*)?([eE][-+]?\d+)?"
        r"\s+-?\d+(\.\d*)?\s+-?\d+(\.\d*)?(\s.*)?$"
    )

    def sniff(self, filename: str, head: bytes) -> float:
        if b"\x00" in head:
            return 0.0
        lines = _text_head(head)[:8]
        if len(lines) < 2 or not all(self._ROW.match(line) for line in lines[:-1]):
            return 0.0
        return 0.85 if filename.lower().endswith((".dat", ".sio")) else 0.6


class Jr6Format(PmagFormat):
    key = "pmag-jr6"
    label = "AGICO JR6 File (.jr6)"
    description = "An AGICO JR-6 spinner magnetometer file in the .jr6 format."
    extensions = (".jr6",)
    Options = Jr6Options
    function = "jr6_jr6"

    def sniff(self, filename: str, head: bytes) -> float:
        return 0.95 if filename.lower().endswith(".jr6") else 0.0


class Jr6TxtFormat(PmagFormat):
    key = "pmag-jr6-txt"
    label = "AGICO JR6 File (.txt)"
    description = "An AGICO JR-6 spinner magnetometer file in the Rema6 text format."
    extensions = (".txt",)
    Options = Jr6TxtOptions
    function = "jr6_txt"

    def sniff(self, filename: str, head: bytes) -> float:
        return 0.95 if b"SPEC.ANGLES" in head and b"TECT.ANGLES" in head else 0.0


class UtrechtFormat(PmagFormat):
    key = "pmag-utrecht"
    label = "Utrecht File"
    description = "The Utrecht (Fort Hoofddijk) magnetometer format."
    extensions = (".af", ".th", ".tt")
    Options = UtrechtOptions
    function = "utrecht"

    def sniff(self, filename: str, head: bytes) -> float:
        if not filename.lower().endswith((".af", ".th", ".tt")):
            return 0.0
        lines = _text_head(head)
        return 0.85 if len(lines) > 2 and lines[1].count(",") >= 5 else 0.5


class LdeoFormat(PmagFormat):
    key = "pmag-ldeo"
    label = "LDEO File"
    description = "The Lamont-Doherty (LDEO) magnetometer format."
    extensions = (".dat",)
    Options = LdeoOptions
    function = "ldeo"
    file_arg = "magfile"
    reported_defaults = ("codelist", "samp_con", "location")

    def sniff(self, filename: str, head: bytes) -> float:
        lines = _text_head(head)[:4]
        if len(lines) > 2 and lines[1].lstrip().startswith("LAT:") and "TREAT" in lines[2]:
            return 0.95
        return 0.0


class HujiFormat(PmagFormat):
    key = "pmag-huji"
    label = "HUJI File"
    description = "The Hebrew University (HUJI) magnetometer format (new style)."
    extensions = (".txt",)
    Options = HujiOptions
    function = "huji"
    file_arg = "magfile"
    reported_defaults = ("codelist", "samp_con", "location")
    _ROW = re.compile(r"^\S+\t\S+\t\d{1,2}/\d{1,2}/\d{2,4}\t\d{1,2}:\d{2}\t[A-Z]+\t")

    def sniff(self, filename: str, head: bytes) -> float:
        lines = _text_head(head)[:3]
        return 0.85 if lines and all(self._ROW.match(line) for line in lines) else 0.0


FORMATS: tuple[type[PmagFormat], ...] = (
    GenericFormat,
    TwoGBinFormat,
    TwoGAscFormat,
    CitFormat,
    SioFormat,
    Jr6Format,
    Jr6TxtFormat,
    UtrechtFormat,
    LdeoFormat,
    HujiFormat,
)
FORMAT_KEYS = tuple(f.key for f in FORMATS)


class PmagLabFormatsOptions(PluginOptions):
    formats: list[str] = Field(
        default_factory=lambda: list(FORMAT_KEYS),
        description=f"The lab formats the import step offers, of {', '.join(FORMAT_KEYS)}",
    )


class PmagLabFormatsPlugin(FiestaPlugin):
    name = "pmag-lab-formats"
    description = (
        "Lab instrument files (2G, CIT, SIO, JR6, Utrecht, LDEO, HUJI, PmagPy generic) "
        "converted to MagIC text in the upload page's import step, by PmagPy's converters."
    )
    Options = PmagLabFormatsOptions

    def check(self, node: NodeConfig, options: PmagLabFormatsOptions) -> None:
        if unknown := sorted(set(options.formats) - set(FORMAT_KEYS)):
            raise ValueError(
                f"plugin 'pmag-lab-formats': unknown formats {unknown}; known: {list(FORMAT_KEYS)}"
            )

    def import_formats(self, node: NodeConfig) -> list[ImportFormat]:
        wanted = set(self.options(node).formats)
        return [fmt() for fmt in FORMATS if fmt.key in wanted]
