"""RD data source: the legacy GERM Reservoir Database (earthref.org/GERMRD) -> FIESTA RD.

One contribution per GERMRD reservoir, keeping the legacy reservoir ID as the
contribution ID (https://earthref.org/GERMRD/<id>/ is contribution <id>); its
element, isotope and ratio values are the contribution's `values` rows, each
with its own reference (a reservoir such as Seawater compiles many). Runs while
FIESTA RD is in data-source mode (docs/data-sources.md), from fiesta/backend/:

    uv run python ../../configurations/sources/rd.py --fetch    # only cache the legacy pages
    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../../configurations/sources/rd.py --api http://localhost:18000 \\
        --owner-email <steward> --owner-name "<Steward Name>" [--dry-run]

GERMRD is a frozen CGI site (last new data 2006) with no API, so the source is
its pages, cached in `--state-dir` before every run (about 1,500 requests, three
at a time, the first time; cached pages are reused, `--refresh` re-reads them):

- `home.html`: https://earthref.org/GERMRD/, whose reservoir menu lists every
  reservoir ID;
- `reservoirs/<id>.txt`: the reservoir's "Tab delimited text file" download
  (Reservoir, Z, Element, Value, Median, SD, Low, High, N, Unit, Reference,
  Computation, Notes, Inserted);
- `reservoirs/<id>.html`: the same results as a page, in the same order, for
  what the download leaves out: each value's EarthRef Reference Database (ERR)
  reference ID and source table, and its Source(s) (the original references a
  compilation cites);
- `references/<n>.html`: each ERR reference page, for its DOI.

`--out DIR` writes the contribution files instead of syncing (how
configurations/rd/seeds/ were made).

What changes on the way: numbers lose the legacy's bare leading point (.5134 ->
0.5134); the degree signs the legacy database lost to `¿` are put back (21°N
EPR); each value is classed Element (it has an atomic number), Isotope or
Ratio; Inserted becomes an ISO date. The source tables' scanned images
(erda.sdsc.edu/bgfiles) no longer resolve, so only the table's ID is kept.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

SLUG = "rd"
CONFIG = Path(__file__).resolve().parents[1] / SLUG
DATA_MODEL_VERSION = "1.0"
REVISION_KEY = "germrd"
LEGACY = "https://earthref.org"
DATABASE_RELEASE = "GERM Reservoir Database (earthref.org/GERMRD)"
# The legacy database's last insertion, for a reservoir whose values carry no date.
DEFAULT_TIME = datetime(2006, 1, 1, tzinfo=UTC)
USER_AGENT = "EarthRef FIESTA RD data source"

TSV_COLUMNS = [
    "Reservoir", "Z", "Element", "Value", "Median", "SD", "Low", "High", "N", "Unit",
    "Reference", "Computation", "Notes", "Inserted",
]  # fmt: skip
NUMBERS = {"Value": "value", "Median": "median", "SD": "sd", "Low": "low", "High": "high"}
ISOTOPE = re.compile(r"^\d+[A-Z][a-z]?(\s*/\s*\d*[A-Z][a-z]?)?$|^(d|δ|e-?|ε)\d*[A-Z]")
ELEMENT_SYMBOLS = (
    "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu "
    "Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba "
    "La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb "
    "Bi Po At Rn Fr Ra Ac Th Pa U"
)
SYMBOLS = set(ELEMENT_SYMBOLS.split())
LOST_DEGREE = re.compile(r"(\d)\s*(?:Â)?¿\s*([NSEW])\b")


# ---- the legacy site ----------------------------------------------------------


def decode(data: bytes) -> str:
    """The legacy pages are Windows-1252; the downloads are UTF-8 where they have µ."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def clean(text: str) -> str:
    """One line of plain text: entities resolved, whitespace collapsed, ° restored."""
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or "")).replace("\xa0", " ")
    text = LOST_DEGREE.sub(r"\1°\2", text)
    return re.sub(r"\s+", " ", text).strip()


def reservoir_menu(home: str) -> dict[int, str]:
    """{reservoir ID: name} from the GERMRD home page's reservoir menu."""
    menu = re.search(r"name=[\"']?er_reservoir_id.*?</select>", home, re.S | re.I)
    if not menu:
        raise ValueError("the GERMRD home page has no reservoir menu")
    options = re.findall(r"<option[^>]*value=[\"']?(\d+)[\"']?[^>]*>([^<]*)", menu.group(0), re.I)
    return {int(i): clean(name) for i, name in options}


def reservoir_url(rid: int, download: bool) -> str:
    query = f"?n={rid}&res_id={rid}&database_name=germrd&search_start=main&sort=element"
    return f"{LEGACY}/GERMRD/{rid}/{query}" + ("&download_format=txt" if download else "")


