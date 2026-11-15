"""Readers for the field models' published formats and their conversion to
the cubic B-spline layout SHMODEL reads (shmodel.py), following GEOMAGIA's
field_models/conversion.py and ensembles.py.

Epoch tables (Gauss coefficients at a list of dates) become the natural cubic
interpolant of every coefficient, written exactly as cubic Bezier segments in
the B-spline layout (triple interior knots): the converted model reproduces
the supplied epochs (checked to 1e-7 nT) and is a cubic interpolation between
them, not a recovered native time model. Ensembles stay at their epochs as a
(epochs, coefficients, members) cube; shmodel.ensemble_predictions applies the
same natural cubic in time.

Only numpy and the standard library: the SHAWQ Excel workbooks are read with
zipfile + ElementTree.
"""

import io
import math
import re
import zipfile
from itertools import pairwise
from xml.etree import ElementTree

import numpy as np


def degree_for_count(count: int) -> int:
    degree = math.isqrt(count + 1) - 1
    if degree < 1 or degree * (degree + 2) != count:
        raise ValueError(f"{count} Gauss coefficients are not a complete expansion")
    return degree


def numeric_lines(text: str) -> list[list[float]]:
    return [
        [float(v.replace("D", "E")) for v in line.split()]
        for line in text.splitlines()
        if line.strip()
    ]


def validate_epochs(times, rows) -> None:
    if len(times) < 2 or len(rows) != len(times) or any(b <= a for a, b in pairwise(times)):
        raise ValueError("expected at least two strictly increasing coefficient epochs")
    count = len(rows[0])
    degree_for_count(count)
    if any(len(row) != count or not all(map(math.isfinite, row)) for row in rows):
        raise ValueError("incomplete or non-finite coefficient epochs")
    if not all(map(math.isfinite, times)):
        raise ValueError("non-finite epochs")


def natural_spline(times, rows):
    """Knots and spline-major control points of each coefficient's natural
    cubic interpolant (GEOMAGIA conversion.natural_spline)."""
    validate_epochs(times, rows)
    size, count = len(times), len(rows[0])
    steps = [b - a for a, b in pairwise(times)]
    controls = [[0.0] * count for _ in range(3 * (size - 1) + 1)]
    for column in range(count):
        values = [row[column] for row in rows]
        diagonal = [1.0] * size
        rhs = [0.0] * size
        for i in range(1, size - 1):
            diagonal[i] = 2 * (steps[i - 1] + steps[i])
            rhs[i] = 6 * (
                (values[i + 1] - values[i]) / steps[i] - (values[i] - values[i - 1]) / steps[i - 1]
            )
            if i > 1:
                factor = steps[i - 1] / diagonal[i - 1]
                diagonal[i] -= factor * steps[i - 1]
                rhs[i] -= factor * rhs[i - 1]
        second = [0.0] * size
        for i in range(size - 2, 0, -1):
            second[i] = (rhs[i] - steps[i] * second[i + 1]) / diagonal[i]
        controls[0][column] = values[0]
        for i, step in enumerate(steps):
            slope = (values[i + 1] - values[i]) / step
            left = slope - step * (2 * second[i] + second[i + 1]) / 6
            right = slope + step * (second[i] + 2 * second[i + 1]) / 6
            controls[3 * i + 1][column] = values[i] + step * left / 3
            controls[3 * i + 2][column] = values[i + 1] - step * right / 3
            controls[3 * i + 3][column] = values[i + 1]
    knots = [times[0]] * 4 + [t for t in times[1:-1] for _ in range(3)] + [times[-1]] * 4
    return knots, controls


def write_standard(start, end, degree, knots, controls, errors=None) -> str:
    """The anymodel text layout (GEOMAGIA conversion.write_standard; an
    optional uncertainty array follows the coefficients)."""
    size, count = len(controls), degree * (degree + 2)
    if len(knots) != size + 4 or any(len(row) != count for row in controls):
        raise ValueError("invalid coefficient dimensions")
    out = io.StringIO()
    out.write(f"{start:.17g} {end:.17g}\n{degree} 0 {size}\n")
    blocks = [knots, *controls, *(errors or [])]
    for values in blocks:
        for offset in range(0, len(values), 6):
            out.write(
                " ".join(format(float(v), ".17g") for v in values[offset : offset + 6]) + "\n"
            )
    return out.getvalue()


