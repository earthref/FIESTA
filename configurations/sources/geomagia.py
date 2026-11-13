"""GEOMAGIA data source: GEOMAGIA50 archeomagnetic and volcanic records -> FIESTA GEOMAGIA.

One contribution per GEOMAGIA reference (study), keeping its reference ID as the
contribution ID; its records are the contribution's `sites` rows, one per UID.
Runs while FIESTA GEOMAGIA is in data-source mode (docs/data-sources.md), from
fiesta/backend/:

    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../../configurations/sources/geomagia.py --api http://localhost:18000 \\
        --csv geomagia50_v3_24072017_download.csv --studies studies.html \\
        --owner-email <steward> --owner-name "<Steward Name>" [--dry-run]

Until there is read access to the GEOMAGIA MySQL catalogue it reads the public
exports: `--csv`, the archeo/volcanic CSV the GEOMAGIA logs page publishes
(https://geomagia.gfz.de/docs/geomagia50_v3_24072017_download.csv), and
`--studies`, the HTML of https://geomagia.gfz.de/studies.php (or a saved copy)
for the references. A scheduled run (ops worker) passes `--state-dir`, where it
reads `geomagia.csv` and `studies.html`, and `--owner-map` for the owner. Lookup
codes resolve through configurations/geomagia/lookups.json (the GEOMAGIA ID glossary).
`--out DIR` writes the contribution files instead of syncing (how
configurations/geomagia/seeds/ were made).

GEOMAGIA's missing-value markers in measured numbers (-1, -999, -9999) are left
blank, as the GEOMAGIA site's own downloads do; lookup codes keep -1 ("No
measurement") and 0 ("Not specified"). VADM is calculated from the intensity and
site latitude, as the GEOMAGIA site does.
"""

import argparse
import asyncio
import csv
import hashlib
import html
import io
import json
import math
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

SLUG = "geomagia"
CONFIG = Path(__file__).resolve().parents[1] / SLUG
DATA_MODEL_VERSION = "3.4"
REVISION_KEY = "geomagia"
VADM_EARTH_RADIUS_M = 6_371_200.0

# CSV heading -> data model column (the ARCHEODIJ column, lower case).
CSV_COLUMNS = {
    "Age[yr.AD]": "age",
    "Sigma-ve[yr.]": "age_min",
    "Sigma+ve[yr.]": "age_max",
    "SigmaAgeID": "age_error_type_id",
    "N_Ba": "num_samples",
    "n_Ba[meas.]": "num_meas_spec",
    "n_Ba[acc.]": "num_acc_spec",
    "Ba[microT]": "ba",
    "SigmaBa[microT]": "sigma_ba",
    "VDM[E22_AmE2]": "vdm",
    "SigmaVDM[E22_AmE2]": "sigma_vdm",
    "N_Dir": "num_dir_samples",
    "n_Dir[meas.]": "num_dir_spec_collected",
    "n_Dir[acc.]": "num_dir_specimens",
    "Dec[deg.]": "decl",
    "Inc[deg.]": "incl",
    "Alpha95[deg.]": "alpha_95",
    "K": "k",
    "MaxAF[mT]": "af_step",
    "MaxTemp[deg.C]": "t_step",
    "PubDataID": "sample_id",
    "SiteName": "site_horizon",
    "LocationName": "site_name",
    "SiteLat[deg.]": "lat",
    "SiteLon[deg.]": "lon",
    "CountryRegionID": "site_id",
    "ArcheoVolcanic": "archeo_volcanic",
    "MatID": "material_id",
    "PIMethID": "pi_method_id",
    "AltMonID": "ac_id",
    "MDMonID": "md_ck_id",
    "CoolRID": "cr_corr_set_id",
    "AnisoID": "an_corr_set_id",
    "DirMethID": "dm_method_id",
    "DirAnalysisID": "dm_analysis_id",
    "DatMethID": "dating_method_id",
    "SpecTypeID": "specimen_type_id",
    "RefID": "reference_id",
    "CompilationID": "comp_ref",
    "UploadMonth": "upload_month",
    "UploadYear": "upload_year",
    "Uploader": "uploader",
    "Editor": "editor",
    "LastEditDate": "edit_date",
    "C14ID": "c14_id",
    "UID": "uid",
}