def read_download(text: str) -> list[dict]:
    """The rows of a reservoir's tab-delimited download, by legacy column name."""
    text = text.replace("\r\n", "\n")
    data = text.split("DATA:\n", 1)[1].split("\n\n", 1)[0].splitlines() if "DATA:\n" in text else []
    if not data:
        return []
    header = data[0].split("\t")
    if header[: len(TSV_COLUMNS)] != TSV_COLUMNS:
        raise ValueError(f"unexpected GERMRD download columns: {header}")
    rows = []
    for line in data[1:]:
        cells = line.split("\t") + [""] * len(header)
        rows.append(dict(zip(header, cells, strict=False)))
    return rows


ERR_TABLE = re.compile(r"/ERR/n:(\d+),b:([\w.-]+)/?\"?>(.*?)</a>", re.S)
ERR_LINK = re.compile(r"/ERR/(\d+)/?\"?>(.*?)</a>", re.S)


def read_page(text: str) -> list[dict]:
    """Per result row of a reservoir page: its element and what the download leaves
    out (the ERR reference ID, source table and the Source(s) citations)."""
    rows = []
    for row in re.findall(r"<tr valign=top>(.*?)</tr>", text, re.S):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if len(cells) < 13:
            continue
        ref = ERR_TABLE.search(cells[11])
        rows.append(
            {
                "element": clean(cells[2]),
                "err_reference_id": ref.group(1) if ref else "",
                "source_table": ref.group(2) if ref else "",
                "citation": clean(ref.group(3)) if ref else clean(cells[11]),
                "sources": [(n, clean(label)) for n, label in ERR_LINK.findall(cells[12])],
            }
        )
    return rows


def read_reference(text: str) -> dict:
    """An ERR reference page: its full citation and DOI."""
    comment = re.search(r"<!--\s*\d+,\s*(.*?)//-->", text, re.S)
    citation = clean(comment.group(1)) if comment else ""
    doi = re.search(r"doi:\s*(10\.\d{4,9}/\S+?)\.?(?:\s|$)", citation, re.I)
    return {"citation": citation, "doi": doi.group(1) if doi else ""}


# ---- fetching -----------------------------------------------------------------


def fetch(state_dir: Path, *, refresh=False, ids=None, delay=0.5, workers=3, log=print) -> None:
    """Cache the legacy pages in STATE_DIR (see the module docstring), WORKERS at a time."""
    from concurrent.futures import ThreadPoolExecutor

    def get(url: str, path: Path) -> None:
        if path.is_file() and path.stat().st_size and not refresh:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=180) as response:
                    path.write_bytes(response.read())
                break
            except OSError as exc:
                if attempt == 2:
                    raise
                log(f"retrying {url}: {exc}")
                time.sleep(5)
        time.sleep(delay)

    get(f"{LEGACY}/GERMRD/", state_dir / "home.html")
    menu = reservoir_menu(decode((state_dir / "home.html").read_bytes()))
    wanted = [r for r in sorted(menu) if not ids or r in ids]

    def reservoir(rid: int) -> None:
        get(reservoir_url(rid, False), state_dir / "reservoirs" / f"{rid}.html")
        get(reservoir_url(rid, True), state_dir / "reservoirs" / f"{rid}.txt")

    with ThreadPoolExecutor(workers) as pool:
        for i, _ in enumerate(pool.map(reservoir, wanted), 1):
            if i % 100 == 0:
                log(f"{i}/{len(wanted)} reservoirs")
        refs = set()
        for rid in wanted:
            page = decode((state_dir / "reservoirs" / f"{rid}.html").read_bytes())
            refs |= {r["err_reference_id"] for r in read_page(page) if r["err_reference_id"]}
        pages = [
            (f"{LEGACY}/ERR/{r}/", state_dir / "references" / f"{r}.html")
            for r in sorted(refs, key=int)
        ]
        list(pool.map(lambda page: get(*page), pages))


# ---- contributions ------------------------------------------------------------


def load_model() -> dict:
    return json.loads((CONFIG / "data_models" / f"{DATA_MODEL_VERSION}.json").read_text())


def number(value: str) -> str:
    """A legacy number as written, without its bare leading point (.5134, -.3)."""
    value = value.strip()
    if re.fullmatch(r"-?\.\d+", value):
        value = value.replace(".", "0.", 1)
    return value


def inserted(value: str) -> str:
    """30-NOV-2004 -> 2004-11-30."""
    try:
        return datetime.strptime(value.strip(), "%d-%b-%Y").date().isoformat()
    except ValueError:
        return ""


