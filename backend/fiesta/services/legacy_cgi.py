"""Snapshot a legacy EarthRef.org Perl CGI archive into an explicit import inventory.

The CGI apps (ERDA) sit on the classic `er_*` schema, which nothing FIESTA can
reach exposes, so this reader works from the public pages: each record lives at
`<base_url>/<id>/` ("Detailed File Information") and its files download one by
one through the `z-download.cgi` links in the page's download menu. Ids are
sparse, so every id in `1..max_id` is probed once.

Everything is cached under the output directory, so a re-run resumes instead of
refetching: `pages/<id>.html` (live records) and `pages/index.json` (which ids
were probed, live or not, and when), `files/<id>/<name>` (downloaded bytes).
The run writes `records/<id>/<canonical>` (the record as a contribution text
file), `inventory.json` (the `fiesta sync-legacy` contract, local `source`
paths), `owners.json` (the accounts `ensure-owners` needs) and
`owner_mapping.json` (every contributor display name, the account it matched
by exact full name, and the records that depend on `default_owner`).

The pages carry no dates, so `created_at` / `activated_at` are the time the page
was first seen live (kept in `pages/index.json`, stable across re-runs).
"""

import asyncio
import contextlib
import hashlib
import html as htmllib
import json
import mimetypes
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

from fiesta.domain.parse import ParsedContribution, export_text
from fiesta.services.legacy import Inventory
from fiesta.services.revisions import digest

_LIVE_MARKER = "Detailed File Information"
_USER_AGENT = "FIESTA legacy import (+https://github.com/earthref/FIESTA)"


# --------------------------------------------------------------------------- pages


