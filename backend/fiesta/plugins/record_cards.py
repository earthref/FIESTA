"""`record-cards` plugin.

Some nodes publish *records* rather than measurements: an ERDA digital object,
an OSU-MGR core or rock. The default result card is measurement-shaped
(geologic classes, lithologies, method codes, intensities) and has nothing to
show for them. This plugin has no behavior of its own — its options tell the
SPA, per search table, which column titles the card and which columns become
cells (`plugins.record-cards.cards` in the node YAML), so the layout stays
data-driven instead of hard-coded per node.
"""

from typing import Literal

from pydantic import BaseModel, Field

from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin, PluginOptions


class Cell(BaseModel):
    """One value cell on a card. `width` is the legacy fixed-width result cell
    in px; `format` names a value formatter in the UI (currently only "bytes")."""

    column: str
    label: str
    width: int = Field(default=120, ge=40)
    format: Literal["bytes"] | None = None


class Card(BaseModel):
    title_column: str
    subtitle_column: str | None = None
    cells: list[Cell] = []


class RecordCardsOptions(PluginOptions):
    cards: dict[str, Card] = Field(
        default={},
        description="Result card layout per search table: the title column, an optional "
        "subtitle column and the columns shown as cells",
    )


class RecordCardsPlugin(FiestaPlugin):
    name = "record-cards"
    description = (
        "Result cards for record-shaped tables (digital objects, cores, cruises): a "
        "title, a subtitle and the columns you choose, instead of the measurement card."
    )
    Options = RecordCardsOptions

    def check(self, node: NodeConfig, options: PluginOptions) -> None:
        # A card for a table (or column) the node's data model does not have
        # would render an empty card forever — catch the typo before publishing.
        assert isinstance(options, RecordCardsOptions)
        tables = node.load_data_model(node.data_model.latest)["tables"]
        unknown = sorted(set(options.cards) - set(tables))
        if unknown:
            raise ValueError(f"plugin 'record-cards': the data model has no tables {unknown}")
        for table, card in options.cards.items():
            columns = tables[table].get("columns", {})
            wanted = [card.title_column, card.subtitle_column, *(c.column for c in card.cells)]
            if missing := [c for c in wanted if c and c not in columns]:
                raise ValueError(
                    f"plugin 'record-cards': {table} card names columns {missing} "
                    f"the table does not have"
                )

    def frontend_config(self, node: NodeConfig) -> dict:
        return self.options(node).model_dump(exclude_none=True)