# Code column -> (named column, glossary table in lookups.json).
CODES = {
    "age_error_type_id": ("age_error_type", "AgeErrorID"),
    "dating_method_id": ("dating_methods", "DatMethod"),
    "pi_method_id": ("pi_methods", "PIID"),
    "ac_id": ("alteration_checks", "PIAltID"),
    "md_ck_id": ("md_checks", "PIMDID"),
    "an_corr_set_id": ("anisotropy_corrections", "PIANID"),
    "cr_corr_set_id": ("cooling_rate_corrections", "PICRID"),
    "dm_method_id": ("demag_method", "DirMethID"),
    "dm_analysis_id": ("dir_analysis", "DirID"),
    "specimen_type_id": ("specimen_types", "SpecID"),
    "material_id": ("materials", "MatID"),
    "comp_ref": ("compilations", "CompID"),
    "c14_calib_software_id": ("c14_calib_software", "C14Soft"),
    "calc_14c_calib_software_id": ("calc_c14_calib_software", "C14Soft"),
    "c14_calib_dataset_id": ("c14_calib_dataset", "C14DataSet"),
    "calc_14c_calib_dataset_id": ("calc_c14_calib_dataset", "C14DataSet"),
}
MISSING = {"", "-999", "-999.0", "-999.00", "-9999", "-9999.0"}
# Measured numbers whose -1 also means "not given" (the GEOMAGIA site's downloads).
MISSING_MINUS_ONE = {
    "age_min",
    "age_max",
    "num_sigmas",
    "num_acc_spec",
    "num_dir_specimens",
    "num_dir_samples",
    "k",
    "c14_id",
    "sample_id",
    "site_horizon",
}
TEXT = {
    "site_name",
    "site_horizon",
    "sample_id",
    "uploader",
    "editor",
    "edit_date",
    "archeo_volcanic",
}


def load_lookups() -> dict:
    return json.loads((CONFIG / "lookups.json").read_text())


def load_model() -> dict:
    return json.loads((CONFIG / "data_models" / f"{DATA_MODEL_VERSION}.json").read_text())


def codes(value: str) -> list[str]:
    """A code cell's IDs; GEOMAGIA joins SET members with ',' (MySQL) or ';' (CSV)."""
    return [t for t in (t.strip() for t in re.split(r"[;,:]", value)) if re.fullmatch(r"-?\d+", t)]


def code_name(lookups: dict, table: str, code: str) -> str:
    entry = lookups[table]["rows"].get(code)
    if entry is None:
        return f"Unknown (ID {code})"
    if table == "CompID":  # [authors, title, year, ...]
        return f"{entry[0].rstrip(', ')} ({entry[2]})"
    return entry[0] if isinstance(entry, list) else entry


