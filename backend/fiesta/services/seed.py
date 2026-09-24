"""Config-selected development fixtures, applied through the revision service."""

import asyncio
from pathlib import Path
from urllib.parse import urlparse

import yaml
from sqlalchemy import select

from fiesta.db.models import Contribution, Outbox, User, Workspace, WorkspaceMember
from fiesta.db.session import get_sessionmaker
from fiesta.security import hash_password
from fiesta.services.revisions import save_revision
from fiesta.settings import get_settings


def require_local(settings=None):
    settings = settings or get_settings()
    allowed = {"localhost", "127.0.0.1", "::1", "postgres", "opensearch", "rustfs"}
    urls = [settings.database_url, settings.opensearch_url, settings.s3_endpoint]
    if settings.environment != "development" or any(
        not url or urlparse(url).hostname not in allowed for url in urls
    ):
        raise ValueError("seed/reset requires development mode and local PG/OS/S3 endpoints")
    if settings.sqlalchemy_url.query:
        raise ValueError("development seed database URL must not override connection parameters")


def local_file(root: Path, relative: str):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f"fixture path escapes its directory or is missing: {relative}")
    return path


def load_seed(node):
    if not node.development.seed_manifest:
        raise ValueError(f"{node.node.slug} has no development.seed_manifest")
    manifest = local_file(node.base_dir, node.development.seed_manifest)
    value = yaml.safe_load(manifest.read_text())
    if value.get("version") != 1 or not value.get("contributions"):
        raise ValueError("seed manifest requires version: 1 and contributions")
    keys = set()
    for item in value["contributions"]:
        if item["key"] in keys:
            raise ValueError("duplicate seed key")
        keys.add(item["key"])
        for step in item["revisions"]:
            for path in step["files"].values():
                local_file(manifest.parent, path)
    return manifest.parent, value


async def settle_seed_events(node, keys):
    """Wait for seed events even when a running worker has claimed their rows."""
    from fiesta.services.outbox import drain

    completed = failed = 0
    async with asyncio.timeout(60):
        while True:
            result = await drain(node, limit=10000)
            completed += result["completed"]
            failed += result["failed"]
            async with get_sessionmaker(node.node.slug)() as session:
                pending = (
                    await session.execute(
                        select(Outbox.id)
                        .join(Contribution, Contribution.id == Outbox.contribution_id)
                        .where(Contribution.seed_key.in_(keys), Outbox.completed_at.is_(None))
                        .limit(1)
                    )
                ).scalar_one_or_none()
            if pending is None:
                return {"completed": completed, "failed": failed}
            if result["failed"]:
                raise RuntimeError(f"seed processing failed for {node.node.slug}: {result}")
            # SKIP LOCKED in drain can return no work while another worker is processing it.
            await asyncio.sleep(0.1)


async def seed_node(node):
    require_local()
    root, manifest = load_seed(node)
    created = skipped = 0
    async with get_sessionmaker(node.node.slug)() as session:
        users = {}
        for account in manifest["accounts"]:
            user = (
                await session.execute(select(User).where(User.email == account["email"]))
            ).scalar_one_or_none()
            if user is None:
                user = User(
                    email=account["email"],
                    name=account["name"],
                    password_hash=hash_password(account["password"]),
                    settings=account.get("settings", {}),
                )
                session.add(user)
                await session.flush()
            users[account["key"]] = user
        owner = users[manifest["workspace"]["owner"]]
        workspace = (
            await session.execute(
                select(Workspace).where(
                    Workspace.owner_id == owner.id, Workspace.name == manifest["workspace"]["name"]
                )
            )
        ).scalar_one_or_none()
        if workspace is None:
            workspace = Workspace(owner_id=owner.id, name=manifest["workspace"]["name"])
            session.add(workspace)
            await session.flush()
            for member in manifest["workspace"].get("members", []):
                session.add(
                    WorkspaceMember(
                        workspace_id=workspace.id,
                        user_id=users[member["user"]].id,
                        role=member["role"],
                    )
                )
        for item in manifest["contributions"]:
            existing = (
                await session.execute(
                    select(Contribution).where(Contribution.seed_key == item["key"])
                )
            ).scalar_one_or_none()
            if existing:
                skipped += 1
                continue
            user = users[item["owner"]]
            c = Contribution(
                node=node.node.slug,
                contributor_id=user.id,
                data_model_version=node.data_model.latest,
                workspace_id=workspace.id,
                seed_key=item["key"],
            )
            if previous_key := item.get("previous"):
                previous = (
                    await session.execute(
                        select(Contribution).where(Contribution.seed_key == previous_key)
                    )
                ).scalar_one()
                c.previous_id = previous.id
                c.version = previous.version + 1
            session.add(c)
            await session.flush()
            for ordinal, step in enumerate(item["revisions"]):
                await save_revision(
                    session,
                    node,
                    c,
                    user.id,
                    expected_revision=c.head_revision,
                    request_key=f"seed:{item['key']}:{ordinal}",
                    operation="seed",
                    files={n: local_file(root, p).read_bytes() for n, p in step["files"].items()},
                    canonical=step.get("canonical"),
                )
            await session.commit()
            created += 1
        await session.commit()
    keys = [item["key"] for item in manifest["contributions"]]
    await settle_seed_events(node, keys)
    # Publish only newly seeded, valid requested fixtures; never overwrite later developer edits.
    from fiesta.services.contributions import activate, latest_validation

    async with get_sessionmaker(node.node.slug)() as session:
        for item in manifest["contributions"]:
            if not item.get("published"):
                continue
            c = (
                await session.execute(
                    select(Contribution).where(Contribution.seed_key == item["key"])
                )
            ).scalar_one()
            from fiesta.db.models import Revision

            rev = await session.get(Revision, c.head_revision)
            if c.deleted_at or c.published_revision or rev.operation != "seed":
                continue
            report = await latest_validation(session, c.id)
            if report is None or not report.is_valid:
                raise ValueError(f"published seed {item['key']} failed validation")
            await activate(session, node, c)
    result = await settle_seed_events(node, keys)
    if result["failed"]:
        raise RuntimeError(f"seed processing failed: {result}")
    return {"created": created, "skipped": skipped, **result}
