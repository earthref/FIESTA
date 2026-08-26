"""`digital-objects` plugin (ERDA).

ERDA archives digital objects — a spreadsheet, a poster, a video, a program —
rather than measurements, so the default MagIC-shaped result card (geologic
classes, lithologies, method codes, intensities) has nothing to show for it.
This plugin has no backend behavior of its own: it only tells the SPA which
search levels carry objects and files and which columns belong on their
cards, so the card layout stays data-driven instead of hard-coded per node.
"""

from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin

# Cells rendered on an object card, in order. `width` is the legacy
# fixed-width result cell in px; `format` names a value formatter in the UI.
OBJECT_CELLS = [
    {"column": "data_types", "label": "Data Types", "width": 150},
    {"column": "expert_level", "label": "Expert Level", "width": 170},
    {"column": "keywords", "label": "Keywords", "width": 200},
    {"column": "computer_program", "label": "Computer Program", "width": 150},
    {"column": "project", "label": "Project", "width": 180},
    {"column": "locations", "label": "Locations", "width": 180},
]

FILE_CELLS = [
    {"column": "format", "label": "Format", "width": 90},
    {"column": "media_type", "label": "Media Type", "width": 180},
    {"column": "size_bytes", "label": "File Size", "width": 110, "format": "bytes"},
]


class DigitalObjectsPlugin(FiestaPlugin):
    name = "digital-objects"

    def frontend_config(self, node: NodeConfig) -> dict:
        return {
            "object_table": "objects",
            "object_title_column": "title",
            "file_table": "files",
            "file_title_column": "file",
            "object_cells": OBJECT_CELLS,
            "file_cells": FILE_CELLS,
        }