def number(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def vadm(intensity: str, error: str, latitude: str) -> tuple[str, str]:
    """VADM and its error in 10²² Am² from μT and degrees (the GEOMAGIA site's formula)."""
    ba, lat = number(intensity), number(latitude)
    if ba is None or lat is None or ba < 0 or not -90 <= lat <= 90:
        return "", ""
    factor = (10 * VADM_EARTH_RADIUS_M**3 / 1e22) / math.sqrt(
        1 + 3 * math.sin(math.radians(lat)) ** 2
    )
    sigma = number(error)
    return f"{ba * factor:.2f}", f"{sigma * factor:.2f}" if sigma is not None and sigma >= 0 else ""


def site_row(record: dict, lookups: dict) -> dict:
    """One CSV record as a `sites` row."""
    row = {}
    for column, raw in record.items():
        value = raw.strip()
        if column in CODES:
            ids = codes(value)
            if column == "comp_ref":  # -1: in no compilation
                ids = [i for i in ids if i != "-1"]
            name_column, table = CODES[column]
            row[column] = ":".join(ids)
            row[name_column] = ":".join(dict.fromkeys(code_name(lookups, table, i) for i in ids))
        elif value in MISSING or (value == "-1" and column in MISSING_MINUS_ONE):
            row[column] = ""
        elif column in TEXT:
            row[column] = re.sub(r"\s+", " ", value)
        else:
            row[column] = value
    row["site"] = row["uid"]
    region = lookups["CRID"]["rows"].get(row.get("site_id", ""))
    if region:
        row["region_country"], row["continent"] = region[0], region[1]
    row["vadm"], row["sigma_vadm"] = vadm(
        row.get("ba", ""), row.get("sigma_ba", ""), row.get("lat", "")
    )
    return row


def read_csv(path: Path) -> tuple[str, list[dict]]:
    """The export's "Generated using ..." line and its records keyed by data model column.
    The export does not quote its cells (and none holds a comma)."""
    text = path.read_text(encoding="latin-1")
    generated, _, body = text.partition("\n")
    reader = csv.reader(io.StringIO(body), quoting=csv.QUOTE_NONE)
    header = [h.strip() for h in next(reader)]
    unknown = [h for h in header if h not in CSV_COLUMNS]
    if unknown:
        raise ValueError(f"unexpected CSV columns {unknown}")
    records = []
    for cells in reader:
        if not cells:
            continue
        if len(cells) != len(header):
            raise ValueError(f"row {reader.line_num}: {len(cells)} cells, expected {len(header)}")
        records.append({CSV_COLUMNS[h]: c for h, c in zip(header, cells, strict=True)})
    return generated.strip(), records


def read_studies(path: Path) -> dict[int, dict]:
    """GEOMAGIA's studies page (studies.php): one table row per reference."""
    page = path.read_text(encoding="latin-1")

    def text(cell: str) -> str:
        return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cell))).strip()

    studies = {}
    for tr in re.findall(r"<tr bgcolor=[^>]*>(.*?)</tr>", page, flags=re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S | re.I)
        if len(cells) != 9 or not text(cells[0]).isdigit():
            continue
        magic = re.findall(r'href="([^"]+)"', cells[8])
        studies[int(text(cells[0]))] = {
            "authors": text(cells[1]),
            "title": text(cells[2]),
            "year": text(cells[3]),
            "journal": text(cells[4]),
            "volume": text(cells[5]),
            "pages": text(cells[6]),
            "reference": text(cells[7]),
            # A saved Wayback copy prefixes its links.
            "magic_link": re.sub(r"^https?://web\.archive\.org/web/\d+[a-z_]*/", "", magic[0])
            if magic
            else "",
        }
    return studies


def short_citation(authors: str, year: str) -> str:
    """A short citation from GEOMAGIA's author list ("Smith A., Jones B."):
    "Smith (1990)", "Smith and Jones (1990)" or "Smith et al. (1990)"."""
    names = [a.strip() for a in re.split(r"\.,\s*", authors) if a.strip()]
    family = [re.sub(r"\s+([A-Z][a-z]?\.?-?)+\.?$", "", n).strip() for n in names]
    if not family:
        return year
    lead = (
        family[0]
        if len(family) == 1
        else f"{family[0]} and {family[1]}"
        if len(family) == 2
        else f"{family[0]} et al."
    )
    return f"{lead} ({year})" if year else lead


def contribution_row(ref_id: int, study: dict | None, generated: str) -> dict:
    study = study or {}
    row = {
        "data_model_version": DATA_MODEL_VERSION,
        "geomagia_reference_id": str(ref_id),
        "reference": study.get("reference", ""),
        "citation": short_citation(study.get("authors", ""), study.get("year", ""))
        if study
        else f"GEOMAGIA reference {ref_id}",
        "authors": study.get("authors", ""),
        "title": study.get("title", ""),
        "year": study.get("year", ""),
        "journal": study.get("journal", ""),
        "volume": study.get("volume", ""),
        "pages": study.get("pages", ""),
        "magic_link": study.get("magic_link", ""),
        "geomagia_version": generated.removeprefix("Generated using ").replace(" on ", " export, "),
    }
    return row


