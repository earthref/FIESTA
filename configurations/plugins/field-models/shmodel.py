"""SHMODEL in numpy: geomagnetic field synthesis from cubic B-spline Gauss models.

A port of the Fortran GEOMAGIA runs for its field-model pages: SHMODEL and its
routines (INTERV, BSPLINE, COORDS, PLMBAR, MAGFDZBR, ERRFDZ; the same routines
as GFZ's public CALS10kfield.f, "pieces of code by Jeremy Bloxham, Andrew
Jackson, David Gubbins, Kathy Whaler, David Barraclough, Rick O'Connell and Carl
de Boor") and its request driver's global grid, spline derivatives and
synthesis bases. Every step keeps the Fortran's arithmetic, including its
single-precision literals (FAC = 1.74532925E-2, pi = 3.14159265, the WGS
ellipsoid axes, a = 6371.2 km, the 1.0E-3 nT -> uT factor), so the results
agree with the compiled original to rounding (test_field_models.py states the
tolerance; the README how it was measured).

Model files are the gufm1/CALSxk "anymodel" text layout: line 1 `start end
...`, then `degree 0 nspl`, nspl+4 knot epochs and degree*(degree+2)*nspl
coefficients in nT (spline-major), optionally followed by as many coefficient
uncertainties.

Coordinates: geodetic latitude/longitude in degrees and altitude in km above
the ellipsoid for surface predictions (COORDS converts to geocentric); the
core-mantle boundary grid is geocentric at r = 3480 km. Times are calendar
years (negative BCE). Nothing extrapolates: a time outside a model's interval
is a ValueError.
"""

import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np


def _f32(value: float) -> float:
    """A Fortran default-REAL literal as the REAL*8 it is promoted to."""
    return float(np.float32(value))


# DATA FAC/1.74532925E-2/ -- degrees to radians, a single-precision literal.
FAC = _f32(1.74532925e-2)
# The request driver's synthesis bases use the double literal 1.74532925d-2.
FAC_DOUBLE = 1.74532925e-2
_PI_COORDS = _f32(3.14159265)
_B1 = _f32(40680925.0)  # WGS ellipsoid a**2 (km**2)
_B2 = _f32(40408585.0)  # WGS ellipsoid b**2 (km**2)
REFERENCE_RADIUS = _f32(6371.2)  # b = 6371.2/r in MAGFDZBR (km)
_NT_TO_UT = _f32(1.0e-3)
_TINY_SIN = _f32(1.0e-10)
CMB_RADIUS = 3480.0  # km
MAX_DEGREE = 20
VADM_EARTH_RADIUS_M = 6_371_200.0

# GEOMAGIA's request limits (field_models/forms.py, runner.py, global_field.py).
MAX_POINTS_PER_CURVE = 4001
MAX_TOTAL_CURVES = 1000
MAX_TOTAL_POINTS = 500_000
GLOBAL_LATITUDES = 37
GLOBAL_LONGITUDES = 72
MIN_ALTITUDE, MAX_ALTITUDE = -1.0, 100.0


@dataclass(frozen=True, eq=False)
class SplineModel:
    """A parsed coefficient file: knots (nspl+4,), coefficients and optional
    uncertainties (nspl, degree*(degree+2)) in nT."""

    name: str
    start: float
    end: float
    degree: int
    knots: np.ndarray
    coefficients: np.ndarray
    errors: np.ndarray | None

    @property
    def splines(self) -> int:
        return len(self.coefficients)

    @property
    def has_uncertainty(self) -> bool:
        return self.errors is not None


def coefficient_count(degree: int) -> int:
    return degree * (degree + 2)


