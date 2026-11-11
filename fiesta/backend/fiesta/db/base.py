from sqlalchemy.orm import DeclarativeBase

# Schema placeholders. Models are declared against these two tokens and the
# engine maps them per node at execution time (schema_translate_map):
#   NODE_SCHEMA   -> the node's slug (magic, cdr, karar, ...): contribution
#                    workflow tables, one schema per node so a node's
#                    developers can be granted access to just their node.
#   SHARED_SCHEMA -> settings.db_shared_schema: user accounts, shared across
#                    nodes (one EarthRef login).
NODE_SCHEMA = "node"
SHARED_SCHEMA = "shared"


def schema_translate_map(node_slug: str | None, shared_schema: str) -> dict[str | None, str]:
    """The map handed to the engine. Without a node (public-API health check,
    account creation) only the shared schema resolves; touching a node table
    then fails loudly instead of silently reading another node."""
    mapping: dict[str | None, str] = {SHARED_SCHEMA: shared_schema}
    if node_slug:
        mapping[NODE_SCHEMA] = node_slug
    return mapping


class Base(DeclarativeBase):
    pass