class PageCache:
    """`pages/index.json`: id -> {"live": bool, "seen": iso timestamp}."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = root / "index.json"
        self.entries: dict[str, dict] = {}
        if self.path.is_file():
            with contextlib.suppress(ValueError):
                self.entries = json.loads(self.path.read_text())

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.entries, indent=0, sort_keys=True))
        tmp.replace(self.path)

    def page(self, cid: int) -> str | None:
        entry = self.entries.get(str(cid))
        if not entry or not entry["live"]:
            return None
        return (self.root / f"{cid}.html").read_text(encoding="utf-8")


async def fetch_pages(http, base_url: str, max_id: int, cache: PageCache, concurrency: int):
    """Probe every id not yet in the cache; a transient failure is retried next run."""
    semaphore = asyncio.Semaphore(concurrency)
    failures: list[dict] = []
    done = 0

    async def probe(cid: int):
        nonlocal done
        async with semaphore:
            try:
                resp = await http.get(f"{base_url.rstrip('/')}/{cid}/")
                resp.raise_for_status()
            except Exception as exc:  # network trouble: leave the id unprobed
                failures.append({"id": cid, "error": f"page: {exc!r}"[:300]})
                return
        live = _LIVE_MARKER in resp.text
        if live:
            (cache.root / f"{cid}.html").write_text(resp.text, encoding="utf-8")
        cache.entries[str(cid)] = {"live": live, "seen": datetime.now(UTC).isoformat()}
        done += 1
        if done % 200 == 0:
            cache.save()
            print(f"pages: {done} probed", file=sys.stderr, flush=True)

    todo = [i for i in range(1, max_id + 1) if str(i) not in cache.entries]
    await asyncio.gather(*(probe(i) for i in todo))
    cache.save()
    return failures


# --------------------------------------------------------------------------- parse

_SPAN_FIELD = re.compile(r"padding-right:15px;'>([^<]+)</span></td>\s*<td[^>]*>(.*?)</td>", re.S)
_BOLD_FIELD = re.compile(r"<b>([^<]{1,120})</b><br>(.*?)</td>", re.S)
_POPUP_FILE = re.compile(r'<a href=\\"(z-download\.cgi\?[^"\\]*)\\">([^<]*?)\s*\[([^\]]*)\]</a>')
_CONTRIBUTOR = re.compile(r"<a href=['\"]?erml\.cgi\?n=(\d+)['\"]?>([^<]*)</a>")
_SIZE = re.compile(r"([\d.]+)\s*(bytes|B|KB|MB|GB|TB)\b", re.I)
_UNITS = {"b": 1, "bytes": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3, "tb": 1024**4}


_MOJIBAKE = re.compile("[Â-ô][\u0080-¿]")


def _demojibake(text: str) -> str:
    """Undo UTF-8 that was stored as Latin-1 (`â\\x80\\x9c` for a curly quote)."""
    if not _MOJIBAKE.search(text):
        return text
    try:
        return text.encode("latin-1").decode("utf-8")
    except UnicodeError:
        return text


def _text(fragment: str) -> str:
    """Visible text of an HTML fragment; <br> become newlines, runs of spaces collapse."""
    fragment = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    lines = [
        re.sub(r"\s+", " ", _demojibake(htmllib.unescape(line))).strip()
        for line in fragment.split("\n")
    ]
    return "\n".join(line for line in lines if line)


def _size_bytes(text: str) -> int | None:
    m = _SIZE.search(text or "")
    return round(float(m.group(1)) * _UNITS[m.group(2).lower()]) if m else None


def parse_record(page: str, cid: int) -> dict:
    """The legacy fields of one "Detailed File Information" page, as shown.

    Returns {"id", "title", "fields": {label: text}, "links": {label: [href]},
    "contributor": {"name", "legacy_id"} | None, "education_topics": [...],
    "project": {"group", "name"} | None, "location": raw location HTML | None,
    "files": [{"name", "path", "href", "size_text", "size_estimate"}]}.
    """
    start = page.find(_LIVE_MARKER)
    if start < 0:
        raise ValueError(f"{cid}: not a record page")
    body = page[start:]
    title = re.search(rf'href="[^"]*/{cid}/">(.*?)</a>', body, re.S)
    record: dict = {
        "id": cid,
        "title": _text(title.group(1)) if title else "",
        "fields": {},
        "links": {},
        "contributor": None,
        "education_topics": [],
        "project": None,
        "location": None,
        "files": [],
    }
    for label, value in [*_SPAN_FIELD.findall(body), *_BOLD_FIELD.findall(body)]:
        label = htmllib.unescape(label).strip()
        if label.startswith("Project -- "):
            parts = [p.strip() for p in label.split(" -- ")[1:]]
            if len(parts) == 2:
                record["project"] = {"group": parts[0], "name": parts[1]}
            continue
        if label == "Contributor":
            m = _CONTRIBUTOR.search(value)
            record["contributor"] = {
                "name": _text(m.group(2) if m else value),
                "legacy_id": int(m.group(1)) if m else None,
            }
            continue
        if label == "Resource Matrix":
            anchors = re.findall(r"<a[^>]*>(.*?)</a>", value, re.S)
            record["education_topics"] = [t for t in map(_text, anchors) if t]
            continue
        if label == "Location":
            record["location"] = value
        hrefs = re.findall(r"<a href=['\"]?([^'\" >]+)", value)
        if hrefs:
            record["links"][label] = [htmllib.unescape(h) for h in hrefs]
        record["fields"].setdefault(label, _text(value))
    seen = set()
    for href, name, size in _POPUP_FILE.findall(body):
        query = parse_qs(urlsplit(href).query)
        paths = query.get("file_path", [])
        if "file_name" in query or len(paths) != 1:
            continue  # the "Zipped Archive" entry bundles the files listed on their own
        name = htmllib.unescape(name).strip() or paths[0].rsplit("/", 1)[-1]
        if paths[0] in seen:
            continue
        seen.add(paths[0])
        record["files"].append(
            {
                "name": name,
                "path": paths[0],
                "href": href,
                "size_text": size.strip(),
                "size_estimate": _size_bytes(size),
            }
        )
    # A single-file record has no download menu: its direct download link redirects
    # to the file, whose archive path is resolved at download time.
    direct = record["links"].get("Direct Download Link")
    single = record["fields"].get("File Name", "")
    if not record["files"] and direct and single and single != "Not available":
        record["files"].append(
            {
                "name": record["fields"]["File Name"],
                "path": None,
                "href": direct[0],
                "size_text": record["fields"].get("File Size", ""),
                "size_estimate": _size_bytes(record["fields"].get("File Size", "")),
            }
        )
    return record


# --------------------------------------------------------------------------- tables

# Legacy label -> objects column, for fields copied as one value / a comma list.
_TEXT_COLUMNS = {
    "Description": "description",
    "Instructions": "instructions",
    "Copyright Description": "copyright_description",
}
_LIST_COLUMNS = {
    "Keywords": "keywords",
    "Parameters": "parameters",
    "Materials": "materials",
    "Samples": "samples",
    "Techniques": "techniques",
}
_URL_COLUMNS = {
    "Source Web Site": "source_url",
    "Project Web Site": "project_url",
    "Copyright Web Site": "copyright_url",
}
# Location terms are routed to the first column whose vocabulary knows them.
_PLACE_COLUMNS = ["continents_oceans", "oceans_seas", "countries", "state_provinces", "regions"]
_TIMESCALE_COLUMNS = [
    "timescale_eon",
    "timescale_era",
    "timescale_period",
    "timescale_epoch",
    "timescale_stage",
]
_DMS = r"(\d+(?:\.\d+)?)º\s*(?:(\d+(?:\.\d+)?)')?\s*([NSEW])"
_RANGE = re.compile(rf"^{_DMS}(?:\s*-\s*{_DMS})?")
_AGE = re.compile(r"^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*([A-Za-z][\w ()/+-]*?)?$")
_MEDIA_TYPES = mimetypes.MimeTypes()  # Python's built-in table only: same on every machine
_VERSION = re.compile(r"^(?:v?\d[\w.]*|CS\d*|X|XP|MX)$", re.I)


class Vocabularies:
    """Case-insensitive lookup of the objects columns' cv()/sv() vocabularies."""

    def __init__(self, node, model: dict):
        cvs = node.load_controlled_vocabularies()
        svs = node.load_suggested_vocabularies()
        self.columns: dict[str, dict[str, str]] = {}
        for column, spec in model["tables"]["objects"]["columns"].items():
            for validation in spec.get("validations", []):
                m = re.match(r'^(cv|sv)\("([^"]+)"\)$', validation)
                if not m:
                    continue
                vocab = (cvs if m.group(1) == "cv" else svs).get(m.group(2)) or {}
                self.columns[column] = {
                    str(i["item"]).lower(): str(i["item"]) for i in vocab.get("items", [])
                }

    def match(self, column: str, value: str) -> str | None:
        return self.columns.get(column, {}).get(value.strip().lower())