def parse_model(text: str, name: str = "model") -> SplineModel:
    """Parse the anymodel layout, validating it as GEOMAGIA's catalogue and
    the Fortran driver do (degree 1-20, 4-2048 splines, a mean or a mean plus
    uncertainty array, knots covering the stated interval)."""
    lines = text.splitlines()
    if len(lines) < 3:
        raise ValueError(f"{name}: not a spline coefficient file")
    start, end = (float(v.replace("D", "E").replace("d", "e")) for v in lines[0].split()[:2])
    values = np.array(
        " ".join(lines[1:]).replace("D", "E").replace("d", "e").split(), dtype=np.float64
    )
    if len(values) < 3:
        raise ValueError(f"{name}: missing degree and spline count")
    degree, splines = int(values[0]), int(values[2])
    if values[0] != degree or values[2] != splines:
        raise ValueError(f"{name}: degree and spline count must be integers")
    if not 1 <= degree <= MAX_DEGREE or not 4 <= splines <= 2048:
        raise ValueError(f"{name}: degree {degree} or {splines} splines out of range")
    count = coefficient_count(degree)
    knots_end = 3 + splines + 4
    expected = knots_end + count * splines
    if len(values) not in (expected, expected + count * splines):
        raise ValueError(f"{name}: unexpected coefficient layout ({len(values)} values)")
    knots = values[3:knots_end]
    coefficients = values[knots_end:expected].reshape(splines, count)
    errors = values[expected:].reshape(splines, count) if len(values) > expected else None
    if not (np.all(np.isfinite(values)) and math.isfinite(start) and math.isfinite(end)):
        raise ValueError(f"{name}: non-finite values")
    if np.any(np.diff(knots) < 0) or not knots[3] <= start < end <= knots[splines]:
        raise ValueError(f"{name}: the knots do not cover {start:g} to {end:g}")
    for array in (knots, coefficients, errors):
        if array is not None:
            array.flags.writeable = False
    return SplineModel(name, start, end, degree, knots, coefficients, errors)


# --- B-splines in time ------------------------------------------------------


def _intervals(knots: np.ndarray, splines: int, times: np.ndarray) -> np.ndarray:
    """INTERV: the 1-based nleft with tknts(nleft) < t <= tknts(nleft+1)
    (nleft = 4 at the first knot), for times inside tknts(4)..tknts(nspl+1)."""
    if np.any(times < knots[3]) or np.any(times > knots[splines]):
        raise ValueError("time outside the model's spline support")
    # First 1-based n in 5..nspl+1 with t <= tknts(n); nleft = n - 1.
    n = np.searchsorted(knots, times, side="left") + 1
    return np.clip(n, 5, splines + 1) - 1


def _bspline(knots: np.ndarray, times: np.ndarray, nleft: np.ndarray) -> np.ndarray:
    """BSPLINE (order 4): the four non-zero cubic B-splines at each time."""
    spl = np.zeros((len(times), 4))
    spl[:, 0] = 1.0
    deltar = np.zeros((len(times), 3))
    deltal = np.zeros((len(times), 3))
    for j in range(1, 4):
        deltar[:, j - 1] = knots[nleft + j - 1] - times
        deltal[:, j - 1] = times - knots[nleft - j]
        saved = np.zeros(len(times))
        for i in range(1, j + 1):
            term = spl[:, i - 1] / (deltar[:, i - 1] + deltal[:, j - i])
            spl[:, i - 1] = saved + deltar[:, i - 1] * term
            saved = deltal[:, j - i] * term
        spl[:, j] = saved
    return spl


def gauss_coefficients(model: SplineModel, times, errors: bool = False):
    """Gauss coefficients (T, nc) at the times (and, with errors, the
    spline-weighted coefficient uncertainties), as SHMODEL sums them."""
    times = np.atleast_1d(np.asarray(times, dtype=np.float64))
    nleft = _intervals(model.knots, model.splines, times)
    spl = _bspline(model.knots, times, nleft)
    first = nleft - 4  # 0-based index of the first of the four splines

    def combine(array):
        out = np.zeros((len(times), array.shape[1]))
        for j in range(4):
            out = out + spl[:, j, None] * array[first + j]
        return out

    g = combine(model.coefficients)
    dg = combine(model.errors) if errors and model.errors is not None else None
    return g, dg


