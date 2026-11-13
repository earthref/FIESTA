"""Cross-node views for the EarthRef portal's Users and References pages:

    /v2/portal/users        every contributor of a public contribution and how
                            many they have on each node
    /v2/portal/references   every publication (reference DOI) a public
                            contribution cites and how many cite it on each node

Public data only: a contribution counts once it is activated, the latest
version, and not deleted -- what public search shows. A user is listed by
name, handle and ORCID, never by email. Each node is counted in its own
schema; the totals are cached for a few minutes, and filtering, sorting and
paging happen over that cached list.
"""

import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from fiesta.db.models import Contribution, DoiReference, User
from fiesta.db.session import get_sessionmaker
from fiesta.nodeconfig import get_deployment
from fiesta.services.references import details, normalize

router = APIRouter(prefix="/portal", tags=["portal"])

TTL = 300.0
_cache: dict[str, tuple[float, Any]] = {}


def _nodes() -> list[dict]:
    """The grid's columns: the nodes this deployment serves a web app for, as
    the portal bar lists them."""
    return [
        {"slug": n.node.slug, "key": n.node.key, "color": n.node.color}
        for n in get_deployment().node_list
        if n.serves_web
    ]


def _columns(rows: list[dict]) -> list[dict]:
    """The nodes a grid shows: those with a public contribution among `rows`
    (the whole list, before filtering, so the columns stay put)."""
    present = {slug for row in rows for slug in row["counts"]}
    return [node for node in _nodes() if node["slug"] in present]


def _public():
    return (
        Contribution.is_activated.is_(True),
        Contribution.is_latest.is_(True),
        Contribution.deleted_at.is_(None),
    )


async def _counts(column) -> dict[str, list[tuple[Any, int]]]:
    """(value, number of public contributions) per node slug, grouped by `column`."""
    out = {}
    for node in _nodes():
        async with get_sessionmaker(node["slug"])() as session:
            rows = await session.execute(
                select(column, func.count()).where(*_public(), column.is_not(None)).group_by(column)
            )
            out[node["slug"]] = [(value, count) for value, count in rows]
    return out


async def _cached(key: str, build) -> Any:
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    value = await build()
    _cache[key] = (time.monotonic(), value)
    return value


async def _users() -> list[dict]:
    per_node = await _counts(Contribution.contributor_id)
    counts: dict[int, dict[str, int]] = {}
    for slug, rows in per_node.items():
        for user_id, n in rows:
            counts.setdefault(user_id, {})[slug] = n
    if not counts:
        return []
    async with get_sessionmaker()() as session:
        users = (await session.execute(select(User).where(User.id.in_(counts)))).scalars()
        return [
            {
                "id": u.id,
                "name": u.name,
                "handle": u.handle,
                "orcid": u.orcid,
                "counts": counts[u.id],
                "total": sum(counts[u.id].values()),
            }
            for u in users
        ]


async def _references() -> list[dict]:
    per_node = await _counts(Contribution.reference_doi)
    counts: dict[str, dict[str, int]] = {}
    for slug, rows in per_node.items():
        for raw, n in rows:
            if doi := normalize(raw):
                node_counts = counts.setdefault(doi, {})
                node_counts[slug] = node_counts.get(slug, 0) + n
    if not counts:
        return []
    async with get_sessionmaker()() as session:
        cached = {
            row.doi: row.reference or {}
            for row in (
                await session.execute(
                    select(DoiReference).where(
                        DoiReference.doi.in_(counts), DoiReference.status == "ok"
                    )
                )
            ).scalars()
        }
    out = []
    for doi, node_counts in counts.items():
        ref = cached.get(doi, {})
        out.append(
            {
                "doi": doi,
                "citation": ref.get("citation"),
                "title": ref.get("title"),
                "journal": ref.get("journal"),
                "year": ref.get("year"),
                "long_citation": ref.get("long_citation"),
                "counts": node_counts,
                "total": sum(node_counts.values()),
            }
        )
    return out


def _page(
    rows: list[dict],
    *,
    q: str,
    fields: tuple[str, ...],
    sort: str,
    order: str,
    offset: int,
    limit: int,
) -> dict:
    """Filter by `q` (every word, case-insensitive, in any of `fields`), sort by
    `sort` -- "total", a node slug (that node's count) or a field -- and page."""
    words = q.lower().split()
    if words:
        rows = [
            row
            for row in rows
            if all(
                any(word in str(row.get(field) or "").lower() for field in fields) for word in words
            )
        ]
    slugs = {node["slug"] for node in _nodes()}

    def value(row: dict):
        if sort == "total":
            return row["total"]
        if sort in slugs:
            return row["counts"].get(sort, 0)
        field = row.get(sort)
        return None if field is None or field == "" else str(field).lower()

    # Blanks (a reference the DOI cache has no title for yet) last either way.
    filled = [row for row in rows if value(row) is not None]
    blank = [row for row in rows if value(row) is None]
    rows = sorted(filled, key=value, reverse=order == "desc") + blank
    return {"total": len(rows), "rows": rows[offset : offset + limit]}


Order = Literal["asc", "desc"]


@router.get("/users")
async def list_users(
    q: str = "",
    sort: str = "total",
    order: Order = "desc",
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
) -> dict:
    """Every user with a public contribution, and how many they have on each
    node (`counts`, by node slug)."""
    rows = await _cached("users", _users)
    page = _page(
        rows,
        q=q,
        fields=("name", "handle", "orcid"),
        sort=sort,
        order=order,
        offset=offset,
        limit=limit,
    )
    return {"nodes": _columns(rows), "total": page["total"], "users": page["rows"]}


@router.get("/references")
async def list_references(
    q: str = "",
    sort: str = "total",
    order: Order = "desc",
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
) -> dict:
    """Every publication (DOI) a public contribution cites, and how many cite
    it on each node (`counts`, by node slug). Citation, title, journal and year
    come from the DOI cache (fiesta.services.references) once it has them."""
    rows = await _cached("references", _references)
    page = _page(
        rows,
        q=q,
        fields=("doi", "citation", "title", "journal", "year", "long_citation"),
        sort=sort,
        order=order,
        offset=offset,
        limit=limit,
    )
    return {"nodes": _columns(rows), "total": page["total"], "references": page["rows"]}


@router.get("/references/{doi:path}")
async def reference_details(doi: str) -> dict:
    """A publication's cached metadata beyond a search doc's `_reference`:
    `{reference, abstract?, openalex?, citations_by_year?, topics?, keywords?,
    open_access?: {url, status}}` (fiesta.services.references.details). 404
    until the DOI has been fetched."""
    key = normalize(doi)
    async with get_sessionmaker()() as session:
        row = await session.get(DoiReference, key) if key else None
    if row is None or row.status != "ok":
        raise HTTPException(404, "No metadata for this DOI yet")
    return details(row)
