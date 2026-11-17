"""Saved searches: the search page's state behind a short URL id.

The SPA keeps the level and result view in the URL path
(`/MagIC/Search/Sites/Data`) and everything else -- the query, the sidebar's
filters, the sort, plugin view settings such as the map's color-by -- in a
`SearchState` stored under an id (`?q=<id>`). The id is a UUIDv5 of the node
and the canonical JSON of the state, so the same search always gets the same
id, rows are never edited, and a shared link keeps showing what it showed.
"""

import json
import uuid
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

# Namespace for search ids (uuid5 over "<node>:<canonical state>").
NAMESPACE = uuid.UUID("6f1c2d9e-5b0a-4e43-9d3f-7c2a1e8b4f10")

# The canonical JSON's size cap: a search's state is a few hundred bytes; a
# plugin's settings may add a few kB.
MAX_STATE_BYTES = 16_000

Text = Annotated[str, StringConstraints(max_length=2000)]
Token = Annotated[str, StringConstraints(min_length=1, max_length=500)]
SettingKey = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_.-]{0,63}$")]


class SearchState(BaseModel):
    """What a saved search holds. Empty fields are left out of the canonical
    form, so `{}` is the node's default search."""

    model_config = ConfigDict(extra="forbid")

    # Free text and `field:"value"` facet tokens (the legacy `q` param).
    query: Text | None = None
    # "<field>:asc|desc"; "rows.<column>:..." sorts by a raw row column.
    sort: Annotated[str, StringConstraints(max_length=200)] | None = None
    # Plugin range filters, each "field:gte:lte".
    ranges: list[Token] = Field(default_factory=list, max_length=50)
    # Summary grid column filters, each "<column key>:<text>".
    filter: list[Token] = Field(default_factory=list, max_length=50)
    # With/without data filters, "<table>:<column>" or "!<table>:<column>".
    has: list[Token] = Field(default_factory=list, max_length=50)
    # Plugin bounding box "minLon,minLat,maxLon,maxLat".
    bbox: Annotated[str, StringConstraints(max_length=100)] | None = None
    # The geospatial filter's area "west,south,east,north" and plates "PA,EU".
    area: Annotated[str, StringConstraints(max_length=100)] | None = None
    plates: Annotated[str, StringConstraints(max_length=500)] | None = None
    # Scope: the viewer's own contributions; older versions too.
    mine: Literal["in_prep", "published"] | None = None
    versions: Literal["all"] | None = None
    # Plugin and core view settings, "<owner>.<key>" -> any JSON value
    # ("map.color", "poles.vgp"); a value equal to its default is not stored.
    settings: dict[SettingKey, Any] = Field(default_factory=dict, max_length=100)

    @field_validator("query", "sort", "bbox", "area", "plates", mode="after")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return value if value else None


def canonical(state: SearchState) -> dict[str, Any]:
    """The state with empty fields dropped (None, [], {}, "")."""
    data = state.model_dump(mode="json")
    return {key: value for key, value in data.items() if value not in (None, [], {}, "")}


def canonical_json(state: SearchState) -> str:
    return json.dumps(canonical(state), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def search_id(node: str, state: SearchState) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"{node}:{canonical_json(state)}")


class StateTooLarge(ValueError):
    pass


def check_size(state: SearchState) -> None:
    if len(canonical_json(state).encode()) > MAX_STATE_BYTES:
        raise StateTooLarge(f"search state is over {MAX_STATE_BYTES} bytes")
