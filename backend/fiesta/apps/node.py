"""Node backend app (deployment: node) — serves one FIESTA node under /api."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from fiesta.apps.routers import auth, config, health, private, search
from fiesta.jobs.app import get_job_app
from fiesta.nodeconfig import get_node
from fiesta.search.client import get_opensearch
from fiesta.search.index import ensure_index
from fiesta.settings import get_settings
from fiesta.storage import Storage


@asynccontextmanager
async def lifespan(app: FastAPI):
    node = get_node()
    await Storage.for_node(node).ensure_bucket()
    await ensure_index(get_opensearch(), node.search_index)
    async with get_job_app().open_async():
        yield
    await get_opensearch().close()


def create_app() -> FastAPI:
    node = get_node()
    app = FastAPI(
        title=f"FIESTA — {node.node.title}",
        version="0.1.0",
        license_info={"name": "MIT License", "url": "https://opensource.org/licenses/MIT"},
        lifespan=lifespan,
        root_path=get_settings().fastapi_root_path,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    for router in (health.router, config.router, auth.router, search.router, private.router):
        app.include_router(router, prefix="/api")
    # Node-specific plugin routes (fails at startup on unknown plugin names).
    from fiesta.plugins import active_plugins

    for plugin in active_plugins(node):
        plugin_router = plugin.build_router(node)
        if plugin_router is not None:
            app.include_router(
                plugin_router, prefix=f"/api/plugins/{plugin.name}", tags=[f"plugin:{plugin.name}"]
            )
    return app


# Run with: uvicorn fiesta.apps.node:create_app --factory
