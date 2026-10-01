#!/usr/bin/env python3
"""Read the legacy EarthRef.org Seamount Catalog (https://earthref.org/SC/) into
SC node contributions: one per catalog region.

The catalog is a Perl CGI app over the classic er_* schema, which nothing
FIESTA can reach exposes, so this reads its public pages, the way
fiesta.services.legacy_cgi reads ERDA's:

- every seamount id: the home page's seamount menu, plus the hits of a set of
  broad searches (the menu leaves out about 240 seamounts the searches find);
- each seamount's page (`sc-s1-advanced.cgi?sc_seamount_id=<id>`): location,
  setting, morphology, contour table, maps, grids, ERDA files and references;
- the searches' result rows, which alone carry the seamount's height, multibeam
  coverage, number of summits and description.

Every page is cached under --cache, so a re-run resumes instead of refetching.
Standard library only; run it with any Python 3.11+:

    python3 scripts/sc-legacy-catalog.py --cache ../migration/sc/pages \\
        --seeds config/sc/seeds                     # the local stack's catalog
    python3 scripts/sc-legacy-catalog.py --cache ../migration/sc/pages \\
        --inventory ../migration/sc --owner STEWARD_EMAIL   # `fiesta sync-legacy`

docs/sc-node.md maps the legacy fields onto data model 1.0.
"""

import argparse
import concurrent.futures as cf
import hashlib
import html as htmllib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

HOME = "https://earthref.org/SC/"
SEARCH = "https://earthref.org/cgi-bin/sc-s1-advanced.cgi"
# The server drops requests whose User-Agent does not look like a browser.
USER_AGENT = "Mozilla/5.0 (compatible; FIESTA legacy import; +https://github.com/earthref/FIESTA)"
# Search terms shorter than five letters are refused; together these reach every
# seamount the catalog files under a plate, region, name or setting.
BROAD_SEARCHES = [
    ("plate_name", "Plate"),
    *(
        ("region_name", term)
        for term in (
            "Pacific",
            "Atlantic",
            "Trail",
            "Seamounts",
            "Ridge",
            "Islands",
            "Mountains",
            "Sea",
            "Province",
        )
    ),
    *(
        ("seamount_name", term)
        for term in ("Seamount", "Guyot", "Knoll", "Bank", "Volcano", "Unnamed")
    ),
    ("tectonic_setting", "Hotspot"),
]
SEED_SOURCE_ID = "legacy-sc"


# --------------------------------------------------------------------------- fetch