def read_standard(text: str):
    """Start, end, degree, knots and spline-major coefficient rows (and
    error rows, if any) of an anymodel text file."""
    lines = text.splitlines()
    start, end = (float(v) for v in lines[0].split()[:2])
    tokens = [float(v.replace("D", "E")) for line in lines[1:] for v in line.split()]
    degree, _, size = (int(v) for v in tokens[:3])
    count = degree * (degree + 2)
    knots = tokens[3 : size + 7]
    rest = tokens[size + 7 :]
    if len(rest) not in (size * count, 2 * size * count):
        raise ValueError("unexpected spline coefficient layout")
    rows = [rest[i : i + count] for i in range(0, len(rest), count)]
    return start, end, degree, knots, rows[:size], rows[size:] or None


def convert_epochs(times, rows) -> str:
    """An epoch table as a natural cubic B-spline model file."""
    knots, controls = natural_spline(times, rows)
    return write_standard(times[0], times[-1], degree_for_count(len(rows[0])), knots, controls)


def reverse_ka_bp(text: str) -> str:
    """GGFSS70: a spline in ka BP as calendar years, year = 1950 - 1000 * ka
    (knots and control points reversed; the spline itself is unchanged)."""
    start, end, degree, knots, rows, errors = read_standard(text)
    if errors:
        raise ValueError("GGFSS70 conversion expects a mean-only spline")
    return write_standard(
        1950 - end * 1000,
        1950 - start * 1000,
        degree,
        [1950 - t * 1000 for t in reversed(knots)],
        list(reversed(rows)),
    )


# --- Source formats ---------------------------------------------------------------


def read_epoch_matrix(text: str):
    """Kalmag and pfm9k.2 tables: line 1 the epochs, then one line per Gauss
    coefficient (g10, g11, h11, ...). A Kalmag MEAN_STD export alternates
    mean and marginal standard deviation columns; only the means are kept."""
    data = numeric_lines(text)
    times = data[0]
    if any(len(row) != len(times) for row in data):
        raise ValueError("inconsistent coefficient matrix width")
    if len(times) % 2 == 0 and times[::2] == times[1::2]:
        if any(v < 0 for row in data[1:] for v in row[1::2]):
            raise ValueError("negative supplied coefficient uncertainty")
        return times[::2], [list(row) for row in zip(*(row[::2] for row in data[1:]), strict=True)]
    return times, [list(row) for row in zip(*data[1:], strict=True)]


def read_sha_dif(text: str):
    """SHA.DIF.14k: rows of `year n m g h` in uT, to nT epoch rows."""
    epochs: dict[float, dict[int, float]] = {}
    data = numeric_lines(text)
    degree = max(int(row[1]) for row in data)
    for year, n, m, g, h in data:
        n, m = int(n), int(m)
        if not 1 <= n <= degree or not 0 <= m <= n or (m == 0 and h != 0):
            raise ValueError("invalid degree/order in SHA.DIF")
        values = epochs.setdefault(year, {})
        index = n * n - 1 if m == 0 else n * n + 2 * m - 2
        if index in values:
            raise ValueError("duplicate SHA.DIF coefficient")
        values[index] = g * 1000
        if m:
            values[index + 1] = h * 1000
    times = sorted(epochs)
    return times, [[epochs[t][k] for k in range(degree * (degree + 2))] for t in times]


_XLSX = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _column(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference).group(0)
    index = 0
    for letter in letters:
        index = index * 26 + ord(letter) - 64
    return index - 1