def _degrees(deg: str, minutes: str | None, hemi: str) -> float:
    value = float(deg) + (float(minutes) / 60 if minutes else 0.0)
    return round(-value if hemi in "SW" else value, 5)


def _coordinates(text: str) -> tuple[list[float], str]:
    """Leading `DMS [- DMS]` of a location string, as decimals, and the rest."""
    m = _RANGE.match(text.strip())
    if not m:
        return [], text
    values = [_degrees(*m.groups()[:3])]
    if m.group(4):
        values.append(_degrees(*m.groups()[3:]))
    return values, text.strip()[m.end() :]


def _list_item(value: str) -> str:
    """One List cell item: the text format splits lists on ':', so a colon inside an
    item (a subtitle, a URL scheme) becomes ' -' / '-'."""
    return value.replace(": ", " - ").replace(":", "-").strip()


def _cell(value: str) -> str:
    """One cell: the text format has no quoting, so tabs and newlines become spaces."""
    return re.sub(r"\s+", " ", value).strip()


def _split(value: str) -> list[str]:
    return [item for item in (_list_item(v) for v in value.split(",")) if item]


def record_rows(record: dict, vocab: Vocabularies, notes: dict) -> dict:
    """The legacy fields of one record as a single `objects` row (the object's key is
    set by the caller). Legacy values the model has no slot for are kept in
    `keywords` and counted in `notes`."""
    fields = record["fields"]
    row: dict[str, str] = {"title": _cell(record["title"])}
    lists: dict[str, list[str]] = {}

    def add(column: str, *values: str):
        bucket = lists.setdefault(column, [])
        for v in values:
            if v and v not in bucket:
                bucket.append(v)

    def note(kind: str, value: str):
        notes.setdefault(kind, {}).setdefault(value, []).append(record["id"])

    for term in _split(fields.get("Data Type", "")):
        add("data_types", vocab.match("data_types", term) or term)
    if level := fields.get("Expert Level"):
        row["expert_level"] = vocab.match("expert_level", level) or level
    program = _cell(fields.get("Computer Program", ""))
    if program.lower() not in {"", "not specified", "none", "n/a"}:
        head, _, tail = program.rpartition(" ")
        if head and _VERSION.match(tail):
            row["computer_program"], row["computer_program_version"] = head, tail
        else:
            row["computer_program"] = program
    for label, column in _TEXT_COLUMNS.items():
        if value := _cell(fields.get(label, "")):
            row[column] = value
    for label, column in _LIST_COLUMNS.items():
        add(column, *_split(fields.get(label, "")))
    for label, column in _URL_COLUMNS.items():
        if record["links"].get(label):
            row[column] = _cell(record["links"][label][0])
        elif value := _cell(fields.get(label, "")):
            row[column] = value
    # Source: a reference (one line) and/or the source web site (a bare URL line).
    for line in fields.get("Source", "").split("\n"):
        line = _cell(line)
        if not line or line.lower() == "no source":
            continue
        if re.fullmatch(r"https?://\S+", line):
            row.setdefault("source_url", line)
        else:
            add("citations", _list_item(line))
    # A record without files archives a link (the `web link` data type).
    if not record["files"] and row.get("source_url"):
        row["external_url"] = row["source_url"]
    if owner := fields.get("Copyright Owner"):
        row["copyright_owner"] = "; ".join(_cell(line) for line in owner.split("\n"))
    for topic in record["education_topics"]:
        add("education_topics", _list_item(vocab.match("education_topics", topic) or topic))
    if project := record["project"]:
        row["project"] = vocab.match("project", project["name"]) or project["name"]
        row["project_group"] = vocab.match("project_group", project["group"]) or project["group"]

    if raw := record["location"]:
        text = _text(re.sub(r"<img[^>]*sq\.gif[^>]*>", " | ", raw))
        text = text.replace("\n", ", ")
        if " | " in text:
            lat_text, rest = text.split(" | ", 1)
            lats, _ = _coordinates(lat_text)
            lons, rest = _coordinates(rest)
            if len(lats) == 2 and lats[0] != lats[1]:
                row["lat_s"], row["lat_n"] = str(min(lats)), str(max(lats))
            elif lats:
                row["lat"] = str(lats[0])
            if len(lons) == 2 and lons[0] != lons[1]:
                row["lon_w"], row["lon_e"] = str(lons[0]), str(lons[1])
            elif lons:
                row["lon"] = str(lons[0])
            text = rest
        for term in _split(text):
            for column in _PLACE_COLUMNS:
                if hit := vocab.match(column, term):
                    add(column, hit)
                    break
            else:
                add("locations", term)

    if age := _cell(fields.get("Geological Age Range and Timescale", "")):
        parts = [p.strip() for p in age.split(",") if p.strip()]
        m = _AGE.match(parts[0]) if parts else None
        if m:
            parts.pop(0)
            ages = [float(v) for v in m.groups()[:2] if v is not None]
            row["age_high"], row["age_low"] = f"{max(ages):g}", f"{min(ages):g}"
            if m.group(3):
                unit = vocab.match("age_unit", m.group(3).strip())
                if unit:
                    row["age_unit"] = unit
                else:
                    note("age_unit_unknown", m.group(3).strip())
        for name in parts:
            for column in _TIMESCALE_COLUMNS:
                if hit := vocab.match(column, name):
                    row.setdefault(column, hit)
                    break
            else:
                add("keywords", _list_item(name))
                note("timescale_name_not_in_vocabulary", name)

    for column, values in lists.items():
        if values:
            row[column] = ":".join(values)
    return row