def _spline_derivatives(knots: np.ndarray, year: float, left: int):
    """The request driver's spline_derivatives: values, first and second
    time derivatives of the four cubic B-splines (left is 1-based)."""
    values, firsts, seconds = [0.0] * 4, [0.0] * 4, [0.0] * 4
    values[0] = 1.0
    dl, dr = [0.0] * 4, [0.0] * 4
    for order in range(1, 4):
        dr[order - 1] = knots[left + order - 1] - year
        dl[order - 1] = year - knots[left - order]
        saved = saved1 = saved2 = 0.0
        for index in range(1, order + 1):
            denominator = dr[index - 1] + dl[order - index]
            term = term1 = term2 = 0.0
            if denominator != 0:
                term = values[index - 1] / denominator
                term1 = firsts[index - 1] / denominator
                term2 = seconds[index - 1] / denominator
            values[index - 1] = saved + dr[index - 1] * term
            firsts[index - 1] = saved1 - term + dr[index - 1] * term1
            seconds[index - 1] = saved2 - 2 * term1 + dr[index - 1] * term2
            saved = dl[order - index] * term
            saved1 = term + dl[order - index] * term1
            saved2 = 2 * term1 + dl[order - index] * term2
        values[order], firsts[order], seconds[order] = saved, saved1, saved2
    return np.array(values), np.array(firsts), np.array(seconds)


# --- Geometry and Legendre functions ------------------------------------------


def _coords(altitude: float, theta: np.ndarray):
    """COORDS: geodetic colatitude (radians) and altitude (km) -> geocentric
    radius r, colatitude and the rotation sines/cosines sd, cd."""
    theta = _PI_COORDS / 2 - theta
    clat = np.cos(theta)
    slat = np.sin(theta)
    one = _B1 * clat * clat
    two = _B2 * slat * slat
    three = one + two
    four = np.sqrt(three)
    r = np.sqrt(altitude * (altitude + 2.0 * four) + (_B1 * one + _B2 * two) / three)
    cd = (altitude + four) / r
    sd = (_B1 - _B2) / four * slat * clat / r
    sinth = slat * cd - clat * sd
    costh = clat * cd + slat * sd
    return r, _PI_COORDS / 2.0 - np.arctan2(sinth, costh), sd, cd


def _plmbar(z: np.ndarray, lmax: int):
    """PLMBAR: Schmidt semi-normalised P(l,m)(z) and dP/dtheta, k = l(l+1)/2+m
    (0-based), for z = cos(colatitude) (one column per site)."""
    z = np.asarray(z, dtype=np.float64)
    nl = (lmax + 1) * (lmax + 2) // 2
    p = np.zeros((nl, *z.shape))
    dp = np.zeros((nl, *z.shape))
    pm2 = np.ones_like(z)
    p[0] = 1.0
    pm1 = z
    p[1] = math.sqrt(3.0) * pm1
    k = 1  # Fortran k=2
    for ell in range(2, lmax + 1):
        k += ell
        plm = ((2 * ell - 1) * z * pm1 - (ell - 1) * pm2) / ell
        p[k] = math.sqrt(2 * ell + 1) * plm
        pm2, pm1 = pm1, plm
    pmm = np.ones_like(z)
    sintsq = (1.0 - z) * (1.0 + z)
    fnum, fden = -1.0, 0.0
    kstart = 0  # Fortran kstart=1
    for m in range(1, lmax + 1):
        kstart += m + 1
        fnum += 2.0
        fden += 2.0
        pmm = pmm * sintsq * fnum / fden
        pm2 = np.sqrt((4 * m + 2) * pmm)
        p[kstart] = pm2
        if m == lmax:
            break
        pm1 = z * math.sqrt(2 * m + 3) * pm2
        k = kstart + m + 1
        p[k] = pm1
        if m < lmax - 1:
            for ell in range(m + 2, lmax + 1):
                k += ell
                f1 = math.sqrt(((2 * ell + 1) * (2 * ell - 1)) / ((ell + m) * (ell - m)))
                f2 = math.sqrt(
                    ((2 * ell + 1) * (ell - m - 1) * (ell + m - 1))
                    / ((2 * ell - 3) * (ell + m) * (ell - m))
                )
                plm = z * f1 * pm1 - f2 * pm2
                p[k] = plm
                pm2, pm1 = pm1, plm
    k = 0
    for ell in range(1, lmax + 1):
        fac = 1.0 / math.sqrt(2 * ell + 1)
        for _m in range(ell + 1):
            k += 1
            p[k] = p[k] * fac
    # Derivatives with respect to theta (Fortran 1-based k -> 0-based k-1).
    dp[1] = -p[2]
    dp[2] = p[1]
    k = 3
    for ell in range(2, lmax + 1):
        k += 1
        dp[k - 1] = -math.sqrt(ell * (ell + 1) / 2.0) * p[k]
        dp[k + ell - 1] = math.sqrt(ell / 2.0) * p[k + ell - 2]
        for m in range(1, ell):
            k += 1
            fac1 = math.sqrt((ell - m) * (ell + m + 1))
            fac2 = math.sqrt((ell + m) * (ell - m + 1))
            if m == 1:
                fac2 = fac2 * math.sqrt(2.0)
            dp[k - 1] = 0.5 * (fac2 * p[k - 2] - fac1 * p[k])
        k += 1
    return p, dp


