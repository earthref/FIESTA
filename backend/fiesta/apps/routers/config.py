from fastapi import APIRouter, HTTPException

from fiesta.apps.deps import NodeDep
from fiesta.plugins import active_plugins

router = APIRouter(prefix="/config", tags=["config"])


@router.get("")
async def get_config(node: NodeDep) -> dict:
    config = node.public_config()
    # Plugins may contribute extra search tabs and per-plugin UI options.
    plugins = active_plugins(node)
    config["search_levels"] += [
        lvl.model_dump() for plugin in plugins for lvl in plugin.search_levels(node)
    ]
    config["plugins"] = {plugin.name: plugin.frontend_config(node) for plugin in plugins}
    return config


@router.get("/data-models/{version}")
async def get_data_model(node: NodeDep, version: str) -> dict:
    try:
        return node.load_data_model(version)
    except KeyError:
        raise HTTPException(404, f"unknown data model version {version!r}") from None


@router.get("/vocabularies/controlled")
async def get_controlled_vocabularies(node: NodeDep) -> dict:
    return node.load_controlled_vocabularies()


@router.get("/vocabularies/suggested")
async def get_suggested_vocabularies(node: NodeDep) -> dict:
    return node.load_suggested_vocabularies()


@router.get("/method-codes")
async def get_method_codes(node: NodeDep) -> dict:
    codes = node.load_method_codes()
    if codes is None:
        raise HTTPException(404, "this node has no method codes")
    return codes
