"""A contribution as a schema.org `Dataset` in JSON-LD, after the
Science-on-Schema.org (SOSO) Dataset guidelines and Google's Dataset rich
results, for the contribution landing page (and dataset search engines and
harvesters such as GeoCODES, EPOS and Google Dataset Search).

Built from the contribution's search document (`{type, summary: {...}}`, see
fiesta.domain.summarize) and the node's configuration only, so every node gets
one: identity and DOI prefix from the node YAML, variable names, descriptions
and units from its data model, keywords from the controlled and suggested
vocabulary columns with values, spatial coverage from `_geo_point`, temporal
coverage from a `summary._interval` in years BP, and measured variables'
ranges from `summary._num`. Ported in spirit from the legacy MagIC
`search_jsonld.jsx` (whose provider, license and coverage it keeps).

Workflow fields (`_private_key`, `_is_activated`, ...) are never copied out,
and a private contribution gets no DOI (one is minted only on activation).
"""

from __future__ import annotations

import html
import re
from typing import Any

from fiesta.nodeconfig import POSITION_COLUMNS, NodeConfig

# Per Google, a Dataset description is 50-5000 characters.
MAX_DESCRIPTION = 5000
# Distinct points listed under spatialCoverage beside their bounding box.
MAX_POINTS = 100
# Keyword values per vocabulary column, and in all.
MAX_KEYWORDS_PER_COLUMN = 25
MAX_KEYWORDS = 200

_TAG = re.compile(r"<[^>]+>")
_VOCABULARY = re.compile(r'^[cs]v\("')


def _text(value: Any) -> str:
    """Plain text from a string that may hold HTML (reference titles do)."""
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub("", str(value)))).strip()


def _doi_url(doi: str) -> str:
    return f"https://doi.org/{doi}"


def _person(author: dict) -> dict | None:
    given, family = author.get("given"), author.get("family")
    name = " ".join(p for p in (given, family) if p) or author.get("_name") or author.get("name")
    if not name:
        return None
    person: dict[str, Any] = {"@type": "Person", "name": name}
    if given:
        person["givenName"] = given
    if family:
        person["familyName"] = family
    if orcid := author.get("_orcid") or author.get("orcid"):
        url = orcid if orcid.startswith("http") else f"https://orcid.org/{orcid}"
        person["@id"] = url
        person["identifier"] = {
            "@type": "PropertyValue",
            "propertyID": "https://registry.identifiers.org/registry/orcid",
            "value": url.rsplit("/", 1)[-1],
            "url": url,
        }
    return person


def _points(summary_all: dict) -> list[tuple[float, float]]:
    raw = summary_all.get("_geo_point") or []
    if isinstance(raw, dict):
        raw = [raw]
    seen: dict[tuple[float, float], None] = {}
    for point in raw:
        try:
            seen[(float(point["lat"]), float(point["lon"]))] = None
        except (KeyError, TypeError, ValueError):
            continue
    return list(seen)


def _spatial(points: list[tuple[float, float]]) -> dict | None:
    if not points:
        return None
    geo: list[dict] = []
    if len(points) > 1:
        lats = [lat for lat, _ in points]
        lons = [lon for _, lon in points]
        # schema.org box: "south west north east".
        geo.append({"@type": "GeoShape", "box": f"{min(lats)} {min(lons)} {max(lats)} {max(lons)}"})
    geo += [
        {"@type": "GeoCoordinates", "latitude": lat, "longitude": lon}
        for lat, lon in points[:MAX_POINTS]
    ]
    return {"@type": "Place", "geo": geo[0] if len(geo) == 1 else geo}


def _years_bp(value: float) -> str:
    """An age in years BP as people write it: 80 Ma, 12.5 ka, 300 years BP."""
    for scale, unit in ((1e9, "Ga"), (1e6, "Ma"), (1e3, "ka")):
        if abs(value) >= scale:
            return f"{value / scale:.4g} {unit}"
    return f"{value:.4g} years BP"