def _basis(p, dp, theta, phi, r, lmax):
    """MAGFDZBR's linear synthesis bases dx, dy, dz (nc, ...) before the
    geodetic rotation (X north, Y east, Z down; nT per nT of coefficient)."""
    shape = np.broadcast(theta, phi, r).shape
    nc = coefficient_count(lmax)
    dx = np.zeros((nc, *shape))
    dy = np.zeros((nc, *shape))
    dz = np.zeros((nc, *shape))
    b = REFERENCE_RADIUS / r
    sinth = np.sin(theta)
    sinth = np.where(np.abs(sinth) < _TINY_SIN, _TINY_SIN, sinth)
    for ell in range(1, lmax + 1):
        l1 = ell + 1
        bb = b ** (ell + 2)
        k = ell * ell - 1
        k1 = (ell * l1) // 2
        dx[k] = dp[k1] * bb
        dz[k] = -p[k1] * l1 * bb
        for m in range(1, ell + 1):
            t = float(m) * phi
            k = ell * ell + 2 * m - 2
            k1 = (ell * l1) // 2 + m
            sint, cost = np.sin(t), np.cos(t)
            dxd = dp[k1] * bb
            dx[k] = dxd * cost
            dx[k + 1] = dxd * sint
            dxy = m * p[k1] * bb / sinth
            dy[k] = dxy * sint
            dy[k + 1] = -dxy * cost
            dzd = -l1 * p[k1] * bb
            dz[k] = dzd * cost
            dz[k + 1] = dzd * sint
    return dx, dy, dz


def _rotate(x, z, sd, cd):
    return x * cd + z * sd, z * cd - x * sd


@dataclass(frozen=True)
class SiteBases:
    """Per-site synthesis bases (nc, S), unrotated and geodetic-rotated."""

    dx: np.ndarray
    dy: np.ndarray
    dz: np.ndarray
    rx: np.ndarray
    rz: np.ndarray
    sd: np.ndarray
    cd: np.ndarray


def site_bases(latitudes, longitudes, altitude: float, degree: int, fac: float = FAC):
    lat = np.asarray(latitudes, dtype=np.float64)
    lon = np.asarray(longitudes, dtype=np.float64)
    theta = (90.0 - lat) * fac
    phi = lon * fac
    r, theta, sd, cd = _coords(float(altitude), theta)
    p, dp = _plmbar(np.cos(theta), degree)
    dx, dy, dz = _basis(p, dp, theta, phi, r, degree)
    rx, rz = _rotate(dx, dz, sd, cd)
    return SiteBases(dx, dy, dz, rx, rz, sd, cd)


