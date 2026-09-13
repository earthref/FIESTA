"""Run with FIESTA_INTEGRATION=1 against the isolated Compose services.

Uses unique contribution records; never points at a production configuration.
"""

import asyncio
import json
import os
import uuid

import httpx
import pytest
from sqlalchemy import select

pytestmark = pytest.mark.skipif(
    os.getenv("FIESTA_INTEGRATION") != "1", reason="requires isolated Docker integration stack"
)


@pytest.mark.asyncio
async def test_seed_waits_for_claimed_event(monkeypatch):
    from fiesta.db.models import Contribution, Outbox
    from fiesta.db.session import get_engine, get_sessionmaker
    from fiesta.nodeconfig import get_deployment
    from fiesta.search.client import get_opensearch
    from fiesta.services import outbox
    from fiesta.services.seed import require_local, settle_seed_events

    require_local()
    node = get_deployment().public_api.node_for("cdr")
    sessions = get_sessionmaker(node.node.slug)
    async with sessions() as session:
        contribution = (
            await session.execute(select(Contribution).where(Contribution.seed_key == "public-v2"))
        ).scalar_one()
        event = Outbox(
            contribution_id=contribution.id, revision_id=contribution.head_revision, kind="index"
        )
        session.add(event)
        await session.flush()
        event_id = event.id
        await session.commit()

    drained = asyncio.Event()
    original_drain = outbox.drain

    async def observed_drain(*args, **kwargs):
        result = await original_drain(*args, **kwargs)
        drained.set()
        return result

    monkeypatch.setattr(outbox, "drain", observed_drain)
    task = None
    try:
        async with sessions() as worker:
            await worker.execute(select(Outbox).where(Outbox.id == event_id).with_for_update())
            task = asyncio.create_task(settle_seed_events(node, ["public-v2"]))
            await asyncio.wait_for(drained.wait(), timeout=5)
            await asyncio.sleep(0.2)
            assert not task.done(), "seed must wait even when drain skips a claimed event"
            await worker.commit()
        result = await asyncio.wait_for(task, timeout=10)
        assert result["completed"] == 1
        assert result["failed"] == 0
    finally:
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await get_opensearch().close()
        await get_engine().dispose()
        get_opensearch.cache_clear()
        get_engine.cache_clear()
        get_sessionmaker.cache_clear()


