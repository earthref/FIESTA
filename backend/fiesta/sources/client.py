"""The FIESTA API as a data-source sync script sees it: `/v2/{node}/source`."""

import json

import httpx

from fiesta.services.legacy import SourceRecord


class SourceAPIError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"{status}: {detail}")
        self.status = status
        self.detail = detail


def _raise_for(response: httpx.Response) -> None:
    if response.is_success:
        return
    try:
        detail = response.json().get("detail", response.text)
    except ValueError:
        detail = response.text
    raise SourceAPIError(response.status_code, str(detail))


class SourceAPI:
    """A node admin's session on one node of a FIESTA API (BASE_URL serves /v2)."""

    def __init__(self, base_url: str, node: str, *, timeout: float = 600, transport=None):
        self.base_url = base_url.rstrip("/")
        self.node = node
        self.http = httpx.AsyncClient(
            base_url=f"{self.base_url}/v2", timeout=timeout, transport=transport
        )

    async def login(self, email: str, password: str) -> None:
        response = await self.http.post(
            "/auth/login", data={"username": email, "password": password}
        )
        _raise_for(response)
        self.http.headers["Authorization"] = f"Bearer {response.json()['access_token']}"

    async def state(self) -> dict:
        """{"mode", "source_id", "checkpoints": {"<id>": "<fingerprint>"}}."""
        response = await self.http.get(f"/{self.node}/source/checkpoints")
        _raise_for(response)
        return response.json()

    async def report_run(self, report: dict) -> None:
        """{started_at, finished_at, ok, trigger, summary}: shown on the admin page."""
        response = await self.http.post(
            f"/{self.node}/source/runs",
            content=json.dumps(report, default=str),
            headers={"Content-Type": "application/json"},
        )
        _raise_for(response)

    async def put_record(
        self, record: SourceRecord, files: dict[str, bytes], owner: dict | None = None
    ) -> dict:
        """FILES are keyed `<revision key>/<file name>`; OWNER is the owner's
        account fields, so the API can create a missing account."""
        data = {"record": record.model_dump_json()}
        if owner is not None:
            data["owner"] = json.dumps(owner)
        response = await self.http.put(
            f"/{self.node}/source/records/{record.id}",
            data=data,
            files=[(key, (key.rpartition("/")[2], body)) for key, body in files.items()],
        )
        _raise_for(response)
        return response.json()

    async def close(self) -> None:
        await self.http.aclose()