def contribution_text(record: dict, files: list[dict], model: dict, vocab, notes) -> str:
    """The record as a data-model contribution text file: one `objects` row, one
    `files` row per downloaded file (with its real size)."""
    key = str(record["id"])  # one object per legacy record, named by its legacy id
    obj = {"object": key, **record_rows(record, vocab, notes)}
    rows = []
    for f in files:
        suffix = Path(f["name"]).suffix.lower().lstrip(".")
        row = {"file": _cell(f["name"]), "object": key}
        if suffix:
            row["format"] = suffix
        media_type = _MEDIA_TYPES.guess_type(f["name"])[0]
        if media_type:
            row["media_type"] = media_type
        if f.get("size") is not None:
            row["size_bytes"] = str(f["size"])
        rows.append(row)
    contribution = {"data_model_version": model["data_model_version"], "description": obj["title"]}
    parsed = ParsedContribution(
        tables={"contribution": [contribution], "objects": [obj], "files": rows}
    )
    return export_text(parsed, model)


# --------------------------------------------------------------------------- files


def attachment_name(name: str) -> str:
    """A plain file name (what `save_revision` accepts) for a legacy file name."""
    name = re.sub(r"[\x00-\x1f/\\]", "_", name).strip()
    return name if name not in {"", ".", ".."} else "file"


