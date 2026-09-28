"""Publication metadata for contributions' reference DOIs, from Crossref or,
failing that, DataCite (as the legacy MagIC app's getReferenceMetadata did).

Saving a revision with a DOI asks for it (`request`, in the same transaction);
the outbox worker fetches due DOIs (`drain`) into the shared `doi_references`
cache and sets `summary.contribution._reference` on the search docs of every
contribution citing them, falling back to reindex events when search is down.
Indexing reads the cache (`lookup`) and never calls out, so a registry outage
only leaves `_reference` as `{doi}`. Each DOI is fetched again a month later,
which keeps `n_citations` current.

`_reference` keeps the legacy shape: source, doi, title, journal, year,
keywords, citation ("Smith et al. (2014)"), authors [{family, given, _name,
affiliation, _orcid}], long_authors, n_citations, html, and long_citation
(the html citation as plain text).
"""

import asyncio
import logging
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from fiesta.db.models import Contribution, DoiReference
from fiesta.db.session import get_sessionmaker
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)

DOI_RE = re.compile(r"10\.\d{4,9}/\S+")
CROSSREF = "https://api.crossref.org/works/"
DATACITE = "https://api.datacite.org/dois/"
REFRESH = timedelta(days=30)
RETRY = timedelta(hours=1)
MAX_RETRY = timedelta(days=7)
BATCH = 20
# Crossref's polite pool allows 3 concurrent requests.
CONCURRENCY = 3
TIMEOUT = 20.0


def normalize(doi: str | None) -> str | None:
    """A DOI as the cache keys it (upper case, as legacy stored it), from a
    bare DOI, a doi.org URL or "doi:..."; None when there is none."""
    match = DOI_RE.search(doi or "")
    return match.group(0).rstrip(".,;").upper() if match else None


async def request(session, doi: str | None) -> None:
    """Ask for a DOI's metadata, unless it is already known or asked for."""
    if key := normalize(doi):
        await session.execute(
            insert(DoiReference)
            .values(doi=key, status="pending", attempts=0, due_at=datetime.now(UTC))
            .on_conflict_do_nothing()
        )


async def lookup(session, doi: str | None) -> dict | None:
    """The cached `_reference` of a DOI, or None before a successful fetch."""
    if not (key := normalize(doi)):
        return None
    row = await session.get(DoiReference, key)
    return row.reference if row is not None and row.status == "ok" else None


# --- The registries' records, in the legacy shape ------------------------------


def _family(name: str) -> str:
    # "SMITH" -> "Smith", as legacy's startCase(lowerCase()).
    return name.title() if name and name == name.upper() else name


def _reference(
    source: str,
    doi: str,
    *,
    title: str | None,
    journal: str | None,
    year: int | None,
    keywords: list[str],
    authors: list[dict],
    n_citations: int | None,
    volume: str | None = None,
    issue: str | None = None,
    page: str | None = None,
) -> dict:
    ref: dict = {"source": source, "doi": doi.upper()}
    if title:
        ref["title"] = title
    if journal:
        ref["journal"] = journal
    if year:
        ref["year"] = year
    if keywords:
        ref["keywords"] = keywords
    families = [a["family"] for a in authors if a.get("family")]
    if families:
        citation = (
            families[0]
            if len(families) == 1
            else f"{families[0]} & {families[1]}"
            if len(families) == 2
            else f"{families[0]} et al."
        )
        ref["citation"] = f"{citation} ({year})" if year else citation
    if authors:
        ref["authors"] = authors
        ref["long_authors"] = ", ".join(
            " ".join(p for p in (a.get("given"), a.get("family")) if p) for a in authors
        )
    if n_citations:
        ref["n_citations"] = n_citations
    where = "".join(
        [
            f" {volume}" if volume else "",
            f" ({issue})" if issue else "",
            f":{page}" if page else "",
        ]
    )
    head = f"{ref.get('long_authors') or 'Unknown Authors'} ({year or 'Unknown Year'})."
    body = f"{title or 'Unknown Title'}. {journal or 'Unknown Journal'}{where}."
    ref["long_citation"] = f"{head} {body} doi:{ref['doi']}."
    ref["html"] = (
        f"<b>{ref.get('long_authors') or '<i>Unknown Authors</i>'} "
        f"({year or '<i>Unknown Year</i>'}).</b> {title or '<i>Unknown Title</i>'}. "
        f"<i>{journal or 'Unknown Journal'}{where}. doi:<a href='//dx.doi.org/{ref['doi']}'>"
        f"{ref['doi']}</a>.</i>"
    ).replace('"', "'")
    return ref