def _temporal(node: NodeConfig, summary: dict) -> tuple[dict | None, str | None]:
    """The first years-BP interval's span as a SOSO geologic-time interval,
    and as text for the description."""
    for conversion in node.search.intervals:
        if (conversion.unit or "").lower() != "years bp":
            continue
        block = (summary.get("_interval") or {}).get(conversion.interval.name) or {}
        low, high = block.get("min"), block.get("max")
        if low is None or high is None:
            # A doc indexed before intervals: the converted columns' values.
            values = [v for c in conversion.columns for v in (summary.get("_num") or {}).get(c, [])]
            if not values:
                continue
            low, high = min(values), max(values)
        older, younger = max(low, high), min(low, high)

        def instant(years: float) -> dict:
            return {
                "@type": "time:Instant",
                "time:inTimePosition": {
                    "@type": "time:TimePosition",
                    "time:hasTRS": {"@id": "http://www.opengis.net/def/crs/OGC/0/ChronometricBP"},
                    "time:numericPosition": {"@value": round(years, 3), "@type": "xsd:decimal"},
                },
            }

        coverage = {
            "@type": "time:ProperInterval",
            "time:hasBeginning": instant(older),
            "time:hasEnd": instant(younger),
        }
        text = (
            _years_bp(older) if older == younger else f"{_years_bp(younger)} to {_years_bp(older)}"
        )
        return coverage, text
    return None, None


def _model_columns(node: NodeConfig, version: str | None) -> dict[str, dict]:
    """Every data model column by name (the first table's definition wins)."""
    try:
        model = node.load_data_model(version or node.data_model.latest)
    except KeyError:
        model = node.load_data_model(node.data_model.latest)
    columns: dict[str, dict] = {}
    for table in model.get("tables", {}).values():
        for name, column in table.get("columns", {}).items():
            columns.setdefault(name, column)
    return columns


def _converted_unit(node: NodeConfig, column: str) -> str | None:
    """The base unit `summary._num` holds COLUMN in, when a unit conversion
    puts it in one (ages in years BP whatever their age_unit)."""
    for conversion in node.search.unit_conversions:
        if column in conversion.columns or column in conversion.scaled:
            return conversion.unit
    return None


def _variables(node: NodeConfig, summary: dict, columns: dict[str, dict]) -> list[dict]:
    variables = []
    for name, values in sorted((summary.get("_num") or {}).items()):
        column = columns.get(name)
        if not column or name in POSITION_COLUMNS or not values:
            continue
        variable: dict[str, Any] = {
            "@type": "PropertyValue",
            "name": column.get("label") or name,
            "propertyID": name,
            "minValue": min(values),
            "maxValue": max(values),
        }
        if description := column.get("description"):
            variable["description"] = description
        if unit := _converted_unit(node, name) or column.get("unit"):
            variable["unitText"] = unit
        variables.append(variable)
    return variables


def _keywords(node: NodeConfig, summary_all: dict, columns: dict[str, dict]) -> list[str]:
    """Values of the vocabulary columns (cv/sv validations) with data, but
    not unit columns (an age_unit's "Ma")."""
    units = {c.unit_column for c in node.search.unit_conversions}
    keywords: dict[str, None] = {node.node.key: None}
    for name, column in columns.items():
        if name in units or not any(_VOCABULARY.match(v) for v in column.get("validations") or []):
            continue
        values = summary_all.get(name) or []
        for value in (values if isinstance(values, list) else [values])[:MAX_KEYWORDS_PER_COLUMN]:
            # Not one-letter codes (a quality's "g") or placeholders.
            if isinstance(value, str) and len(value.strip()) > 2 and value != "Not Specified":
                keywords[value.strip()] = None
        if len(keywords) >= MAX_KEYWORDS:
            break
    return list(keywords)[:MAX_KEYWORDS]


def _counts(node: NodeConfig, summary: dict) -> str | None:
    """'1 location, 25 sites and 395 samples' from the levels' _n_results."""
    parts = []
    for level in node.search.levels:
        if level.table == "contribution":
            continue
        n = (summary.get(level.table) or {}).get("_n_results")
        if not n:
            continue
        name = level.name.lower()
        parts.append(f"{n:,} {name[:-1] if n == 1 and name.endswith('s') else name}")
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"