@pytest.mark.asyncio
async def test_revision_workflow_and_migration(tmp_path, monkeypatch):
    from fiesta.apps.public import create_app
    from fiesta.db.models import Contribution, User
    from fiesta.db.session import get_engine, get_sessionmaker
    from fiesta.nodeconfig import get_deployment
    from fiesta.search.client import get_opensearch
    from fiesta.services.contributions import latest_validation
    from fiesta.services.legacy import sync_inventory
    from fiesta.services.outbox import drain
    from fiesta.services.rebuild import rebuild_node
    from fiesta.services.revisions import digest
    from fiesta.services.seed import require_local

    require_local()
    node = get_deployment().public_api.node_for("magic")
    app = create_app()
    raw = (node.base_dir / "magic/seeds/valid.txt").read_text()
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://local"
        ) as client,
    ):
        login = await client.post(
            "/v1/auth/login",
            data={"username": "developer@example.test", "password": "local-fiesta-only"},
        )
        assert login.status_code == 200, login.text
        client.headers["Authorization"] = "Bearer " + login.json()["access_token"]
        root = "/v1/magic/private/contributions"
        c = (await client.post(root)).json()
        path = f"{root}/{c['id']}"
        edit = {"expected_revision": None, "request_key": str(uuid.uuid4()), "text": raw}
        first = await client.put(path + "/content", json=edit)
        assert first.status_code == 200, first.text
        head = first.json()["head_revision"]
        assert (await client.put(path + "/content", json=edit)).json()["head_revision"] == head
        altered = {**edit, "text": raw + "\n"}
        assert (await client.put(path + "/content", json=altered)).status_code == 409
        assert (
            await client.put(path + "/content", json={**edit, "request_key": str(uuid.uuid4())})
        ).status_code == 409

        # Competing saves sharing the same base revision: exactly one succeeds.
        saves = await asyncio.gather(
            *[
                client.put(
                    path + "/content",
                    json={
                        "expected_revision": head,
                        "request_key": str(uuid.uuid4()),
                        "text": raw + "\n" * i,
                    },
                )
                for i in [1, 2]
            ]
        )
        assert sorted(r.status_code for r in saves) == [200, 409]
        c = next(r.json() for r in saves if r.status_code == 200)
        upload = await client.put(
            path + "/attachments/note.txt",
            files={"file": ("note.txt", b"note")},
            headers={"If-Match": c["head_revision"], "Idempotency-Key": str(uuid.uuid4())},
        )
        assert upload.status_code == 200, upload.text
        c = upload.json()
        assert (await client.get(path + "/attachments/note.txt")).content == b"note"
        restored = await client.post(
            path + f"/revisions/{head}/restore",
            json={"expected_revision": c["head_revision"], "request_key": str(uuid.uuid4())},
        )
        assert restored.status_code == 200, restored.text
        c = restored.json()
        assert (await client.get(path + "/attachments")).json() == []
        assert (
            await client.get(
                path + "/attachments/note.txt",
                params={"revision_id": upload.json()["head_revision"]},
            )
        ).content == b"note"

        # Search outage leaves validation and saves durable; replay recovers indexing.
        search = get_opensearch()
        original_exists = search.indices.exists

        async def unavailable(**kwargs):
            raise ConnectionError("simulated search outage")

        monkeypatch.setattr(search.indices, "exists", unavailable)
        result = await drain(node)
        assert result["failed"] > 0
        async with get_sessionmaker("magic")() as session:
            validation = await latest_validation(session, c["id"])
            assert validation.is_valid
            assert validation.revision_id == c["head_revision"]
        assert (await client.get(root)).status_code == 200
        assert (await client.put("/v1/auth/settings", json={"theme": "dark"})).status_code == 200
        assert (await client.post(path + "/activate")).status_code == 200
        monkeypatch.setattr(search.indices, "exists", original_exists)
        assert (await drain(node))["failed"] == 0
        # Private links remain usable, while workspace membership does not disclose them.
        key = c["private_key"]
        keyed = await client.get(
            "/v1/magic/search/contribution", params={"query": f'private_key:"{key}"'}
        )
        assert keyed.status_code == 200 and keyed.json()["total"] == 1

        assert (
            await client.put(
                path + "/content",
                json={
                    "expected_revision": c["head_revision"],
                    "request_key": str(uuid.uuid4()),
                    "text": raw,
                },
            )
        ).status_code == 409

        # Withdrawal is enforced before search totals/facets despite a stale index.
        assert (await client.post(path + "/deactivate")).status_code == 200
        response = await client.get(
            "/v1/magic/search/contribution", params={"query": f'id:"{c["id"]}"'}
        )
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 0
        assert (await client.get(f"/v1/magic/data/{c['id']}")).status_code == 404
        new = await client.post(path + "/versions")
        assert new.status_code == 201, new.text
        assert new.json()["previous_id"] == c["id"]
        assert (await client.post(f"{root}/{new.json()['id']}/activate")).status_code == 409

        # Shared viewers can inspect but cannot save or change membership.
        workspace = (await client.post("/v1/magic/workspaces", json={"name": "integration"})).json()
        assert (
            await client.put(
                f"/v1/magic/workspaces/{workspace['id']}/contributions/{new.json()['id']}"
            )
        ).status_code == 200
        async with get_sessionmaker("magic")() as session:
            viewer = (
                await session.execute(select(User).where(User.email == "viewer@example.test"))
            ).scalar_one()
            viewer_id = viewer.id
        assert (
            await client.put(
                f"/v1/magic/workspaces/{workspace['id']}/members",
                json={"user_id": viewer_id, "role": "viewer"},
            )
        ).status_code == 200
        viewer_login = (
            await client.post(
                "/v1/auth/login",
                data={"username": "viewer@example.test", "password": "local-fiesta-only"},
            )
        ).json()
        viewer_headers = {"Authorization": "Bearer " + viewer_login["access_token"]}
        newpath = f"{root}/{new.json()['id']}"
        assert (await client.get(newpath + "/content", headers=viewer_headers)).status_code == 200
        assert (await client.get(newpath, headers=viewer_headers)).json()["private_key"] is None

        assert (
            await client.put(
                newpath + "/content",
                headers=viewer_headers,
                json={
                    "expected_revision": new.json()["head_revision"],
                    "request_key": str(uuid.uuid4()),
                    "text": raw,
                },
            )
        ).status_code == 404

        # Index rebuild preserves accounts, settings and revision heads.
        async with get_sessionmaker("magic")() as session:
            before = (await session.get(Contribution, c["id"])).head_revision
            result = await rebuild_node(session, node)
            assert result["indexed"] > 0
            assert (await session.get(Contribution, c["id"])).head_revision == before
        assert (await client.get("/v1/auth/settings")).json() == {"theme": "dark"}

        # Inventory verification, repeat sync, metadata changes, and edit conflict.
        legacy_id = 100000 + int(uuid.uuid4().hex[:5], 16)
        (tmp_path / "source.txt").write_text(raw)
        record = {
            "id": legacy_id,
            "owner_email": "developer@example.test",
            "created_at": "2020-01-01T00:00:00Z",
            "published": False,
            "revisions": [
                {
                    "key": "1",
                    "canonical": "source.txt",
                    "timestamp": "2020-01-01T00:00:00Z",
                    "files": {
                        "source.txt": {"source": "source.txt", "sha256": digest(raw.encode())}
                    },
                }
            ],
        }
        inventory = {
            "format": 1,
            "node": "magic",
            "source_id": str(uuid.uuid4()),
            "records": [record],
        }
        manifest = tmp_path / "inventory.json"
        manifest.write_text(json.dumps(inventory))
        assert (await sync_inventory(node, manifest))["planned"] == 1
        result = await sync_inventory(node, manifest, apply=True)
        assert result["applied"] == 1, result
        assert (await sync_inventory(node, manifest, apply=True))["unchanged"] == 1
        record["deleted"] = True
        manifest.write_text(json.dumps(inventory))
        assert (await sync_inventory(node, manifest, apply=True))["applied"] == 1
        assert (await client.get(f"{root}/{legacy_id}")).status_code == 404

        # Restore a source tombstone, then ingest a version-pinned S3 update.
        from fiesta.storage import Storage

        bucket = "legacy-test-" + uuid.uuid4().hex
        source = Storage(bucket)
        await source.ensure_bucket()
        async with source.client() as s3:
            await s3.put_bucket_versioning(
                Bucket=bucket, VersioningConfiguration={"Status": "Enabled"}
            )
            await s3.put_object(Bucket=bucket, Key="source.txt", Body=raw.encode())
            updated = raw + "\n"
            result = await s3.put_object(Bucket=bucket, Key="updated.txt", Body=updated.encode())
            # A later overwrite must not change the pinned import revision.
            await s3.put_object(Bucket=bucket, Key="updated.txt", Body=b"wrong version")
        inventory["source_bucket"] = bucket
        record["deleted"] = False
        record["revisions"].append(
            {
                "key": "2",
                "canonical": "source.txt",
                "timestamp": "2020-01-02T00:00:00Z",
                "files": {
                    "source.txt": {
                        "source": "updated.txt",
                        "sha256": digest(updated.encode()),
                        "version_id": result["VersionId"],
                    }
                },
            }
        )
        manifest.write_text(json.dumps(inventory))
        result = await sync_inventory(node, manifest, apply=True)
        assert result["applied"] == 1, result
        imported = (await client.get(f"{root}/{legacy_id}/content")).json()
        assert imported["text"] == updated
        assert (
            await client.put(
                f"{root}/{legacy_id}/content",
                json={
                    "expected_revision": imported["revision_id"],
                    "request_key": str(uuid.uuid4()),
                    "text": raw + "\n\n",
                },
            )
        ).status_code == 200
        record["latest"] = False
        manifest.write_text(json.dumps(inventory))
        result = await sync_inventory(node, manifest, apply=True)
        assert result["applied"] == 0 and result["errors"], result
        assert "FIESTA edits" in result["errors"][0]["error"]

        # Seeding preserves developer revisions and settings.
        from fiesta.services.seed import seed_node

        async with get_sessionmaker("magic")() as session:
            seed_draft = (
                await session.execute(select(Contribution).where(Contribution.seed_key == "draft"))
            ).scalar_one()
            draft_id, draft_head = seed_draft.id, seed_draft.head_revision
        changed = await client.put(
            f"{root}/{draft_id}/content",
            json={
                "expected_revision": draft_head,
                "request_key": str(uuid.uuid4()),
                "text": raw + "\n",
            },
        )
        assert changed.status_code == 200
        await seed_node(node)
        assert (await client.get(f"{root}/{draft_id}")).json()["head_revision"] == changed.json()[
            "head_revision"
        ]
        assert (await client.get("/v1/auth/settings")).json() == {"theme": "dark"}

    await get_opensearch().close()
    await get_engine().dispose()