class FileCache:
    """`files/index.json`: "<id>/<name>" -> {"path", "size", "sha256"} of a finished download."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = root / "index.json"
        self.entries: dict[str, dict] = {}
        if self.path.is_file():
            with contextlib.suppress(ValueError):
                self.entries = json.loads(self.path.read_text())

    def get(self, key: str) -> dict | None:
        entry = self.entries.get(key)
        if (
            entry
            and not entry.get("missing")
            and (self.root / key).is_file()
            and (self.root / key).stat().st_size == entry["size"]
        ):
            return entry
        return None

    def missing(self, key: str) -> bool:
        return bool((self.entries.get(key) or {}).get("missing"))

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.entries, indent=0, sort_keys=True))
        tmp.replace(self.path)


async def download_file(http, page_url: str, entry: dict, dest: Path, max_bytes: int) -> dict:
    """Stream one legacy file to `dest`, hashing as it goes."""
    url = urljoin(page_url, entry["href"])
    path = entry["path"]
    if path is None:  # direct download link: a redirect names the archived file
        resp = await http.get(url, follow_redirects=False)
        location = resp.headers.get("location")
        if not resp.is_redirect or not location:
            raise ValueError(f"download link answered {resp.status_code}, not a redirect")
        url = urljoin(url, location)
        path = (parse_qs(urlsplit(url).query).get("file_path") or [None])[0]
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    sha, size, head = hashlib.sha256(), 0, b""
    async with http.stream("GET", url, follow_redirects=True) as resp:
        resp.raise_for_status()
        is_html = resp.headers.get("content-type", "").startswith("text/html")
        with tmp.open("wb") as out:
            async for chunk in resp.aiter_bytes(1 << 20):
                size += len(chunk)
                if max_bytes and size > max_bytes:
                    raise ValueError(f"{entry['name']} is over max_file_bytes ({max_bytes})")
                if len(head) < 65536:
                    head += chunk[:65536]
                sha.update(chunk)
                out.write(chunk)
    if is_html and (b"Missing file" in head or b"Error Message" in head):
        tmp.unlink(missing_ok=True)
        if b"Missing file" in head:
            raise MissingFile(f"{entry['name']}: missing from the legacy archive")
        raise ValueError(f"{entry['name']}: the archive answered with an error page")
    tmp.replace(dest)
    return {"path": path, "size": size, "sha256": sha.hexdigest()}


class MissingFile(ValueError):
    """The legacy archive lists the file but no longer has it (permanent)."""


# --------------------------------------------------------------------------- owners


def _full_name(user: dict) -> str:
    name = user.get("name") or {}
    full = " ".join(p for p in (name.get("given"), name.get("family")) if p)
    return re.sub(r"\s+", " ", full or name.get("published") or "").strip()


async def owner_mapping(client, cfg, names: dict[str, dict]) -> dict:
    """Map each contributor display name to an er_users account by exact full name.

    `names`: display name -> {"legacy_ids": {...}, "records": [...]}. The operator's
    `owner_names` wins over the match; a name held by several accounts, or by none,
    is unmatched (case-insensitive near misses are listed as candidates only). An
    unmatched name also lists the accounts at its legacy person ids (the page's
    `erml.cgi?n=` link), as a hint for the reviewer; they are never applied.
    """
    from fiesta.services.legacy_inventory import _account_fields, _scroll

    by_name: dict[str, list[dict]] = {}
    by_email: dict[str, dict] = {}
    by_id: dict[int, dict] = {}
    body = {"query": {"match_all": {}}, "_source": ["id", "email", "handle", "name", "orcid"]}
    async for user in _scroll(client, cfg.users_index, body):
        account = _account_fields(user, "")
        if account is None:
            continue
        account["er_users_id"] = user.get("id")
        by_email.setdefault(account["email"], account)
        by_name.setdefault(_full_name(user), []).append(account)
        with contextlib.suppress(TypeError, ValueError):
            by_id[int(user.get("id"))] = account
    lowered: dict[str, list[dict]] = {}
    for name, accounts in by_name.items():
        lowered.setdefault(name.lower(), []).extend(accounts)

    matched, unmatched = {}, {}
    for name, info in sorted(names.items()):
        legacy_ids = sorted(i for i in info["legacy_ids"] if i is not None)
        entry = {"records": sorted(info["records"]), "legacy_person_ids": legacy_ids}
        if name in cfg.owner_names:
            account = by_email.get(cfg.owner_names[name].lower())
            if account:
                matched[name] = entry | {"via": "owner_names", "account": account}
                continue
            entry["note"] = f"owner_names email {cfg.owner_names[name]!r} is not in er_users"
        exact = by_name.get(name, []) if name else []
        # Several er_users documents with one email are one account (legacy duplicates).
        if len({a["email"] for a in exact}) == 1 and "note" not in entry:
            account = next((a for a in exact if a["er_users_id"] in legacy_ids), exact[0])
            entry["id_agrees"] = account["er_users_id"] in legacy_ids
            if len(exact) > 1:
                entry["duplicate_documents"] = len(exact)
            matched[name] = entry | {"via": "exact_name", "account": account}
            continue
        candidates = exact if len(exact) > 1 else lowered.get(name.lower(), []) if name else []
        entry["candidates"] = [
            {k: a[k] for k in ("email", "name", "er_users_id")} for a in candidates
        ]
        entry["legacy_id_accounts"] = [
            {k: by_id[i][k] for k in ("email", "name", "er_users_id")}
            for i in legacy_ids
            if i in by_id
        ]
        unmatched[name] = entry
    return {
        "matched": matched,
        "unmatched": unmatched,
        "default_owner": cfg.default_owner,
        "default_owner_resolves": bool(cfg.default_owner and cfg.default_owner.lower() in by_email),
        "default_owner_account": by_email.get((cfg.default_owner or "").lower()),
    }


# --------------------------------------------------------------------------- inventory


async def build_inventory(
    node,
    out_dir: Path,
    *,
    client=None,
    http=None,
    download: bool = True,
    max_total_bytes: int = 20 * 1000**3,
    max_file_bytes: int | None = None,
) -> dict:
    """Crawl, map owners, download files and write the inventory.

    Nothing is downloaded when `download` is off or the pending downloads are
    estimated (from the sizes the pages list) at over `max_total_bytes`; files
    listed at over `max_file_bytes` are deferred. A record whose files are not all
    on disk stays out of the inventory: `deferred` (not downloaded yet) or
    `legacy_missing` (the legacy archive no longer has a file it lists)."""
    cfg = node.legacy
    if cfg is None or cfg.kind != "earthref-cgi":
        raise ValueError(f"{node.node.slug}: legacy.kind is not earthref-cgi")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model = node.load_data_model(node.data_model.latest)
    vocab = Vocabularies(node, model)
    own_http = http is None
    if own_http:
        import httpx

        http = httpx.AsyncClient(
            timeout=httpx.Timeout(120, read=600),
            follow_redirects=True,
            headers={"User-Agent": _USER_AGENT},
        )
    if client is None:
        from fiesta.search.client import get_opensearch

        client = get_opensearch()
    report: dict = {
        "node": node.node.slug,
        "source": cfg.base_url,
        "probed": 0,
        "records": 0,
        "files": 0,
        "estimated_bytes": 0,
        "downloaded_bytes": 0,
        "inventory_records": 0,
        "default_owner_records": [],
        "errors": [],
    }
    try:
        pages = PageCache(out_dir / "pages")
        report["errors"] += await fetch_pages(
            http, cfg.base_url, cfg.max_id, pages, cfg.concurrency
        )
        report["probed"] = len(pages.entries)
        records = {}
        for key in sorted(pages.entries, key=int):
            if page := pages.page(int(key)):
                try:
                    records[int(key)] = parse_record(page, int(key))
                except ValueError as exc:
                    report["errors"].append({"id": int(key), "error": str(exc)})
        report["records"] = len(records)
        report["files"] = sum(len(r["files"]) for r in records.values())
        report["estimated_bytes"] = sum(
            f["size_estimate"] or 0 for r in records.values() for f in r["files"]
        )

        # Owners: exact full-name match through er_users.
        names: dict[str, dict] = {}
        for cid, r in records.items():
            person = r["contributor"] or {"name": "", "legacy_id": None}
            info = names.setdefault(person["name"], {"legacy_ids": set(), "records": []})
            info["legacy_ids"].add(person["legacy_id"])
            info["records"].append(cid)
        mapping = await owner_mapping(client, cfg, names)
        (out_dir / "owner_mapping.json").write_text(json.dumps(mapping, indent=2, default=str))

        # Files.
        files = FileCache(out_dir / "files")
        todo = [
            (cid, f)
            for cid, r in records.items()
            for f in r["files"]
            if not files.get(key := f"{cid}/{attachment_name(f['name'])}")
            and not files.missing(key)
            and not (max_file_bytes and (f["size_estimate"] or 0) > max_file_bytes)
        ]
        pending = sum(f["size_estimate"] or 0 for _, f in todo)
        report["pending_downloads"] = len(todo)
        report["pending_estimated_bytes"] = pending
        failed: dict[int, list[str]] = {}
        if not download or pending > max_total_bytes:
            report["download_skipped"] = (
                "--no-download" if not download else f"over max_total_bytes {max_total_bytes}"
            )
        elif todo:
            semaphore = asyncio.Semaphore(cfg.concurrency)
            done = 0

            async def fetch(cid: int, f: dict):
                nonlocal done
                key = f"{cid}/{attachment_name(f['name'])}"
                page_url = f"{cfg.base_url.rstrip('/')}/{cid}/"
                async with semaphore:
                    try:
                        files.entries[key] = await download_file(
                            http, page_url, f, files.root / key, cfg.max_file_bytes
                        )
                    except MissingFile:
                        files.entries[key] = {"missing": True, "path": f["path"]}
                        return
                    except Exception as exc:
                        failed.setdefault(cid, []).append(f"{f['name']}: {exc}"[:300])
                        return
                done += 1
                if done % 50 == 0:
                    files.save()
                    print(f"files: {done}/{len(todo)}", file=sys.stderr, flush=True)

            await asyncio.gather(*(fetch(cid, f) for cid, f in todo))
            files.save()

        # Contribution texts + inventory.
        inventory_records, owners, notes = [], {}, {}
        deferred, legacy_missing = {}, {}
        canonical_name = cfg.canonical
        for cid, r in records.items():
            name = (r["contributor"] or {}).get("name", "")
            if cid in failed:
                report["errors"].append({"id": cid, "error": "; ".join(failed[cid])})
                continue
            attached, file_rows = {}, []
            for f in r["files"]:
                key = f"{cid}/{attachment_name(f['name'])}"
                cached = files.get(key)
                if cached is None:
                    target = legacy_missing if files.missing(key) else deferred
                    target.setdefault(cid, []).append(f"{f['name']} [{f['size_text']}]")
                    continue
                attached[attachment_name(f["name"])] = {
                    "source": f"files/{key}",
                    "sha256": cached["sha256"],
                }
                file_rows.append({"name": attachment_name(f["name"]), "size": cached["size"]})
            if cid in legacy_missing or cid in deferred:
                continue
            if name in mapping["matched"]:
                account = mapping["matched"][name]["account"]
                owner_email = account["email"]
                owners.setdefault(owner_email, account | {"contributions": []})
                owners[owner_email]["contributions"].append(cid)
            elif cfg.default_owner:
                owner_email = cfg.default_owner.lower()
                report["default_owner_records"].append(cid)
            else:
                report["errors"].append({"id": cid, "error": f"no account for {name!r}"})
                continue
            canonical = canonical_name.format(slug=node.node.slug, id=cid)
            text = contribution_text(r, file_rows, model, vocab, notes).encode()
            target = out_dir / "records" / str(cid) / canonical
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(text)
            seen = pages.entries[str(cid)]["seen"]
            inventory_records.append(
                {
                    "id": cid,
                    "owner_email": owner_email,
                    "published": True,
                    "latest": True,
                    "created_at": seen,
                    "activated_at": seen,
                    "data_model_version": model["data_model_version"],
                    "revisions": [
                        {
                            "key": "legacy",
                            "timestamp": seen,
                            "canonical": canonical,
                            "files": {
                                canonical: {
                                    "source": f"records/{cid}/{canonical}",
                                    "sha256": digest(text),
                                },
                                **attached,
                            },
                        }
                    ],
                }
            )
        report["downloaded_bytes"] = sum(
            e.get("size", 0) for k, e in files.entries.items() if int(k.split("/")[0]) in records
        )
        inventory = Inventory.model_validate(
            {
                "format": 1,
                "node": node.node.slug,
                "source_id": cfg.source_id,
                "records": inventory_records,
            }
        )
        (out_dir / "inventory.json").write_text(
            inventory.model_dump_json(indent=2, exclude_none=True)
        )
        (out_dir / "owners.json").write_text(
            json.dumps(
                sorted(
                    (
                        {k: o[k] for k in ("handle", "email", "name", "orcid", "contributions")}
                        for o in owners.values()
                    ),
                    key=lambda o: o["email"],
                ),
                indent=2,
            )
        )
        (out_dir / "notes.json").write_text(json.dumps(notes, indent=2, sort_keys=True))
        (out_dir / "excluded.json").write_text(
            json.dumps({"deferred": deferred, "legacy_missing": legacy_missing}, indent=1)
        )
        report["deferred_records"] = len(deferred)
        report["legacy_missing_records"] = len(legacy_missing)
        report["inventory_records"] = len(inventory_records)
        report["owners"] = {
            "matched_names": len(mapping["matched"]),
            "unmatched_names": {n: len(e["records"]) for n, e in mapping["unmatched"].items()},
            "default_owner": cfg.default_owner,
            "default_owner_resolves": mapping["default_owner_resolves"],
        }
        report["notes"] = {kind: len(values) for kind, values in notes.items()}
        report["inventory"] = str(out_dir / "inventory.json")
        return report
    finally:
        if own_http:
            await http.aclose()