def surface_bases(latitudes, longitudes, altitude: float, degree: int) -> np.ndarray:
    """The driver's `--basis` mode: geodetic X/Y/Z bases (S, nc, 3) at
    each site, which ensemble statistics apply to every member."""
    bases = site_bases(latitudes, longitudes, altitude, degree, fac=FAC_DOUBLE)
    return np.stack([bases.rx, bases.dy, bases.rz], axis=-1).transpose(1, 0, 2)


# --- Curves ---------------------------------------------------------------------


def curve_years(start: float, end: float, step: float) -> np.ndarray:
    """The driver's time grid: start, start+step, ... and always the end."""
    count = math.ceil((end - start) / step) + 1
    years = np.minimum(start + np.arange(count) * step, end)
    years[-1] = end
    return years


def synthesize(model: SplineModel, years, latitudes, longitudes, altitude: float = 0.0):
    """SHMODEL at every (year, site): F (uT), D and I (degrees) as (T, S)
    arrays and, when the file has them, the propagated uncertainties EF (uT),
    ED and EI (degrees; NaN where ERRFDZ's variance rotation goes negative)."""
    years = np.atleast_1d(np.asarray(years, dtype=np.float64))
    if np.any(years < model.start) or np.any(years > model.end):
        raise ValueError(f"{model.name} covers {model.start:g} to {model.end:g} only")
    g, dg = gauss_coefficients(model, years, errors=True)
    bases = site_bases(latitudes, longitudes, altitude, model.degree)
    x0 = g @ bases.dx
    y = g @ bases.dy
    z0 = g @ bases.dz
    sd, cd = bases.sd[None, :], bases.cd[None, :]
    x, z = _rotate(x0, z0, sd, cd)
    h = np.sqrt(x * x + y * y)
    f = np.sqrt(h * h + z * z)
    out = {
        "intensity": f * _NT_TO_UT,
        "decl": np.arctan2(y, x) / FAC,
        "incl": np.arcsin(z / f) / FAC,
    }
    if dg is not None:
        with np.errstate(invalid="ignore", divide="ignore"):
            dg2 = dg * dg
            vx = dg2 @ (bases.dx * bases.dx)
            vy = dg2 @ (bases.dy * bases.dy)
            vz = dg2 @ (bases.dz * bases.dz)
            ex = np.sqrt(vx * cd**2 + vz * sd**2)
            ey = np.sqrt(vy)
            ez = np.sqrt(vz * cd**2 - vx * sd**2)
            eh = np.sqrt((1 / h**2) * ((x * ex) ** 2 + (y * ey) ** 2))
            ef = np.sqrt((1 / f**2) * ((x * ex) ** 2 + (y * ey) ** 2 + (z * ez) ** 2))
            ei = np.sqrt((1 / (1 + (z / h) ** 2)) ** 2 * ((ez / h) ** 2 + ((z * eh) / h**2) ** 2))
            ed = np.sqrt((1 / (1 + (y / x) ** 2)) ** 2 * ((ey / x) ** 2 + ((y * ex) / x**2) ** 2))
        out.update(
            intensity_uncertainty=ef * _NT_TO_UT,
            decl_uncertainty=ed / FAC,
            incl_uncertainty=ei / FAC,
        )
    return out


def vadm_factor(latitude: float) -> float:
    """VADM (10^22 A m^2) per uT of intensity at a site latitude, as
    GEOMAGIA computes it (4 pi / mu0 = 10^7; R = 6371.2 km)."""
    return (10 * VADM_EARTH_RADIUS_M**3 / 1e22) / math.sqrt(
        1 + 3 * math.sin(math.radians(latitude)) ** 2
    )


def gad_inclination(latitude):
    """Geocentric axial dipole inclination atan2(2 sin(lat), cos(lat)), degrees."""
    lat = np.radians(latitude)
    return np.degrees(np.arctan2(2 * np.sin(lat), np.cos(lat)))


# --- Global grid ------------------------------------------------------------------


