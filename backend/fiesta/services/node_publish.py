"""Write a published node revision to the repository (FIESTA_CONFIG_PUBLISH).

"files":  into the directory of FIESTA_CONFIG_FILE -- this checkout's
          config/, for a local stack; commit it like any other change.
"github": a commit on the branch node-config/<slug> of FIESTA_GITHUB_REPO and
          a pull request into FIESTA_GITHUB_BASE_BRANCH (reused while it stays
          open, so successive publications accumulate on one PR). CI validates
          the YAML like any other change; merging it is what lets developers
          without database access build against the live configuration.

Either way the written tree is byte-identical to the published revision, so
the next `fiesta init` recognises it and imports nothing.
"""

import base64
import hashlib
import logging
import os
import re
from pathlib import Path

import httpx

from fiesta.db.models import NodeRecord, NodeRevision
from fiesta.services.node_config import load_files, read_tree
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"


def add_to_deployment_yaml(text: str, filename: str) -> str | None:
    """fiesta.yaml with `- <filename>` appended to its node list, keeping the
    file's comments; None if it is already listed."""
    if re.search(rf"^[ \t]*-[ \t]*{re.escape(filename)}[ \t]*(#.*)?$", text, re.M):
        return None
    entries = list(re.finditer(r"^([ \t]*)-[ \t]*\S+\.yaml[ \t]*(#.*)?$", text, re.M))
    if not entries:
        raise ValueError("fiesta.yaml has no node list to add to")
    last = entries[-1]
    return f"{text[: last.end()]}\n{last.group(1)}- {filename}{text[last.end() :]}"


def write_files(config_dir: Path, slug: str, files: dict[str, bytes]) -> str:
    """Make config_dir hold exactly this tree for the node; returns what changed."""
    on_disk = read_tree(config_dir, slug) if (config_dir / f"{slug}.yaml").exists() else {}
    owner = config_dir.stat()
    changed = []

    def own(path: Path) -> None:
        # A container writing into a bind-mounted checkout runs as root; give
        # the files to whoever owns the checkout.
        if os.geteuid() == 0:
            os.chown(path, owner.st_uid, owner.st_gid)

    for rel in sorted(set(on_disk) - set(files)):
        (config_dir / rel).unlink()
        changed.append(f"-{rel}")
    for rel, content in files.items():
        if on_disk.get(rel) == content:
            continue
        path = config_dir / rel
        for parent in reversed(path.relative_to(config_dir).parents[:-1]):
            if not (config_dir / parent).exists():
                (config_dir / parent).mkdir()
                own(config_dir / parent)
        path.write_bytes(content)
        own(path)
        changed.append(rel)
    deployment_file = config_dir / get_settings().config_file.name
    updated = add_to_deployment_yaml(deployment_file.read_text(), f"{slug}.yaml")
    if updated is not None:
        deployment_file.write_text(updated)
        changed.append(deployment_file.name)
    return ", ".join(changed) or "no changes"


def blob_sha(content: bytes) -> str:
    """The object id git gives a blob, to skip uploading unchanged files."""
    return hashlib.sha1(b"blob %d\0" % len(content) + content, usedforsecurity=False).hexdigest()