class Pages:
    """POST/GET responses cached by request, as latin-1 text (the pages' bytes)."""

    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def get(self, url: str, data: dict | None = None) -> str:
        body = urllib.parse.urlencode(data).encode() if data else None
        key = hashlib.sha1(url.encode() + b"?" + (body or b"")).hexdigest()
        path = self.root / f"{key}.html"
        if path.is_file():
            return path.read_bytes().decode("latin-1")
        for attempt in range(5):
            try:
                request = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
                raw = urllib.request.urlopen(request, timeout=600).read()
                break
            except OSError as exc:
                print(f"retrying {url} {data or ''}: {exc}", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
        else:
            raise RuntimeError(f"giving up on {url} {data or ''}")
        path.write_bytes(raw)
        return raw.decode("latin-1")

    def search(self, **fields) -> str:
        return self.get(
            SEARCH, {"database_name": "sc", "search_start": "main", "layout": "large", **fields}
        )


# --------------------------------------------------------------------------- parse


def clean(fragment: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    text = re.sub(r"<sup>(\d)</sup>", r"\1", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = htmllib.unescape(text.replace("&nbsp", " "))
    # Latin-1 decoded pages: UTF-8 "º"/"±" arrive as "Âº"/"Â±", and the catalog
    # stores most degree signs as a bare 0xBF ("¿").
    for bad, good in (("Âº", "°"), ("Â±", "±"), ("Â¿", "°"), ("¿", "°"), ("º", "°"), ("Â", "")):
        text = text.replace(bad, good)
    text = re.sub(r"[ \t\r]+", " ", text)
    return "\n".join(line.strip(" ;") for line in text.split("\n")).strip()


def field_cells(block: str) -> dict[str, str]:
    """`<b>Label</b></td><td>value</td>` pairs; "A<br>B" labels pair with "a<br>b" values."""
    out: dict[str, str] = {}
    pattern = r"<b>([^<]+(?:<br>[^<]+)?)</b>(?:<br><img[^>]*>)?</td><td[^>]*>(.*?)</td>"
    for label, value in re.findall(pattern, block, re.S | re.I):
        labels = [clean(part) for part in re.split(r"<br>", label, flags=re.I)]
        values = clean(value).split("\n")
        if len(labels) == 1:  # a multi-line value (Location: latitude, longitude)
            values = ["\n".join(values)]
        for i, name in enumerate(labels):
            out[name] = values[i].strip() if i < len(values) else ""
    return out


def section(page: str, name: str) -> str:
    match = re.search(
        rf"<div id='{name}0'.*?(?=<div id='[a-z]+0'|<div class=\"?footer|$)", page, re.S
    )
    return match.group(0) if match else ""


def file_rows(block: str) -> list[dict]:
    rows = []
    for row in re.split(r'<tr valign="?middle"?>', block)[1:]:
        title = re.search(r"<b>(.*?)(?:<img|</b>)", row, re.S)
        fid = re.search(r"file_id=(\d+)&action=(\w+)", row)
        view = re.search(r"mapWindow\('([^']+)','[^']*',(\d+),(\d+)\)", row)
        if not (title and fid):
            continue
        rows.append(
            {
                "title": clean(title.group(1)),
                "file_id": int(fid.group(1)),
                "url": view.group(1) if view else None,
                "width": int(view.group(2)) if view else None,
                "height": int(view.group(3)) if view else None,
            }
        )
    return rows


def link_rows(block: str, kind: str) -> list[dict]:
    """ERR references and ERDA files: an earthref.org/<kind>/<id>/ link and its text."""
    rows, seen = [], set()
    for row in re.split(r"<tr[^>]*>", block):
        link = re.search(rf"earthref\.org/{kind}/(\d+)/?", row)
        text = clean(row)
        if link and text and link.group(1) not in seen:
            seen.add(link.group(1))
            rows.append({"id": int(link.group(1)), "text": " ".join(text.split())})
    return rows


def contour_rows(block: str) -> tuple[list[dict], dict]:
    """The morphology table: one column of values per contour depth."""
    cells = [clean(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", block, re.S)]
    cells = [c for c in cells if c]
    names = [
        "depth",
        "azimuth",
        "area",
        "length",
        "width",
        "elongation",
        "contour_perimeter",
        "ellipse_perimeter",
        "irregularity",
    ]
    numbers = [c for c in cells if re.fullmatch(r"-?\d+(\.\d+)?", c)]
    rows = [
        dict(zip(names, numbers[i : i + 9], strict=True))
        for i in range(0, len(numbers) - len(numbers) % 9, 9)
    ]
    summary = {}
    text = " ".join(cells)
    if m := re.search(r"([\d.]+) % Multibeam Coverage", text):
        summary["multibeam_coverage"] = m.group(1)
    if m := re.search(r"([\d.]+) m High", text):
        summary["height"] = m.group(1)
    if m := re.search(r"(\d+) Summits?", text):
        summary["n_summits"] = m.group(1)
    return rows, summary


def search_records(page: str) -> dict[int, dict]:
    out = {}
    for chunk in re.split(r"<input type=checkbox name=selected_smnt_id value=", page)[1:]:
        sid = int(re.match(r"\d+", chunk).group(0))
        fields = field_cells(chunk.split("erda-c0-start.cgi")[0])
        if m := re.search(r"<b>Description</b></td></tr><tr><td[^>]*>(.*?)</td>", chunk, re.S):
            fields["Description"] = " ".join(clean(m.group(1)).split())
        out[sid] = fields
    return out


def seamount_page(page: str) -> dict | None:
    meta = re.search(
        r"sc_smnt_id=(\d+)&smnt_index=([^&]+)&smnt_name=([^&]*)&smnt_class=([^>&\s'\"]*)", page
    )
    if not meta:
        return None
    name = urllib.parse.unquote(meta.group(3), encoding="latin-1")
    contours, morphology = contour_rows(section(page, "morphology"))
    return {
        "sc_id": int(meta.group(1)),
        "index": meta.group(2),
        "name": clean(name),
        "class": clean(urllib.parse.unquote(meta.group(4))),
        "fields": field_cells(page.split("<div id='")[0]),
        "contours": contours,
        "morphology": morphology,
        "maps": file_rows(section(page, "bathymetric")),
        "grids": file_rows(section(page, "grid")),
        "files": link_rows(section(page, "erda"), "ERDA"),
        "references": link_rows(section(page, "err"), "ERR"),
    }


def harvest(pages: Pages, concurrency: int) -> list[dict]:
    home = pages.get(HOME)
    menu = re.search(r'name="?sc_seamount_id.*?</select>', home, re.S | re.I).group(0)
    ids = {int(i) for i in re.findall(r"<option value=['\"]?(\d+)", menu)}
    searched: dict[int, dict] = {}
    with cf.ThreadPoolExecutor(concurrency) as pool:
        for page in pool.map(
            lambda q: pages.search(conjunction="AND", term_type=q[0], term=q[1]), BROAD_SEARCHES
        ):
            searched.update(search_records(page))
        ids |= set(searched)
        print(f"{len(ids)} seamount ids ({len(searched)} with search rows)", file=sys.stderr)
        records = list(
            pool.map(lambda i: seamount_page(pages.search(sc_seamount_id=str(i))), sorted(ids))
        )
    out = []
    for sid, record in zip(sorted(ids), records, strict=True):
        if record is None:
            print(f"seamount {sid}: no page", file=sys.stderr)
            continue
        record["search"] = searched.get(sid, {})
        out.append(record)
    return out


# --------------------------------------------------------------------------- rows


def number(text: str | None) -> str:
    m = re.search(r"-?\d+(?:\.\d+)?", text or "")
    return m.group(0) if m else ""


def plus_minus(text: str | None) -> tuple[str, str]:
    m = re.match(r"\s*(-?[\d.]+)\s*±\s*([\d.]+)", text or "")
    return (m.group(1), m.group(2)) if m else (number(text), "")


def coordinate(text: str) -> float | None:
    m = re.match(r"\s*(\d+)°\s*([\d.]+)'\s*([NSEW])", text)
    if not m:
        return None
    value = int(m.group(1)) + float(m.group(2)) / 60
    return round(-value if m.group(3) in "SW" else value, 5)


SIZE_CLASSES = ("Very Small", "Small", "Intermediate", "Large", "Very Large")


def classification(text: str, seamount_type: str) -> tuple[str, str, str]:
    """ "Intermediate A3 Guyot" -> (size class, shape class, type)."""
    rest = text.removesuffix(seamount_type).strip() if seamount_type else text
    size = next((s for s in sorted(SIZE_CLASSES, key=len, reverse=True) if rest.startswith(s)), "")
    shape = rest.removeprefix(size).strip()
    return size, shape, seamount_type or text.split(" ")[-1]


def cell(value) -> str:
    return "" if value is None else " ".join(str(value).split())


def map_name_parts(url: str | None) -> tuple[str, str]:
    """`.../REGION-430S-1620W.std.480m.mb.map.jpg` -> (file name, grid spacing)."""
    if not url:
        return "", ""
    name = url.rsplit("/", 1)[-1]
    spacing = re.search(r"\.(\d+)m\.", name)
    return name, spacing.group(1) if spacing else ""


DATA_TYPES = {
    "predicted satellite bathymetry": "Predicted satellite bathymetry",
    "multibeam data merged with predicted satellite bathymetry": (
        "Multibeam merged with predicted satellite bathymetry"
    ),
    "multibeam bathymetry": "Multibeam bathymetry",
    "residual bathymetry": "Residual bathymetry",
}


# The legacy records spell one setting four ways.
SETTING_TYPOS = {
    "Hotspot Trails": "Hotspot Trail",
    "Hotpot Trails": "Hotspot Trail",
    "Hotpost Trails": "Hotspot Trail",
}


def data_type(title: str) -> str:
    tail = title.rsplit(" -- ", 1)[-1].strip().lower()
    return DATA_TYPES.get(tail, title.rsplit(" -- ", 1)[-1].strip())


def display_name(rec: dict) -> str:
    """The legacy catalog's title for a seamount: its name and type ("Arorae Guyot")."""
    name, kind = rec["name"], rec["class"]
    return name if not kind or name.endswith(kind) else f"{name} {kind}"


def region_tables(seamounts: list[dict]) -> dict[str, list[dict]]:
    tables: dict[str, list[dict]] = defaultdict(list)
    # A legacy file id is one bathymetry product, listed under "Bathymetric
    # Maps" when it has a map image and under "Grid Files" when it has a grid.
    maps: dict[int, dict] = {}
    files: dict[int, dict] = {}
    refs: dict[int, dict] = {}
    by_title = {display_name(rec): rec["index"] for rec in seamounts}
    for rec in seamounts:
        f, s, m = rec["fields"], rec["search"], rec["morphology"]
        size, shape, kind = classification(
            f.get("Classification") or s.get("Classification", ""), rec["class"]
        )
        location = (f.get("Location") or s.get("Location", "")).split("\n")
        plate_age = re.findall(r"[\d.]+", f.get("Plate Age") or s.get("Plate Age", ""))
        elongation = plus_minus(f.get("Elongation") or s.get("Elongation"))
        irregularity = plus_minus(f.get("Irregularity") or s.get("Irregularity"))
        alternative = [
            a.strip() for a in (f.get("Alternative Names") or "").split(",") if a.strip()
        ]
        tables["seamounts"].append(
            {
                "seamount": rec["index"],
                "seamount_name": display_name(rec),
                "alternative_names": ":".join(a.replace(":", " ") for a in alternative),
                "seamount_type": kind,
                "size_class": size,
                "shape_class": shape,
                "lat": coordinate(location[0]) if location else None,
                "lon": coordinate(location[1]) if len(location) > 1 else None,
                "region": f.get("Region", ""),
                "plate": f.get("Plate", ""),
                "tectonic_setting": SETTING_TYPOS.get(
                    setting := f.get("Tectonic Setting") or s.get("Tectonic Setting", ""), setting
                ),
                "oceanic_province": f.get("Oceanic Province") or s.get("Oceanic Province", ""),
                "volcanic_activity": f.get("Volcanic Activity") or s.get("Volcanic Activity", ""),
                "plate_age_min": plate_age[0] if plate_age else "",
                "plate_age_max": plate_age[-1] if plate_age else "",
                "age": number(f.get("Age") or s.get("Age")),
                "height": number(s.get("Height")) or m.get("height", ""),
                "summit_depth": number(f.get("Seamount Top") or s.get("Seamount Top")),
                "base_depth": number(f.get("Ocean Bottom") or s.get("Ocean Bottom")),
                "shelf_edge_depth": number(f.get("Shelf Edge") or s.get("Shelf Edge")),
                "volume": number(f.get("Volume") or s.get("Volume")),
                "elongation": elongation[0],
                "elongation_sigma": elongation[1],
                "irregularity": irregularity[0],
                "irregularity_sigma": irregularity[1],
                "n_summits": number(s.get("Number of Summits")) or m.get("n_summits", ""),
                "multibeam_coverage": number(s.get("Multibeam Coverage"))
                or m.get("multibeam_coverage", ""),
                "description": s.get("Description", ""),
                "sc_id": rec["sc_id"],
            }
        )
        for contour in rec["contours"]:
            tables["contours"].append({"seamount": rec["index"], **contour})
        for product, rows in (("Map", rec["maps"]), ("Grid", rec["grids"])):
            for row in rows:
                entry = maps.setdefault(
                    row["file_id"], {"title": row["title"], "seamounts": [], "products": []}
                )
                entry["seamounts"].append(rec["index"])
                if product not in entry["products"]:
                    entry["products"].append(product)
                if row["url"]:
                    entry |= {"url": row["url"], "width": row["width"], "height": row["height"]}
        for row in rec["files"]:
            files.setdefault(row["id"], {**row, "seamounts": []})["seamounts"].append(rec["index"])
        for row in rec["references"]:
            refs.setdefault(row["id"], {**row, "seamounts": []})["seamounts"].append(rec["index"])
    titles = defaultdict(int)
    for entry in maps.values():
        titles[entry["title"]] += 1
    for fid, entry in sorted(maps.items()):
        own = by_title.get(entry["title"].split(" -- ")[0], "")
        file_name, spacing = map_name_parts(entry.get("url"))
        tables["maps"].append(
            {
                # Titles repeat across file groups now and then; the file id keeps the key unique.
                "map": entry["title"]
                if titles[entry["title"]] == 1
                else f"{entry['title']} ({fid})",
                "seamount": own,
                "seamounts": ":".join(sorted(set(entry["seamounts"]))),
                "scale": "Seamount" if own else "Regional",
                "data_type": data_type(entry["title"]),
                "products": ":".join(entry["products"]),
                "file_name": file_name,
                "grid_spacing": spacing,
                "image_width": entry.get("width"),
                "image_height": entry.get("height"),
                "sc_file_id": fid,
            }
        )
    for erda_id, entry in sorted(files.items()):
        tables["files"].append(
            {
                "file": entry["text"],
                "seamounts": ":".join(sorted(set(entry["seamounts"]))),
                "erda_id": erda_id,
                "url": f"https://earthref.org/ERDA/{erda_id}/",
            }
        )
    for err_id, entry in sorted(refs.items()):
        tables["references"].append(
            {
                "reference": str(err_id),
                "seamounts": ":".join(sorted(set(entry["seamounts"]))),
                "citation": entry["text"],
                "url": f"https://earthref.org/ERR/{err_id}/",
            }
        )
    return tables


# --------------------------------------------------------------------------- write

TABLES = ("contribution", "seamounts", "contours", "maps", "files", "references")


def export(tables: dict[str, list[dict]]) -> str:
    """FIESTA's tab-delimited contribution text (fiesta.domain.parse)."""
    blocks = []
    for table in TABLES:
        rows = tables.get(table) or []
        if not rows:
            continue
        columns = [
            c
            for c in dict.fromkeys(k for row in rows for k in row)
            if any(cell(r.get(c)) for r in rows)
        ]
        lines = [f"tab delimited\t{table}", "\t".join(columns)]
        lines += ["\t".join(cell(row.get(c)) for c in columns) for row in rows]
        blocks.append("\n".join(lines))
    return "\n>>>>>>>>>>\n".join(blocks) + "\n"


# More than half the catalog has no region (and mostly no plate); those
# seamounts make one contribution of their own rather than an invented grouping.
NO_REGION = "Seamounts outside the catalog's regions"


def region_of(rec: dict) -> str:
    return rec["fields"].get("Region") or NO_REGION


def slug(text: str) -> str:
    return "no-region" if text == NO_REGION else re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def contributions(catalog: list[dict]) -> list[tuple[str, str]]:
    """(region, contribution text) for every region, largest first."""
    by_region: dict[str, list[dict]] = defaultdict(list)
    for rec in catalog:
        by_region[region_of(rec)].append(rec)
    out = []
    for region, seamounts in sorted(by_region.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        seamounts.sort(key=lambda r: r["index"])
        tables = region_tables(seamounts)
        tables["contribution"] = [
            {
                "data_model_version": "1.0",
                "description": f"Seamount Catalog: {region} ({len(seamounts)} seamounts), "
                "from the legacy EarthRef.org Seamount Catalog",
                "supplemental_links": json.dumps({"Legacy Seamount Catalog": HOME}),
            }
        ]
        out.append((region, export(tables)))
    return out


SEED_HEADER = """\
# Local SC fixtures (never production credentials or data paths).
# The contract entries (public, draft, invalid, public-v2, typical-*, all-fields)
# are hand-written; the `catalog-*` entries are the legacy catalog itself, one
# published contribution per region, written by scripts/sc-legacy-catalog.py
# --seeds (do not edit them by hand; re-run the script).
"""


def write_seeds(seeds: Path, regions: list[tuple[str, str]]) -> None:
    import_dir = seeds / "catalog"
    import_dir.mkdir(parents=True, exist_ok=True)
    for old in import_dir.glob("*.txt"):
        old.unlink()
    manifest = seeds / "manifest.yaml"
    head = (
        manifest.read_text().split("# ---- catalog")[0].rstrip() + "\n"
        if manifest.is_file()
        else SEED_HEADER
    )
    lines = [head, "# ---- catalog (generated by scripts/sc-legacy-catalog.py --seeds)"]
    for region, text in regions:
        name = f"catalog/{slug(region)}.txt"
        (seeds / name).write_text(text)
        lines += [
            f"- key: catalog-{slug(region)}",
            "  owner: owner",
            "  published: true",
            "  revisions:",
            "  - canonical: contribution.txt",
            "    files:",
            f"      contribution.txt: {name}",
        ]
    manifest.write_text("\n".join(lines) + "\n")


def write_inventory(
    out: Path, owner: str, regions: list[tuple[str, str]], harvested_at: datetime
) -> None:
    records = []
    for cid, (region, text) in enumerate(regions, start=1):
        canonical = f"sc_contribution_{cid}.txt"
        path = out / "records" / str(cid) / canonical
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        when = harvested_at.isoformat()
        records.append(
            {
                "id": cid,
                "owner_email": owner,
                "published": True,
                "created_at": when,
                "activated_at": when,
                "revisions": [
                    {
                        "key": f"{SEED_SOURCE_ID}-{slug(region)}",
                        "canonical": canonical,
                        "timestamp": when,
                        "files": {
                            canonical: {
                                "source": str(path.relative_to(out)),
                                "sha256": hashlib.sha256(text.encode()).hexdigest(),
                            }
                        },
                    }
                ],
            }
        )
    inventory = {"format": 1, "node": "sc", "source_id": SEED_SOURCE_ID, "records": records}
    (out / "inventory.json").write_text(json.dumps(inventory, indent=1) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--cache", type=Path, required=True, help="page cache directory (resumable)"
    )
    parser.add_argument("--concurrency", type=int, default=4, help="parallel requests (be polite)")
    parser.add_argument("--catalog", type=Path, help="also write the parsed catalog as JSON here")
    parser.add_argument(
        "--seeds", type=Path, help="config/sc/seeds: write catalog/*.txt and the manifest entries"
    )
    parser.add_argument(
        "--inventory", type=Path, help="write records/ and inventory.json for `fiesta sync-legacy`"
    )
    parser.add_argument(
        "--owner", help="--inventory: the steward account's email (never checked in)"
    )
    args = parser.parse_args()
    if args.inventory and not args.owner:
        parser.error("--inventory needs --owner")

    pages = Pages(args.cache)
    catalog = harvest(pages, args.concurrency)
    regions = contributions(catalog)
    print(f"{len(catalog)} seamounts in {len(regions)} regions", file=sys.stderr)
    if args.catalog:
        args.catalog.write_text(json.dumps(catalog, indent=1, ensure_ascii=False))
    if args.seeds:
        write_seeds(args.seeds, regions)
    if args.inventory:
        home = args.cache / f"{hashlib.sha1(HOME.encode() + b'?').hexdigest()}.html"
        write_inventory(
            args.inventory, args.owner, regions, datetime.fromtimestamp(home.stat().st_mtime, UTC)
        )


if __name__ == "__main__":
    main()