def table_text(table: str, columns: dict, rows: list[dict]) -> str:
    """One MagIC-style tab-delimited table: the model's columns that hold data, in its order."""
    used = [c for c in columns if any(r.get(c) for r in rows)]
    lines = [f"tab delimited\t{table}", "\t".join(used)]
    lines += ["\t".join(str(r.get(c, "")).replace("\t", " ") for c in used) for r in rows]
    return "\n".join(lines)


def build(csv_path: Path, studies_path: Path | None) -> tuple[str, dict[int, str], dict[int, dict]]:
    """(release, {reference ID: contribution text}, {reference ID: contribution row})."""
    lookups, model = load_lookups(), load_model()
    generated, records = read_csv(csv_path)
    studies = read_studies(studies_path) if studies_path else {}
    by_ref: dict[int, list[dict]] = {}
    for record in records:
        ref = int(record.pop("reference_id"))
        by_ref.setdefault(ref, []).append(site_row(record, lookups))
    texts, meta = {}, {}
    for ref, rows in sorted(by_ref.items()):
        rows.sort(key=lambda r: int(r["uid"]))
        head = contribution_row(ref, studies.get(ref), generated)
        texts[ref] = (
            "\n>>>>>>>>>>\n".join(
                [
                    table_text("contribution", model["tables"]["contribution"]["columns"], [head]),
                    table_text("sites", model["tables"]["sites"]["columns"], rows),
                ]
            )
            + "\n"
        )
        meta[ref] = head
    return generated, texts, meta


def release_time(generated: str) -> datetime:
    """When the export was made ("Generated using GEOMAGIA50.v3.2 on May/22/2019")."""
    match = re.search(r"on (\w+)/(\d+)/(\d{4})", generated)
    if not match:
        return datetime(2019, 5, 22, tzinfo=UTC)
    return datetime.strptime(" ".join(match.groups()), "%b %d %Y").replace(tzinfo=UTC)


def canonical(ref: int) -> str:
    return f"{SLUG}_contribution_{ref}.txt"


def source_records(texts: dict[int, str], meta: dict[int, dict], generated: str, owner_email: str):
    from fiesta.services.legacy import SourceFile, SourceRecord, SourceRevision

    when = release_time(generated)
    records = {}
    for ref, text in texts.items():
        body = text.encode()
        doi = meta[ref].get("reference") or None
        records[ref] = SourceRecord(
            id=ref,
            owner_email=owner_email,
            published=True,
            created_at=when,
            activated_at=when,
            data_model_version=DATA_MODEL_VERSION,
            revisions=[
                SourceRevision(
                    key=REVISION_KEY,
                    canonical=canonical(ref),
                    files={
                        canonical(ref): SourceFile(
                            source=canonical(ref), sha256=hashlib.sha256(body).hexdigest()
                        )
                    },
                    reference_doi=doi,
                    timestamp=when,
                )
            ],
        )
    return records


