"""The FIESTA API: one FastAPI process serving every node in the deployment.

/v2/{repository}/... is FIESTA's own API (what the SPA talks to); /v1 is the
legacy api.earthref.org contract kept unchanged for existing clients
(routers/v1.py). `{repository}` is a node key or slug in any case (MagIC,
magic). Node-less v2 routes: /v2/health-check, /v2/auth/*. The session and
NodeDep dependencies resolve the node from that path segment, so every
node-scoped router below is mounted once for all nodes."""

from contextlib import asynccontextmanager, suppress

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from fiesta.apps.deps import NodeDep, SessionDep
from fiesta.apps.routers import auth, config, private, search, v1, workspaces
from fiesta.nodeconfig import get_deployment
from fiesta.search.client import get_opensearch
from fiesta.settings import get_settings
from fiesta.storage import Storage


@asynccontextmanager
async def lifespan(app: FastAPI):
    from fiesta.jobs.app import get_job_app

    for node in get_deployment().node_list:
        await Storage.for_node(node).ensure_bucket()
    async with get_job_app().open_async():
        yield
    await get_opensearch().close()


def _require_plugin(name: str):
    """Router dependency: 404 unless the resolved node activates the plugin."""
    from fiesta.plugins import active_plugins

    async def check(node: NodeDep) -> None:
        if all(plugin.name != name for plugin in active_plugins(node)):
            raise HTTPException(404, f"plugin {name!r} is not enabled for {node.node.key}")

    return check


def create_app() -> FastAPI:
    deployment = get_deployment()
    settings = get_settings()
    app = FastAPI(
        title=deployment.title,
        version="1.0.0",
        license_info={"name": "MIT License", "url": "https://opensource.org/licenses/MIT"},
        lifespan=lifespan,
        root_path=settings.fastapi_root_path,
        docs_url="/v2/docs",
        openapi_url="/v2/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/v2/health-check", tags=["health"])
    async def health_check(session: SessionDep) -> dict:
        database = search = storage = False
        with suppress(Exception):
            await session.execute(text("SELECT 1"))
            database = True
        with suppress(Exception):
            search = bool(await get_opensearch().ping())
        with suppress(Exception):
            async with Storage.for_node(deployment.node_list[0]).client() as s3:
                await s3.list_buckets()
            storage = True
        return {
            "status": "ok" if database and search and storage else "degraded",
            "database": database,
            "search": search,
            "storage": storage,
            "repositories": sorted(n.node.key for n in deployment.node_list),
        }

    # The frozen legacy contract: its own YAML at /v1/openapi.yaml, Koa-style
    # error bodies, and nothing in the /v2 schema.
    v1.install(app)
    app.include_router(v1.router)

    app.include_router(auth.router, prefix="/v2")
    for router in (config.router, search.router, private.router, workspaces.router):
        app.include_router(router, prefix="/v2/{repository}")

    # Plugin routes: one mount per plugin active on any enabled node, guarded
    # per request so /v2/cdr/plugins/poles/... is a 404 while MagIC's works.
    # (Unknown plugin names in a node YAML fail here, at startup.)
    from fiesta.plugins import active_plugins

    mounted: set[str] = set()
    for node in deployment.node_list:
        for plugin in active_plugins(node):
            if plugin.name in mounted:
                continue
            mounted.add(plugin.name)
            plugin_router = plugin.build_router()
            if plugin_router is not None:
                app.include_router(
                    plugin_router,
                    prefix=f"/v2/{{repository}}/plugins/{plugin.name}",
                    tags=[f"plugin:{plugin.name}"],
                    dependencies=[Depends(_require_plugin(plugin.name))],
                )
    return app


# Run with: uvicorn fiesta.apps.api:create_app --factory