def quantity(element: str, z: str) -> str:
    """Isotope (a mass number, delta or epsilon notation; the legacy's `¿` names, Greek
    letters it lost, are Pb isotope parameters), Element, or Ratio (element ratios
    and indices such as Mg# and Eu/Eu*)."""
    element = element.strip()
    if ISOTOPE.search(element) or "¿" in element:
        return "Isotope"
    if element in SYMBOLS or (z.strip() and not element.count("/")):
        return "Element"
    return "Ratio" if element else ""


def value_row(row: dict, page: dict, references: dict[str, dict]) -> dict:
    ref = references.get(page["err_reference_id"], {})
    out = {
        "reservoir": clean(row["Reservoir"]),
        "element": clean(row["Element"]),
        "z": row["Z"].strip(),
        "quantity": quantity(row["Element"], row["Z"]),
        "unit": clean(row["Unit"]),
        "n": row["N"].strip(),
        "computation": clean(row["Computation"]),
        "notes": clean(row["Notes"]),
        "citation": page["citation"] or clean(row["Reference"]),
        "reference": ref.get("doi", ""),
        "err_reference_id": page["err_reference_id"],
        "source_table": page["source_table"],
        "sources": ":".join(dict.fromkeys(label for _n, label in page["sources"] if label)),
        "inserted": inserted(row["Inserted"]),
    }
    out |= {column: number(row[legacy]) for legacy, column in NUMBERS.items()}
    return out


def reservoir_rows(rid: int, download: str, page: str, references: dict[str, dict]) -> list[dict]:
    """A reservoir's values: the download's rows, joined in order to the page's."""
    rows, extras = read_download(download), read_page(page)
    if len(rows) != len(extras):
        raise ValueError(
            f"reservoir {rid}: {len(rows)} downloaded rows but {len(extras)} on its page"
        )
    for i, (row, extra) in enumerate(zip(rows, extras, strict=True)):
        if clean(row["Element"]) != extra["element"]:
            raise ValueError(
                f"reservoir {rid} row {i + 1}: {row['Element']!r} downloaded,"
                f" {extra['element']!r} on its page"
            )
    return [value_row(row, extra, references) for row, extra in zip(rows, extras, strict=True)]


def contribution_row(rid: int, name: str, rows: list[dict]) -> dict:
    dois = {r["reference"] for r in rows}
    return {
        "data_model_version": DATA_MODEL_VERSION,
        "germrd_reservoir_id": str(rid),
        "reservoir": rows[0]["reservoir"] if rows else name,
        "citations": ":".join(dict.fromkeys(r["citation"] for r in rows if r["citation"])),
        # A reservoir compiled from one publication carries its DOI.
        "reference": dois.pop() if len(dois) == 1 else "",
    }


def table_text(table: str, columns: dict, rows: list[dict]) -> str:
    """One MagIC-style tab-delimited table: the model's columns that hold data, in its order."""
    used = [c for c in columns if any(r.get(c) for r in rows)]
    lines = [f"tab delimited\t{table}", "\t".join(used)]
    lines += ["\t".join(str(r.get(c, "")).replace("\t", " ") for c in used) for r in rows]
    return "\n".join(lines)


def build(state_dir: Path, ids=None) -> tuple[dict[int, str], dict[int, dict], dict[int, tuple]]:
    """From the cache: ({reservoir ID: contribution text}, {ID: contribution row},
    {ID: (first, last) insertion}). Reservoirs with no values are left out."""
    model = load_model()
    menu = reservoir_menu(decode((state_dir / "home.html").read_bytes()))
    references = {
        p.stem: read_reference(decode(p.read_bytes()))
        for p in sorted((state_dir / "references").glob("*.html"))
    }
    texts, meta, times = {}, {}, {}
    for rid, name in sorted(menu.items()):
        if ids and rid not in ids:
            continue
        download = state_dir / "reservoirs" / f"{rid}.txt"
        page = state_dir / "reservoirs" / f"{rid}.html"
        if not download.is_file() or not page.is_file():
            raise FileNotFoundError(
                f"reservoir {rid} is not cached in {state_dir}; its fetch failed"
            )
        rows = reservoir_rows(
            rid, decode(download.read_bytes()), decode(page.read_bytes()), references
        )
        if not rows:
            continue
        head = contribution_row(rid, name, rows)
        texts[rid] = (
            "\n>>>>>>>>>>\n".join(
                [
                    table_text("contribution", model["tables"]["contribution"]["columns"], [head]),
                    table_text("values", model["tables"]["values"]["columns"], rows),
                ]
            )
            + "\n"
        )
        meta[rid] = head
        dates = sorted(r["inserted"] for r in rows if r["inserted"])
        times[rid] = (
            tuple(datetime.fromisoformat(d).replace(tzinfo=UTC) for d in (dates[0], dates[-1]))
            if dates
            else (DEFAULT_TIME, DEFAULT_TIME)
        )
    return texts, meta, times