async def sync(api, texts, meta, generated, owner: dict, *, dry_run=False, ids=None) -> dict:
    from fiesta.services.legacy import record_fingerprint
    from fiesta.sources.client import SourceAPIError

    state = await api.state()
    summary = {
        "node": SLUG,
        "mode": state["mode"],
        "source_id": state["source_id"],
        "source": generated,
    }
    if state["mode"] != "source":
        return summary | {"skipped": "node is in public mode"}
    checkpoints = state["checkpoints"]
    records = source_records(texts, meta, generated, owner["email"])
    summary |= {
        "source_records": len(records),
        "unchanged": 0,
        "applied": 0,
        "planned": [],
        "bytes": 0,
    }
    errors = []
    wanted = set(ids or ())
    for ref, record in records.items():
        if wanted and ref not in wanted:
            continue
        if checkpoints.get(str(ref)) == record_fingerprint(record):
            summary["unchanged"] += 1
            continue
        if dry_run:
            summary["planned"].append(ref)
            continue
        try:
            result = await api.put_record(
                record, {f"{REVISION_KEY}/{canonical(ref)}": texts[ref].encode()}, owner
            )
        except (SourceAPIError, OSError, ValueError) as exc:
            errors.append({"id": ref, "error": str(exc)})
            continue
        summary["bytes"] += result["bytes"]
        summary["applied" if result["status"] == "applied" else "unchanged"] += 1
    summary["missing_from_source"] = sorted(
        int(i) for i in set(checkpoints) - {str(r) for r in records}
    )
    summary["errors"] = errors
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path(
            os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"), "fiesta", "sources", SLUG
        ),
        help="where the scheduled run finds geomagia.csv and studies.html",
    )
    parser.add_argument(
        "--csv", type=Path, help="GEOMAGIA archeo/volcanic CSV export [STATE_DIR/geomagia.csv]"
    )
    parser.add_argument(
        "--studies", type=Path, help="saved HTML of GEOMAGIA's studies.php [STATE_DIR/studies.html]"
    )
    parser.add_argument(
        "--owner-map",
        type=Path,
        help="JSON: default_owner (email), owner_accounts ({email: {name}}); never checked in",
    )
    parser.add_argument(
        "--out", type=Path, help="write the contribution files here instead of syncing"
    )
    parser.add_argument(
        "--api",
        default=os.environ.get("FIESTA_SOURCE_API", "http://localhost:8000"),
        help="FIESTA API base URL, serving /v2 [env FIESTA_SOURCE_API]",
    )
    parser.add_argument(
        "--owner-email", help="the GEOMAGIA steward's EarthRef account (owner of every record)"
    )
    parser.add_argument(
        "--owner-name", help="the steward's name, for an account the API must create"
    )
    parser.add_argument("--dry-run", action="store_true", help="report what would be sent")
    parser.add_argument("--ids", type=int, nargs="*", help="only these reference IDs")
    args = parser.parse_args()

    csv_path = args.csv or args.state_dir / "geomagia.csv"
    studies = args.studies or args.state_dir / "studies.html"
    if not csv_path.is_file():
        parser.error(f"no GEOMAGIA CSV at {csv_path}")
    generated, texts, meta = build(csv_path, studies if studies.is_file() else None)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        for ref, text in texts.items():
            if not args.ids or ref in args.ids:
                (args.out / canonical(ref)).write_text(text)
        print(json.dumps({"source": generated, "written": len(args.ids or texts)}))
        return

    email = os.environ.get("FIESTA_SOURCE_EMAIL")
    password = os.environ.get("FIESTA_SOURCE_PASSWORD")
    if not email or not password:
        parser.error("set FIESTA_SOURCE_EMAIL and FIESTA_SOURCE_PASSWORD (a GEOMAGIA node admin)")
    owner_map = json.loads(args.owner_map.read_text()) if args.owner_map else {}
    owner_email = args.owner_email or owner_map.get("default_owner")
    if not owner_email:
        parser.error("--owner-email (or an --owner-map default_owner) is required to sync")
    owner = {"email": owner_email} | owner_map.get("owner_accounts", {}).get(owner_email, {})
    if args.owner_name:
        owner["name"] = args.owner_name

    from fiesta.sources.client import SourceAPI
    from fiesta.sources.meteor import _report, _report_run

    async def run() -> dict:
        api = SourceAPI(args.api, SLUG)
        started = datetime.now(UTC)
        summary: dict = {"node": SLUG}
        try:
            await api.login(email, password)
            try:
                summary = await sync(
                    api, texts, meta, generated, owner, dry_run=args.dry_run, ids=args.ids
                )
            except Exception as exc:  # reported, then re-raised
                summary["failed"] = f"{type(exc).__name__}: {exc}"
                raise
            finally:
                if not args.dry_run and not summary.get("skipped"):
                    await _report_run(api, started, summary)
            return summary
        finally:
            await api.close()

    summary = asyncio.run(run())
    _report(summary)
    sys.exit(1 if summary.get("errors") else 0)


if __name__ == "__main__":
    main()