def xlsx_sheet(data: bytes, name: str) -> list[list]:
    """A worksheet's cached cell values as dense rows (numbers as float,
    strings as str, empty as None): what openpyxl's data_only read gives."""
    archive = zipfile.ZipFile(io.BytesIO(data))
    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    relations = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") for r in relations}
    sheet = next((s for s in workbook.iter(f"{_XLSX}sheet") if s.get("name") == name), None)
    if sheet is None:
        raise ValueError(f"no worksheet named {name!r}")
    target = targets[sheet.get(f"{_REL}id")].lstrip("/")
    path = target if target.startswith("xl/") else f"xl/{target}"
    shared: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        for item in ElementTree.fromstring(archive.read("xl/sharedStrings.xml")).iter(f"{_XLSX}si"):
            shared.append("".join(t.text or "" for t in item.iter(f"{_XLSX}t")))
    rows: dict[int, dict[int, object]] = {}
    width = 0
    for row in ElementTree.fromstring(archive.read(path)).iter(f"{_XLSX}row"):
        index = int(row.get("r")) - 1
        cells: dict[int, object] = {}
        for cell in row.iter(f"{_XLSX}c"):
            value = cell.find(f"{_XLSX}v")
            kind = cell.get("t")
            if kind == "inlineStr":
                text = "".join(t.text or "" for t in cell.iter(f"{_XLSX}t"))
                cells[_column(cell.get("r"))] = text
            elif value is None or value.text is None:
                continue
            elif kind == "s":
                cells[_column(cell.get("r"))] = shared[int(value.text)]
            elif kind in ("str", "e"):
                cells[_column(cell.get("r"))] = value.text
            elif kind == "b":
                cells[_column(cell.get("r"))] = bool(int(value.text))
            else:
                cells[_column(cell.get("r"))] = float(value.text)
        if cells:
            rows[index] = cells
            width = max(width, max(cells) + 1)
    height = max(rows) + 1 if rows else 0
    return [[rows.get(r, {}).get(c) for c in range(width)] for r in range(height)]


def read_shawq(data: bytes):
    """SHAWQ2k / SHAWQ-Iron Age workbooks: sheet "Model Coefficients
    (microT)", row 2 the labels g10, g11, h11, ..., then year rows in uT."""
    raw = xlsx_sheet(data, "Model Coefficients (microT)")
    labels = list(raw[1][1:])
    degree = degree_for_count(len(labels))
    expected = []
    for n in range(1, degree + 1):
        expected.append(f"g{n}0")
        for m in range(1, n + 1):
            expected.extend((f"g{n}{m}", f"h{n}{m}"))
    if labels != expected:
        raise ValueError("unexpected SHAWQ coefficient ordering")
    rows = [row for row in raw[2:] if isinstance(row[0], float)]
    return [float(row[0]) for row in rows], [[float(v) * 1000 for v in row[1:]] for row in rows]


def kalmag_ensemble(archive: bytes):
    """A Kalmag ENS zip (`Ensembles/<model>_ENS_Radius_6371.2_<i>.txt`, each
    one epoch then one row per coefficient, one column per draw) as the
    (epochs, coefficients, members) cube, epochs ascending."""
    z = zipfile.ZipFile(io.BytesIO(archive))
    matrices = []
    for info in z.infolist():
        if re.search(r"_ENS_Radius_[0-9.]+_\d+\.txt$", info.filename):
            matrices.append(numeric_lines(z.read(info).decode("ascii")))
    if not matrices:
        raise ValueError("no ensemble members in the Kalmag archive")
    if any(len(m[0]) != 1 for m in matrices):
        raise ValueError("expected one epoch per Kalmag ensemble file")
    matrices.sort(key=lambda m: m[0][0])
    times = [m[0][0] for m in matrices]
    cube = np.array([m[1:] for m in matrices], dtype=np.float64)
    return times, cube


def check_cube(times, cube) -> int:
    """Validate an (epochs, coefficients, members) ensemble; its degree."""
    degree = degree_for_count(cube.shape[1])
    if (
        cube.ndim != 3
        or cube.shape[0] != len(times)
        or cube.shape[2] < 2
        or not np.isfinite(cube).all()
        or not np.all(np.diff(times) > 0)
    ):
        raise ValueError("invalid ensemble dimensions or epochs")
    return degree