# ---- the sync -----------------------------------------------------------------


def canonical(rid: int) -> str:
    return f"{SLUG}_contribution_{rid}.txt"


def source_records(texts: dict[int, str], meta: dict[int, dict], owner_email: str, times: dict):
    from fiesta.services.legacy import SourceFile, SourceRecord, SourceRevision

    records = {}
    for rid, text in texts.items():
        body = text.encode()
        created, updated = times.get(rid, (DEFAULT_TIME, DEFAULT_TIME))
        records[rid] = SourceRecord(
            id=rid,
            owner_email=owner_email,
            published=True,
            created_at=created,
            activated_at=created,
            data_model_version=DATA_MODEL_VERSION,
            revisions=[
                SourceRevision(
                    key=REVISION_KEY,
                    canonical=canonical(rid),
                    files={
                        canonical(rid): SourceFile(
                            source=canonical(rid), sha256=hashlib.sha256(body).hexdigest()
                        )
                    },
                    reference_doi=meta[rid].get("reference") or None,
                    timestamp=updated,
                )
            ],
        )
    return records


async def sync(api, texts, meta, times, owner: dict, *, dry_run=False, ids=None) -> dict:
    from fiesta.services.legacy import record_fingerprint
    from fiesta.sources.client import SourceAPIError

    state = await api.state()
    summary = {
        "node": SLUG,
        "mode": state["mode"],
        "source_id": state["source_id"],
        "source": DATABASE_RELEASE,
    }
    if state["mode"] != "source":
        return summary | {"skipped": "node is in public mode"}
    checkpoints = state["checkpoints"]
    records = source_records(texts, meta, owner["email"], times)
    summary |= {
        "source_records": len(records),
        "unchanged": 0,
        "applied": 0,
        "planned": [],
        "bytes": 0,
    }
    errors = []
    wanted = set(ids or ())
    for rid, record in records.items():
        if wanted and rid not in wanted:
            continue
        if checkpoints.get(str(rid)) == record_fingerprint(record):
            summary["unchanged"] += 1
            continue
        if dry_run:
            summary["planned"].append(rid)
            continue
        try:
            result = await api.put_record(
                record, {f"{REVISION_KEY}/{canonical(rid)}": texts[rid].encode()}, owner
            )
        except (SourceAPIError, OSError, ValueError) as exc:
            errors.append({"id": rid, "error": str(exc)})
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
        help="the cache of legacy GERMRD pages",
    )
    parser.add_argument(
        "--fetch", action="store_true", help="only cache the legacy pages missing from STATE_DIR"
    )
    parser.add_argument("--refresh", action="store_true", help="re-read every cached legacy page")
    parser.add_argument(
        "--out", type=Path, help="write the contribution files here instead of syncing"
    )
    parser.add_argument(
        "--api",
        default=os.environ.get("FIESTA_SOURCE_API", "http://localhost:8000"),
        help="FIESTA API base URL, serving /v2 [env FIESTA_SOURCE_API]",
    )
    parser.add_argument(
        "--owner-map",
        type=Path,
        help="JSON: default_owner (email), owner_accounts ({email: {name}})",
    )
    parser.add_argument(
        "--owner-email", help="the RD steward's EarthRef account (owner of every record)"
    )
    parser.add_argument(
        "--owner-name", help="the steward's name, for an account the API must create"
    )
    parser.add_argument("--dry-run", action="store_true", help="report what would be sent")
    parser.add_argument("--ids", type=int, nargs="*", help="only these reservoir IDs")
    args = parser.parse_args()

    # A scheduled run (ops worker) passes only --state-dir: it caches what is missing.
    fetch(
        args.state_dir, refresh=args.refresh, ids=args.ids, log=lambda m: print(m, file=sys.stderr)
    )
    texts, meta, times = build(args.state_dir, args.ids)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        for rid, text in texts.items():
            (args.out / canonical(rid)).write_text(text)
        print(json.dumps({"source": DATABASE_RELEASE, "written": len(texts)}))
        return
    if args.fetch:
        print(json.dumps({"source": DATABASE_RELEASE, "cached": len(texts)}))
        return

    email = os.environ.get("FIESTA_SOURCE_EMAIL")
    password = os.environ.get("FIESTA_SOURCE_PASSWORD")
    if not email or not password:
        parser.error("set FIESTA_SOURCE_EMAIL and FIESTA_SOURCE_PASSWORD (an RD node admin)")
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
                    api, texts, meta, times, owner, dry_run=args.dry_run, ids=args.ids
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