def _author(family: str, given: str | None, affiliations: list[str], orcid: str | None) -> dict:
    family = _family(family)
    initial = (given or "").strip()[:1].upper()
    author: dict = {"family": family, "_name": f"{initial}. {family}" if initial else family}
    if given:
        author["given"] = given
    if affiliations:
        author["affiliation"] = affiliations
    if orcid:
        author["_orcid"] = orcid.rstrip("/").rsplit("/", 1)[-1]
    return author


def from_crossref(d: dict) -> dict:
    """A Crossref work (`message` of /works/{doi})."""

    def year_of(key: str) -> int | None:
        parts = (d.get(key) or {}).get("date-parts") or [[None]]
        return parts[0][0] if parts and parts[0] else None

    # Print, then online, then accepted (legacy's order), then Crossref's own.
    year = next(
        (
            y
            for k in ("published-print", "published-online", "accepted", "issued")
            if (y := year_of(k))
        ),
        None,
    )
    authors = [
        _author(
            a.get("family") or a.get("name") or "",
            a.get("given"),
            [f["name"] for f in a.get("affiliation") or [] if f.get("name")],
            a.get("ORCID"),
        )
        for a in d.get("author") or []
    ]
    return _reference(
        "crossref",
        d["DOI"],
        title=(d.get("title") or [None])[0],
        journal=(d.get("container-title") or [None])[0],
        year=year,
        keywords=d.get("subject") or [],
        authors=authors,
        n_citations=d.get("is-referenced-by-count"),
        volume=d.get("volume"),
        issue=d.get("issue"),
        page=d.get("page"),
    )


def from_datacite(d: dict) -> dict:
    """A DataCite DOI's `data.attributes` (of /dois/{doi})."""
    authors = []
    for c in d.get("creators") or []:
        family, given = c.get("familyName"), c.get("givenName")
        name = c.get("name") or ""
        if not family and c.get("nameType") == "Organizational":
            family = name
        elif not family and "," in name:
            # DataCite's "Family, Given".
            family, _, given = (p.strip() for p in name.partition(","))
        elif not family:
            # "Given Family" (legacy split on the last space).
            given, _, family = name.rpartition(" ")
        orcid = next(
            (
                i.get("nameIdentifier")
                for i in c.get("nameIdentifiers") or []
                if (i.get("nameIdentifierScheme") or "").upper() == "ORCID"
            ),
            None,
        )
        affiliations = [
            a if isinstance(a, str) else a.get("name") for a in c.get("affiliation") or []
        ]
        authors.append(_author(family or "", given or None, [a for a in affiliations if a], orcid))
    publisher = d.get("publisher")
    year = d.get("publicationYear")
    return _reference(
        "datacite",
        d["doi"],
        title=((d.get("titles") or [{}])[0]).get("title"),
        journal=publisher.get("name") if isinstance(publisher, dict) else publisher,
        year=int(year) if str(year or "").isdigit() else None,
        keywords=[s["subject"] for s in d.get("subjects") or [] if s.get("subject")],
        authors=authors,
        n_citations=d.get("citationCount"),
    )


# --- Fetching ------------------------------------------------------------------


async def fetch(client: httpx.AsyncClient, doi: str) -> tuple[str, str | None, dict | None]:
    """(status, source, raw record): ok, not_found (in neither registry), or
    error (to retry). Crossref first; DataCite for DOIs it doesn't know."""
    response = await client.get(CROSSREF + quote(doi, safe="/"))
    if response.status_code == 200:
        return "ok", "crossref", response.json()["message"]
    if response.status_code != 404:
        response.raise_for_status()
        raise httpx.HTTPError(f"crossref answered {response.status_code}")
    response = await client.get(DATACITE + quote(doi, safe="/"))
    if response.status_code == 200:
        return "ok", "datacite", response.json()["data"]["attributes"]
    if response.status_code == 404:
        return "not_found", None, None
    response.raise_for_status()
    raise httpx.HTTPError(f"datacite answered {response.status_code}")


def _client() -> httpx.AsyncClient:
    # Crossref's polite pool: say who is asking and how to reach them.
    agent = f"EarthRef-FIESTA/1.0 (https://earthref.org; mailto:{get_settings().smtp_from})"
    return httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": agent}, follow_redirects=True)