def global_frame(model: SplineModel, year: float, nlat=GLOBAL_LATITUDES, nlon=GLOBAL_LONGITUDES):
    """The driver's `--global` grid at one year: rows of latitude -90..90,
    columns of longitude -180..180-360/nlon. Surface F (uT), D and I (deg)
    on the ellipsoid; CMB radial field (mT, outward positive) at 3480 km;
    secular accelerations (nT/yr^2) of surface F and CMB Br from the
    spline's analytic second derivative."""
    year = float(year)
    if not model.start <= year <= model.end:
        raise ValueError(f"{model.name} covers {model.start:g} to {model.end:g} only")
    knots, splines = model.knots, model.splines
    left = int(_intervals(knots, splines, np.array([year]))[0])
    spl = _bspline(knots, np.array([year]), np.array([left]))[0]
    _, first, second = _spline_derivatives(knots, year, left)
    rows = model.coefficients[left - 4 : left]
    g = np.zeros(rows.shape[1])
    g1 = np.zeros(rows.shape[1])
    g2 = np.zeros(rows.shape[1])
    for b in range(4):
        g = g + spl[b] * rows[b]
        g1 = g1 + first[b] * rows[b]
        g2 = g2 + second[b] * rows[b]
    lat = -90.0 + np.arange(nlat) * 180.0 / (nlat - 1)
    lon = -180.0 + np.arange(nlon) * 360.0 / nlon
    phi = (lon * FAC)[None, :]
    degree = model.degree
    # Surface: geodetic at the ellipsoid (altitude 0).
    r_s, theta_s, sd_s, cd_s = _coords(0.0, (90.0 - lat) * FAC)
    p, dp = _plmbar(np.cos(theta_s), degree)
    dx, dy, dz = _basis(p[:, :, None], dp[:, :, None], theta_s[:, None], phi, r_s[:, None], degree)
    sd_s, cd_s = sd_s[:, None], cd_s[:, None]
    rx, rz = _rotate(dx, dz, sd_s, cd_s)
    x = np.tensordot(g, rx, axes=1)
    y = np.tensordot(g, dy, axes=1)
    z = np.tensordot(g, rz, axes=1)
    h = np.sqrt(x * x + y * y)
    f = np.sqrt(h * h + z * z)
    velocity = [np.tensordot(g1, a, axes=1) for a in (rx, dy, rz)]
    accel = [np.tensordot(g2, a, axes=1) for a in (rx, dy, rz)]
    vv = sum(v * v for v in velocity)
    xa = x * accel[0] + y * accel[1] + z * accel[2]
    xv = x * velocity[0] + y * velocity[1] + z * velocity[2]
    fsa = (vv + xa) / f - (xv / f) ** 2 / f
    # Core-mantle boundary: geocentric, no rotation.
    theta_c = (90.0 - lat) * FAC
    pc, dpc = _plmbar(np.cos(theta_c), degree)
    cdx, cdy, cdz = _basis(
        pc[:, :, None], dpc[:, :, None], theta_c[:, None], phi, CMB_RADIUS, degree
    )
    br = -np.tensordot(g, cdz, axes=1)
    brsa = -np.tensordot(g2, cdz, axes=1)
    incl = np.arcsin(z / f) / FAC
    return {
        "latitudes": lat,
        "longitudes": lon,
        "intensity": f * _NT_TO_UT,
        "decl": np.arctan2(y, x) / FAC,
        "incl": incl,
        "radial": br * 1.0e-6,
        "intensity_acceleration": fsa,
        "radial_acceleration": brsa,
    }


# --- Ensembles ----------------------------------------------------------------------