async def write_github(
    record: NodeRecord, revision: NodeRevision, files: dict[str, bytes], author: str
) -> str:
    """Commit the tree onto node-config/<slug> and make sure a PR is open;
    returns the PR URL."""
    settings = get_settings()
    if not settings.github_token:
        raise RuntimeError("FIESTA_GITHUB_TOKEN is not set")
    repo, base = settings.github_repo, settings.github_base_branch
    prefix = settings.github_config_path.strip("/")
    branch = f"node-config/{record.slug}"
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(
        base_url=f"{GITHUB_API}/repos/{repo}/", headers=headers, timeout=60
    ) as gh:

        async def call(method: str, url: str, **kwargs) -> dict | list:
            response = await gh.request(method, url, **kwargs)
            response.raise_for_status()
            return response.json()

        owner = repo.split("/")[0]
        prs = await call("GET", "pulls", params={"head": f"{owner}:{branch}", "state": "open"})
        head = (await call("GET", f"git/ref/heads/{branch if prs else base}"))["object"]["sha"]
        root_tree = (await call("GET", f"git/commits/{head}"))["tree"]["sha"]

        # The config directory's tree, recursively: the repository's root tree
        # is too large to list whole.
        config_tree = root_tree
        for segment in prefix.split("/"):
            entries = (await call("GET", f"git/trees/{config_tree}"))["tree"]
            config_tree = next(e["sha"] for e in entries if e["path"] == segment)
        listing = await call("GET", f"git/trees/{config_tree}", params={"recursive": "1"})
        existing = {e["path"]: e["sha"] for e in listing["tree"] if e["type"] == "blob"}

        changes = []
        for rel, content in sorted(files.items()):
            if existing.get(rel) == blob_sha(content):
                continue
            blob = await call(
                "POST",
                "git/blobs",
                json={"content": base64.b64encode(content).decode(), "encoding": "base64"},
            )
            changes.append(
                {"path": f"{prefix}/{rel}", "mode": "100644", "type": "blob", "sha": blob["sha"]}
            )
        for rel in existing:
            if rel.startswith(f"{record.slug}/") and rel not in files:
                changes.append(
                    {"path": f"{prefix}/{rel}", "mode": "100644", "type": "blob", "sha": None}
                )
        deployment_name = settings.config_file.name
        if deployment_name in existing:
            blob = await call("GET", f"git/blobs/{existing[deployment_name]}")
            updated = add_to_deployment_yaml(
                base64.b64decode(blob["content"]).decode(), f"{record.slug}.yaml"
            )
            if updated is not None:
                changes.append(
                    {
                        "path": f"{prefix}/{deployment_name}",
                        "mode": "100644",
                        "type": "blob",
                        "content": updated,
                    }
                )
        if not changes:
            return prs[0]["html_url"] if prs else f"already on {base}"

        tree = await call("POST", "git/trees", json={"base_tree": root_tree, "tree": changes})
        title = f"{record.key}: node configuration r{revision.number}"
        paragraphs = [
            title,
            (revision.message or "").strip(),
            f"Published in the FIESTA admin UI by {author}.",
        ]
        commit = await call(
            "POST",
            "git/commits",
            json={
                "message": "\n\n".join(p for p in paragraphs if p),
                "tree": tree["sha"],
                "parents": [head],
            },
        )
        if prs:
            await call("PATCH", f"git/refs/heads/{branch}", json={"sha": commit["sha"]})
            return prs[0]["html_url"]
        # A branch left over from a merged or closed PR is reset onto base.
        response = await gh.post(
            "git/refs", json={"ref": f"refs/heads/{branch}", "sha": commit["sha"]}
        )
        if response.status_code == 422:
            await call(
                "PATCH", f"git/refs/heads/{branch}", json={"sha": commit["sha"], "force": True}
            )
        else:
            response.raise_for_status()
        pr = await call(
            "POST",
            "pulls",
            json={
                "title": f"{record.key}: node configuration published in the admin UI",
                "head": branch,
                "base": base,
                "body": (
                    f"Node configuration for **{record.key}** published in the FIESTA admin "
                    "UI. It is already live (Postgres is the source while it is edited); "
                    "merging this keeps `config/` in step for developers building locally. "
                    "Later publications are added to this PR while it is open.\n\n"
                    "🤖 Opened by FIESTA"
                ),
            },
        )
        if settings.github_pr_label:
            await call(
                "POST", f"issues/{pr['number']}/labels", json={"labels": [settings.github_pr_label]}
            )
        if settings.github_auto_merge:
            response = await gh.post(
                f"{GITHUB_API}/graphql",
                json={
                    "query": "mutation($id: ID!) { enablePullRequestAutoMerge(input: "
                    "{pullRequestId: $id, mergeMethod: MERGE}) { clientMutationId } }",
                    "variables": {"id": pr["node_id"]},
                },
            )
            if response.status_code != 200 or response.json().get("errors"):
                logger.warning("auto-merge not enabled on %s: %s", pr["html_url"], response.text)
        return pr["html_url"]


async def write_revision(revision_id: int) -> None:
    """Write one published revision to the repository and record the outcome
    on it. A revision superseded before its turn is skipped: the newer one
    carries the whole tree."""
    from fiesta.db.models import User
    from fiesta.db.session import get_sessionmaker

    mode = get_settings().config_publish
    async with get_sessionmaker(None)() as session:
        revision = await session.get(NodeRevision, revision_id)
        record = await session.get(NodeRecord, revision.node)
        if record.published_revision_id != revision.id:
            revision.repo_status = "skipped"
            revision.repo_error = "superseded before it was written"
        elif mode == "none":
            revision.repo_status = "skipped"
        else:
            files = await load_files(session, revision.files)
            try:
                if mode == "files":
                    config_dir = get_settings().config_file.resolve().parent
                    changed = write_files(config_dir, record.slug, files)
                    revision.repo_ref = f"{config_dir} ({changed})"
                elif mode == "github":
                    user = await session.get(User, revision.published_by)
                    author = f"{user.name} <{user.email}>" if user else "an admin"
                    revision.repo_ref = await write_github(record, revision, files, author)
                else:
                    raise RuntimeError(f"unknown FIESTA_CONFIG_PUBLISH {mode!r}")
                revision.repo_status = "written"
                revision.repo_error = None
            except Exception as exc:
                logger.exception(
                    "writing %s r%s to the repository failed", record.slug, revision.number
                )
                revision.repo_status = "failed"
                revision.repo_error = str(exc)[:2000]
        await session.commit()