async def _apply(row: DoiReference, outcome) -> bool:
    """Store a fetch's outcome on its row; whether its _reference changed."""
    now = datetime.now(UTC)
    row.attempts += 1
    if isinstance(outcome, BaseException):
        if row.status != "ok":  # a refresh that fails keeps what it had
            row.status = "error"
        row.error = f"{type(outcome).__name__}: {outcome}"[:1000]
        row.due_at = now + min(RETRY * 2 ** (row.attempts - 1), MAX_RETRY)
        return False
    status, source, raw = outcome
    row.error = None
    row.attempts = 0
    row.fetched_at = now
    row.due_at = now + REFRESH
    if status != "ok":
        row.status = status
        return False
    try:
        reference = from_crossref(raw) if source == "crossref" else from_datacite(raw)
    except (KeyError, TypeError, ValueError, IndexError, AttributeError) as exc:
        if row.status != "ok":
            row.status = "error"
        row.error = f"unreadable {source} record: {exc}"[:1000]
        return False
    changed = row.status != "ok" or row.reference != reference
    row.status, row.source, row.raw, row.reference = "ok", source, raw, reference
    return changed


async def drain(limit: int = BATCH) -> dict:
    """Fetch up to `limit` due DOIs and bring their contributions' search
    docs up to date; returns counts by outcome."""
    counts = {"ok": 0, "not_found": 0, "error": 0, "updated": 0}
    async with get_sessionmaker()() as session:
        rows = (
            (
                await session.execute(
                    select(DoiReference)
                    .where(DoiReference.due_at <= datetime.now(UTC))
                    .order_by(DoiReference.due_at)
                    .limit(limit)
                    .with_for_update(skip_locked=True)
                )
            )
            .scalars()
            .all()
        )
        if not rows:
            return counts
        gate = asyncio.Semaphore(CONCURRENCY)
        async with _client() as client:

            async def one(doi):
                async with gate:
                    return await fetch(client, doi)

            outcomes = await asyncio.gather(*(one(r.doi) for r in rows), return_exceptions=True)
        changed = {}
        for row, outcome in zip(rows, outcomes, strict=True):
            if await _apply(row, outcome):
                changed[row.doi] = row.reference
            counts["error" if isinstance(outcome, BaseException) else row.status] += 1
            if isinstance(outcome, BaseException):
                logger.warning("reference %s: %s", row.doi, row.error)
        await session.commit()
    if changed:
        counts["updated"] = await update_contributions(changed)
    return counts


async def update_contributions(references: dict[str, dict]) -> int:
    """Set `_reference` on the search docs of every contribution citing these
    DOIs, on every node; where search can't be updated, queue a reindex."""
    from fiesta.nodeconfig import get_deployment
    from fiesta.search.client import get_opensearch
    from fiesta.search.documents import set_contribution_reference
    from fiesta.services.revisions import enqueue

    updated = 0
    for node in get_deployment().node_list:
        async with get_sessionmaker(node.node.slug)() as session:
            # By the DOI as normalized: a stored one may be a URL or lower case.
            cited = (
                await session.execute(
                    select(Contribution.id, Contribution.reference_doi).where(
                        Contribution.reference_doi.is_not(None),
                        Contribution.head_revision.is_not(None),
                        Contribution.deleted_at.is_(None),
                    )
                )
            ).all()
            for cid, doi in cited:
                if (reference := references.get(normalize(doi) or "")) is None:
                    continue
                contribution = await session.get(Contribution, cid)
                try:
                    await set_contribution_reference(
                        get_opensearch(), node.search_index, contribution.id, reference
                    )
                    updated += 1
                except Exception as exc:
                    logger.warning(
                        "reference of %s/%s left to a reindex: %s",
                        node.node.slug,
                        contribution.id,
                        exc,
                    )
                    enqueue(session, contribution, kind="index")
            await session.commit()
    return updated


async def request_all() -> dict[str, int]:
    """Ask for the DOI of every contribution on every node (the backfill);
    returns the number of distinct DOIs per node."""
    from fiesta.nodeconfig import get_deployment

    found = {}
    for node in get_deployment().node_list:
        async with get_sessionmaker(node.node.slug)() as session:
            dois = (
                await session.execute(
                    select(Contribution.reference_doi)
                    .where(
                        Contribution.reference_doi.is_not(None),
                        Contribution.reference_doi != "",
                        Contribution.deleted_at.is_(None),
                    )
                    .distinct()
                )
            ).scalars()
            keys = {k for d in dois if (k := normalize(d))}
            for key in keys:
                await request(session, key)
            await session.commit()
            found[node.node.slug] = len(keys)
    return found


async def refresh_all() -> int:
    """Make every fetched DOI due now (a full refresh)."""
    from sqlalchemy import update

    async with get_sessionmaker()() as session:
        result = await session.execute(
            update(DoiReference)
            .where(DoiReference.status != "pending")
            .values(due_at=datetime.now(UTC))
        )
        await session.commit()
        return result.rowcount