@pytest.mark.asyncio
async def test_real_worker_process(tmp_path):
    """Exercise the actual worker/outbox subprocess rather than invoking drain."""
    import sys

    from fiesta.apps.public import create_app
    from fiesta.db.session import get_engine, get_sessionmaker
    from fiesta.search.client import get_opensearch
    from fiesta.services.seed import require_local

    require_local()
    get_opensearch.cache_clear()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()
    app = create_app()
    with (tmp_path / "worker.log").open("w+") as log:
        worker = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "fiesta.cli", "worker", stdout=log, stderr=log
        )
        try:
            async with (
                app.router.lifespan_context(app),
                httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://local"
                ) as client,
            ):
                login = await client.post(
                    "/v1/auth/login",
                    data={"username": "developer@example.test", "password": "local-fiesta-only"},
                )
                client.headers["Authorization"] = "Bearer " + login.json()["access_token"]
                c = (await client.post("/v1/cdr/private/contributions")).json()
                base = f"/v1/cdr/private/contributions/{c['id']}"
                from fiesta.nodeconfig import get_deployment

                node = get_deployment().public_api.node_for("cdr")
                raw = (node.base_dir / "cdr/seeds/valid.txt").read_bytes()
                response = await client.put(
                    base + "/file",
                    files={"file": ("input.txt", raw)},
                    headers={"Idempotency-Key": str(uuid.uuid4())},
                )
                assert response.status_code == 200, response.text
                for _ in range(60):
                    response = await client.get(base)
                    if response.json()["indexing_status"] == "indexed":
                        break
                    assert worker.returncode is None, "worker exited"
                    await asyncio.sleep(0.5)
                assert response.json()["status"] == "ready", response.text
                assert response.json()["indexing_status"] == "indexed", response.text
                assert (await client.get(base + "/validation")).json()["is_valid"]
        finally:
            worker.terminate()
            try:
                await asyncio.wait_for(worker.wait(), timeout=10)
            except TimeoutError:
                worker.kill()
                await worker.wait()
    await get_opensearch().close()
    await get_engine().dispose()
