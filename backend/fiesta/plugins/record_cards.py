"""`record-cards` plugin.

Some nodes publish *records* rather than measurements: an ERDA digital object,
an OSU-MGR core or rock. The default result card is measurement-shaped
(geologic classes, lithologies, method codes, intensities) and has nothing to
show for them. This plugin has no behavior of its own — it tells the SPA, per
search table, which column titles the card and which columns become cells, so
the layout stays data-driven instead of hard-coded per node.
"""

from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin


def _card(title: str, cells: list[dict], subtitle: str | None = None) -> dict:
    """One table's card. `width` is the legacy fixed-width result cell in px;
    `format` names a value formatter in the UI (currently only "bytes")."""
    card = {"title_column": title, "cells": cells}
    if subtitle:
        card["subtitle_column"] = subtitle
    return card


ERDA_CARDS = {
    "objects": _card(
        "title",
        [
            {"column": "data_types", "label": "Data Types", "width": 150},
            {"column": "expert_level", "label": "Expert Level", "width": 170},
            {"column": "keywords", "label": "Keywords", "width": 200},
            {"column": "computer_program", "label": "Computer Program", "width": 150},
            {"column": "project", "label": "Project", "width": 180},
            {"column": "locations", "label": "Locations", "width": 180},
        ],
        subtitle="description",
    ),
    "files": _card(
        "file",
        [
            {"column": "format", "label": "Format", "width": 90},
            {"column": "media_type", "label": "Media Type", "width": 180},
            {"column": "size_bytes", "label": "File Size", "width": 110, "format": "bytes"},
        ],
        subtitle="description",
    ),
}

_POSITION_CELLS = [
    {"column": "lat", "label": "Latitude", "width": 100},
    {"column": "lon", "label": "Longitude", "width": 100},
    {"column": "water_depth", "label": "Water Depth", "width": 110},
    {"column": "start_date", "label": "Collected", "width": 110},
    {"column": "area", "label": "Area", "width": 160},
]

OSU_MGR_CARDS = {
    "cruises": _card(
        "cruise",
        [
            {"column": "cruise_name", "label": "Cruise Name", "width": 220},
            {"column": "rv_name", "label": "Research Vessel", "width": 160},
            {"column": "pi", "label": "PI", "width": 150},
            {"column": "pi_institution", "label": "Institution", "width": 180},
            {"column": "collection", "label": "Collection", "width": 150},
            {"column": "accession_date", "label": "Accessioned", "width": 110},
        ],
        subtitle="place",
    ),
    "cores": _card(
        "core",
        [
            {"column": "method", "label": "Method", "width": 150},
            {"column": "material", "label": "Material", "width": 110},
            {"column": "length", "label": "Length (cm)", "width": 110},
            *_POSITION_CELLS,
        ],
        subtitle="notes",
    ),
    "sections": _card(
        "section",
        [
            {"column": "section_number", "label": "Section", "width": 90},
            {"column": "depth_top", "label": "Depth Top (cm)", "width": 120},
            {"column": "depth_bottom", "label": "Depth Bottom (cm)", "width": 140},
            {"column": "length", "label": "Length (cm)", "width": 110},
            {"column": "igsn", "label": "IGSN", "width": 180},
            {"column": "storage_location", "label": "Storage", "width": 180},
        ],
    ),
    "dives": _card(
        "dive",
        [
            {"column": "method", "label": "Method", "width": 130},
            {"column": "rov_name", "label": "ROV", "width": 150},
            {"column": "weight", "label": "Recovery (kg)", "width": 120},
            *_POSITION_CELLS,
        ],
        subtitle="notes",
    ),
    "dive_samples": _card(
        "dive_sample",
        [
            {"column": "texture", "label": "Principal Texture", "width": 200},
            {"column": "material", "label": "Material", "width": 110},
            {"column": "weight", "label": "Weight (kg)", "width": 110},
            {"column": "igsn", "label": "IGSN", "width": 180},
            {"column": "sesar_resource_type", "label": "SESAR Type", "width": 150},
            {"column": "storage_location", "label": "Storage", "width": 180},
        ],
        subtitle="notes",
    ),
    "files": _card(
        "file",
        [
            {"column": "file_type", "label": "File Type", "width": 170},
            {"column": "osu_id", "label": "OSU-ID", "width": 200},
            {"column": "media_type", "label": "Media Type", "width": 160},
            {"column": "size_bytes", "label": "File Size", "width": 110, "format": "bytes"},
            {"column": "moratorium", "label": "Moratorium", "width": 110},
        ],
        subtitle="description",
    ),
}

CARDS_BY_NODE = {"ERDA": ERDA_CARDS, "OSU-MGR": OSU_MGR_CARDS}


class RecordCardsPlugin(FiestaPlugin):
    name = "record-cards"

    def frontend_config(self, node: NodeConfig) -> dict:
        cards = CARDS_BY_NODE.get(node.node.key, {})
        # A card for a table the node's data model does not have would render an
        # empty card forever — catch the typo at startup instead.
        model = node.load_data_model(node.data_model.latest)
        unknown = sorted(set(cards) - set(model["tables"]))
        if unknown:
            raise ValueError(
                f"record-cards: node {node.node.key!r} has no tables {unknown} to card"
            )
        return {"cards": cards}