@lru_cache(maxsize=16)
def interpolation_weights(times: tuple, years: tuple) -> np.ndarray:
    """The linear map (Y, E) from epoch values to their natural cubic
    interpolant at the years (GEOMAGIA's interpolation_weights, identical to
    the epoch-table conversion's natural spline)."""
    times_a = np.asarray(times, dtype=np.float64)
    count = len(times_a)
    diagonal = np.ones(count)
    rhs = np.zeros((count, count))
    step = np.diff(times_a)
    eye = np.eye(count)
    for i in range(1, count - 1):
        diagonal[i] = 2 * (step[i - 1] + step[i])
        rhs[i] = 6 * ((eye[i + 1] - eye[i]) / step[i] - (eye[i] - eye[i - 1]) / step[i - 1])
        if i > 1:
            factor = step[i - 1] / diagonal[i - 1]
            diagonal[i] -= factor * step[i - 1]
            rhs[i] -= factor * rhs[i - 1]
    second = np.zeros_like(rhs)
    for i in range(count - 2, 0, -1):
        second[i] = (rhs[i] - step[i] * second[i + 1]) / diagonal[i]
    weights = []
    for year in years:
        if not times_a[0] <= year <= times_a[-1]:
            raise ValueError("requested year outside the ensemble's epochs")
        i = max(0, min(count - 2, int(np.searchsorted(times_a, year)) - 1))
        h = step[i]
        a = (times_a[i + 1] - year) / h
        b = (year - times_a[i]) / h
        weights.append(
            a * eye[i]
            + b * eye[i + 1]
            + ((a**3 - a) * second[i] + (b**3 - b) * second[i + 1]) * h * h / 6
        )
    result = np.asarray(weights)
    result.flags.writeable = False
    return result


def ensemble_predictions(cube: np.ndarray, times, years, latitude, longitude, altitude):
    """Every member's X/Y/Z (Y, 3, M) at one site: the members' fields at
    their epochs through the synthesis bases, then the natural cubic in time
    (linear, so equal to interpolating each member's Gauss coefficients)."""
    degree = int(round(math.sqrt(cube.shape[1] + 1))) - 1
    bases = surface_bases([latitude], [longitude], altitude, degree)[0]
    epochs = np.einsum("ecm,ca->eam", cube, bases, optimize=True)
    weights = interpolation_weights(tuple(float(t) for t in times), tuple(float(y) for y in years))
    members = cube.shape[2]
    return (weights @ epochs.reshape(len(times), -1)).reshape(len(years), 3, members)


def ensemble_statistics(vector: np.ndarray, include_members: bool = False):
    """Pointwise sample SD (ddof=1) of the members' F, D (about the circular
    mean) and I: GEOMAGIA's prediction_statistics."""
    x, y, z = vector[:, 0, :], vector[:, 1, :], vector[:, 2, :]
    horizontal = np.hypot(x, y)
    intensity = np.sqrt(x * x + y * y + z * z) / 1000
    with np.errstate(invalid="ignore"):
        decl = np.degrees(np.arctan2(y, x))
        incl = np.degrees(np.arctan2(z, horizontal))
    decl = np.where(horizontal > 1e-9, decl, np.nan)
    incl = np.where(intensity > 1e-12, incl, np.nan)
    center = np.degrees(
        np.arctan2(
            np.mean(np.sin(np.radians(decl)), axis=1), np.mean(np.cos(np.radians(decl)), axis=1)
        )
    )
    residual = (decl - center[:, None] + 180) % 360 - 180

    def spread(values):
        # Shift before reducing so identical members give exactly zero.
        return np.std(values - values[:, :1], axis=1, ddof=1)

    errors = {
        "intensity_uncertainty": spread(intensity),
        "decl_uncertainty": spread(residual),
        "incl_uncertainty": spread(incl),
    }
    members = (
        {"intensity": intensity.T, "decl": decl.T, "incl": incl.T} if include_members else None
    )
    return errors, members


def median_location(locations):
    """Unweighted coordinate medians of distinct (lat, lon) points, unwrapping
    longitude across its largest gap (GEOMAGIA's median_location)."""
    from statistics import median

    if not locations:
        return None
    locations = sorted(set(locations))
    angles = sorted(lon % 360 for _, lon in locations)
    n = len(angles)
    cut = max(range(n), key=lambda i: angles[(i + 1) % n] + (360 if i == n - 1 else 0) - angles[i])
    origin = angles[(cut + 1) % n]
    longitude = median(a + 360 if a < origin else a for a in angles) % 360
    return (
        median(lat for lat, _ in locations),
        longitude - 360 if longitude >= 180 else longitude,
    )
