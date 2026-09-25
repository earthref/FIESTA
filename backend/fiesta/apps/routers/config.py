from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from fiesta.apps.deps import NodeDep
from fiesta.nodeconfig import get_deployment
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
    # Every node this API serves (keys): the SPA links its portal bar to their
    # instances next to itself when it is not on a production host.
    config["deployment_nodes"] = [n.node.key for n in get_deployment().node_list]
    return config


@router.get("/assets/{path:path}")
async def get_asset(node: NodeDep, path: str) -> FileResponse:
    """Static files a node's YAML refers to (news images, ...) from config/<slug>/assets/."""
    file = node.asset_path(path)
    if file is None:
        raise HTTPException(404, f"no asset {path!r}")
    return FileResponse(file, headers={"Cache-Control": "public, max-age=3600"})


@router.get("/pages/{slug}")
async def get_page(node: NodeDep, slug: str) -> dict:
    """A content page (`pages:` in the node YAML): its HTML from
    config/<node>/pages/<slug>.html. The SPA sanitizes it before rendering."""
    page = node.page(slug)
    if page is None:
        raise HTTPException(404, f"no page {slug!r}")
    return {**page.model_dump(), "html": node.load_page_html(slug)}


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
