import os

import sentry_sdk
from fastapi import FastAPI, status
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.routing import APIRoute
from starlette.middleware.cors import CORSMiddleware

from app.api.main import api_router
from app.core.config import settings


def custom_generate_unique_id(route: APIRoute) -> str:
    return f"{route.tags[0]}-{route.name}"


if settings.SENTRY_DSN and settings.ENVIRONMENT != "local":
    sentry_sdk.init(dsn=str(settings.SENTRY_DSN), enable_tracing=True)

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url="/openapi.json",
    favicon_url="favicon.ico",
    docs_url=None,
    redoc_url=None,
    version=settings.API_VERSION_PREFIX,
    description="""
E-mail: webmaster@earthref.org
License: Apache 2.0
This is the documentation for the OpenAPI definition of EarthRef.org's FIESTA
API.

EarthRef.org is a geoscience umbrella website for several data repositories.
These repositories, unified under the mandate to preserve their respective
data and promote scientific collaboration in their fields, are also disparate
in their schemata. The Framework for Integrated Earth Science and Technology
Applications (FIESTA) project is creating the tools to easily customize and
manage these geoscience repositories and the FIESTA API is a core component
of that solution.

""",
)

# Set all CORS enabled origins
if settings.BACKEND_CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            str(origin).strip("/") for origin in settings.BACKEND_CORS_ORIGINS
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    dirname = os.path.abspath(os.path.join(os.path.dirname(os.path.realpath(__file__))))
    return FileResponse(f"{dirname}/favicon.ico")


@app.get("/", include_in_schema=False)
async def docs():
    return RedirectResponse("/docs", status_code=status.HTTP_302_FOUND)


@app.get("/docs", include_in_schema=False)
async def api_documentation():
    return HTMLResponse(
        """
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
    <title>FIESTA API</title>

    <script src="https://unpkg.com/@stoplight/elements/web-components.min.js"></script>
    <link rel="stylesheet" href="https://unpkg.com/@stoplight/elements/styles.min.css">
    <style type="text/css">
        a[href*="stoplight.io"] {
            display: none;
        }
        div.
    </style>
  </head>
  <body>
    <div style="height: 100vh">
        <elements-api
            apiDescriptionUrl="openapi.json"
            router="hash"
            hideSchemas="true"
            layout="responsive"
            logo="favicon.ico"
        />
    </div>
  </body>
</html>
"""
    )


app.include_router(api_router, prefix=settings.API_VERSION_PREFIX)