def contribution_jsonld(
    node: NodeConfig,
    doc: dict,
    *,
    landing_url: str,
    catalog_url: str,
    download_url: str | None = None,
) -> dict:
    """The schema.org Dataset for one contribution's search document.

    `landing_url` is the contribution's page (`https://earthref.org/MagIC/1`),
    `catalog_url` the node's (`https://earthref.org/MagIC`), `download_url`
    its file on the public API."""
    summary = doc.get("summary") or {}
    contribution = summary.get("contribution") or {}
    summary_all = summary.get("_all") or {}
    reference = contribution.get("_reference") or {}
    if not isinstance(reference, dict):
        reference = {}
    cid = contribution.get("id")
    identity = node.node
    title = _text(reference.get("title") or reference.get("citation") or "")
    columns = _model_columns(node, contribution.get("data_model_version"))

    organization = {
        "@id": catalog_url,
        "@type": "Organization",
        "name": identity.key,
        "legalName": identity.title,
        "url": catalog_url,
    }
    if node.jsonld.re3data:
        organization["identifier"] = f"https://www.re3data.org/repository/{node.jsonld.re3data}"

    data: dict[str, Any] = {
        "@context": {
            "@vocab": "https://schema.org/",
            "time": "http://www.w3.org/2006/time#",
            "xsd": "http://www.w3.org/2001/XMLSchema#",
        },
        "@type": "Dataset",
        "@id": landing_url,
        "url": landing_url,
        "name": (
            f"{title} ({identity.key} contribution {cid})"
            if title
            else f"{identity.key} contribution {cid}"
        ),
        "isAccessibleForFree": True,
        "license": node.jsonld.license,
        "provider": organization,
        "publisher": {"@id": catalog_url},
        "includedInDataCatalog": {
            "@type": "DataCatalog",
            "@id": f"{catalog_url}#catalog",
            "name": identity.title,
            "url": catalog_url,
        },
    }

    activated = contribution.get("_is_activated") is not False
    if node.doi.prefix and cid is not None and activated:
        doi = f"{node.doi.prefix}/{cid}"
        data["identifier"] = {
            "@id": _doi_url(doi),
            "@type": "PropertyValue",
            "propertyID": "https://registry.identifiers.org/registry/doi",
            "value": f"doi:{doi}",
            "url": _doi_url(doi),
        }
        data["sameAs"] = _doi_url(doi)

    if version := contribution.get("version"):
        data["version"] = str(version)
    if timestamp := contribution.get("timestamp"):
        data["dateModified"] = timestamp
        data["datePublished"] = timestamp

    creators = [p for a in reference.get("authors") or [] if (p := _person(a))]
    if creators:
        data["creator"] = creators
    if contributor := contribution.get("_contributor"):
        data["contributor"] = {"@type": "Person", "name": contributor}

    if reference.get("doi") or title:
        article: dict[str, Any] = {"@type": "ScholarlyArticle"}
        if ref_doi := reference.get("doi"):
            article["@id"] = article["url"] = _doi_url(ref_doi)
        if title:
            article["name"] = title
        if cite := reference.get("long_citation"):
            article["description"] = _text(cite)
        if year := reference.get("year"):
            article["datePublished"] = str(year)
        if journal := reference.get("journal"):
            article["isPartOf"] = {"@type": "Periodical", "name": _text(journal)}
        data["citation"] = article

    temporal, age_text = _temporal(node, summary)
    counts = _counts(node, summary)
    # Abstracts are rarely in references; a sentence built from what is
    # always there gives search engines and language models the gist.
    sentences = [
        f"{identity.title} contribution {cid}"
        + (f", version {version}" if version else "")
        + (
            f", with data from {_text(reference['long_citation']).rstrip('.')}"
            if reference.get("long_citation")
            else (f', with data from "{title}"' if title else "")
        )
        + "."
    ]
    if counts:
        sentences.append(f"It holds {counts}.")
    if age_text:
        sentences.append(f"Ages span {age_text}.")
    if lab_names := contribution.get("lab_names"):
        sentences.append(f"Laboratory: {_text(lab_names)}.")
    if abstract := reference.get("abstract_html") or reference.get("abstract"):
        sentences.append(_text(abstract))
    data["description"] = " ".join(sentences)[:MAX_DESCRIPTION]

    keywords = _keywords(node, summary_all, columns)
    if reference_keywords := reference.get("keywords"):
        if isinstance(reference_keywords, str):
            reference_keywords = [k.strip() for k in reference_keywords.split(",")]
        keywords = list(dict.fromkeys([*keywords, *map(str, reference_keywords)]))
    data["keywords"] = keywords

    if spatial := _spatial(_points(summary_all)):
        data["spatialCoverage"] = spatial
    if temporal:
        data["temporalCoverage"] = temporal
    if variables := _variables(node, summary, columns):
        data["variableMeasured"] = variables

    if node.jsonld.funding_column and (
        grants := _funding(contribution.get(node.jsonld.funding_column))
    ):
        data["funding"] = grants

    if download_url:
        data["distribution"] = {
            "@type": "DataDownload",
            "contentUrl": download_url,
            "encodingFormat": ["text/tab-separated-values", "text/plain"],
        }

    # Node science from its plugins (method-codes: measurementTechnique).
    from fiesta.plugins import active_plugins

    for plugin in active_plugins(node):
        for key, value in plugin.jsonld(node, doc, catalog_url).items():
            if isinstance(value, list) and isinstance(data.get(key), list):
                data[key] = data[key] + [v for v in value if v not in data[key]]
            else:
                data.setdefault(key, value)
    return data


def _split_entries(value: str) -> list[str]:
    """A Dictionary cell's entries: split on colons outside [...] and quotes
    (`Title[url]:"A: B"[url]`)."""
    entries, current, depth, quoted = [], [], 0, False
    for char in value:
        if char == '"':
            quoted = not quoted
        elif char == "[" and not quoted:
            depth += 1
        elif char == "]" and not quoted:
            depth = max(0, depth - 1)
        elif char == ":" and not quoted and depth == 0:
            entries.append("".join(current))
            current = []
            continue
        current.append(char)
    entries.append("".join(current))
    return [e.strip() for e in entries if e.strip()]


def _funding(value: Any) -> list[dict]:
    """Grants from a `Title[url]:Title[url]` Dictionary cell (the legacy
    MagIC funding column) as schema.org MonetaryGrants."""
    if not value:
        return []
    grants = []
    for entry in _split_entries(str(value)):
        match = re.fullmatch(r'"?(.*?)"?\s*(?:\[(.*)\])?', entry, re.S)
        name, url = (
            (match.group(1).strip(), (match.group(2) or "").strip()) if match else (entry, "")
        )
        if not name and not url:
            continue
        grant: dict[str, Any] = {"@type": "MonetaryGrant", "name": name or url}
        if url.startswith(("http://", "https://")):
            grant["@id"] = grant["url"] = url
        grants.append(grant)
    return grants


def catalog_jsonld(node: NodeConfig, *, catalog_url: str, contributions: int | None = None) -> dict:
    """The node as a schema.org DataCatalog (its home page), with a
    SearchAction on its search page."""
    identity = node.node
    data: dict[str, Any] = {
        "@context": {"@vocab": "https://schema.org/"},
        "@type": "DataCatalog",
        "@id": f"{catalog_url}#catalog",
        "url": catalog_url,
        "name": identity.title,
        "alternateName": identity.key,
        "description": _text(identity.subtitle) or identity.title,
        "license": node.jsonld.license,
        "isAccessibleForFree": True,
        "provider": {
            "@id": catalog_url,
            "@type": "Organization",
            "name": identity.key,
            "legalName": identity.title,
            "url": catalog_url,
        },
        "potentialAction": {
            "@type": "SearchAction",
            "target": f"{catalog_url}/search?q={{search_term_string}}",
            "query-input": "required name=search_term_string",
        },
    }
    if node.jsonld.re3data:
        re3data = f"https://www.re3data.org/repository/{node.jsonld.re3data}"
        data["identifier"] = data["provider"]["identifier"] = re3data
    if contributions is not None:
        data["description"] += f" {contributions:,} public contributions."
    return data
