"""Node configuration in Postgres: revisions, drafts, publication, and the
deployment this process serves.

A node's configuration is a file tree: `config/<slug>.yaml` plus everything
under `config/<slug>/` (data models, vocabularies, assets, seeds). Postgres
keeps every version of that tree as a NodeRevision over content-addressed
ConfigBlobs. Admins edit one draft per node; publishing it makes it the
revision the API serves (every process picks it up within REFRESH_SECONDS)
and writes the same files to the repository (fiesta.services.node_publish),
so developers without database access build against what is live.

`fiesta init` imports the repository's YAML as a published revision whenever
its tree is one Postgres has never published, so a change merged in git
reaches the live node too.
"""

import asyncio
import hashlib
import io
import json
import logging
import re
import shutil
import tempfile
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import yaml
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError

from fiesta.db.models import ConfigBlob, NodeRecord, NodeRevision
from fiesta.nodeconfig import (
    Deployment,
    NodeConfig,
    get_deployment,
    load_deployment,
    load_node_yaml,
    set_deployment,
)
from fiesta.settings import get_settings

logger = logging.getLogger(__name__)

REFRESH_SECONDS = 5.0
SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{1,31}$")
# Path segments /v2/<x>/ already used by node-less routes, and schemas a node
# may not claim.
RESERVED_SLUGS = {
    "admin",
    "auth",
    "docs",
    "health-check",
    "openapi.json",
    "public",
    "procrastinate",
    "information_schema",
    "default",
}
# Settings only a super admin may change on a published node: renaming a node
# or pointing it at another index / bucket / legacy source moves its data.
PROTECTED_SETTINGS = [
    ("node", "key"),
    ("node", "slug"),
    ("search", "index"),
    ("storage",),
    ("legacy",),
]


class ConfigError(Exception):
    """A tree that does not load as a node; `errors` are shown to the admin."""

    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


class Conflict(Exception):
    """The draft changed since the caller read it, or the operation needs a
    different draft state."""


def utcnow() -> datetime:
    return datetime.now(UTC)


def enabled() -> bool:
    return get_settings().node_config_source == "db"


# --- trees --------------------------------------------------------------------


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def tree_hash(manifest: dict[str, str]) -> str:
    return sha256("".join(f"{p}\0{manifest[p]}\n" for p in sorted(manifest)).encode())


def read_tree(config_dir: Path, slug: str) -> dict[str, bytes]:
    """`<slug>.yaml` and every file under `<slug>/`, keyed by posix path
    relative to the config directory."""
    files = {f"{slug}.yaml": (config_dir / f"{slug}.yaml").read_bytes()}
    root = config_dir / slug
    if root.is_dir():
        for path in sorted(root.rglob("*")):
            if path.is_file() and not path.name.startswith("."):
                files[path.relative_to(config_dir).as_posix()] = path.read_bytes()
    return files


def write_tree(target: Path, files: dict[str, bytes]) -> None:
    for rel, content in files.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def check_path(slug: str, path: str) -> str:
    """A path a node's tree may hold: its YAML or a file under `<slug>/`."""
    path = path.strip()
    parts = path.split("/")
    ok = (
        path == f"{slug}.yaml"
        or (len(parts) > 1 and parts[0] == slug and all(p and p not in (".", "..") for p in parts))
    ) and "\\" not in path
    if not ok:
        raise ConfigError([f"{path!r} is not {slug}.yaml or a file under {slug}/"])
    return path


def check_syntax(path: str, content: bytes) -> None:
    try:
        if path.endswith(".json"):
            json.loads(content)
        elif path.endswith((".yaml", ".yml")):
            yaml.safe_load(content)
    except (ValueError, yaml.YAMLError) as exc:
        raise ConfigError([f"{path}: {exc}"]) from None


def is_text(content: bytes) -> bool:
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


async def store_files(session, files: dict[str, bytes]) -> dict[str, str]:
    """Store blobs not yet in Postgres; returns {path: sha256}."""
    manifest = {path: sha256(content) for path, content in files.items()}
    by_sha = {manifest[path]: content for path, content in files.items()}
    if by_sha:
        have = set(
            (
                await session.execute(
                    select(ConfigBlob.sha256).where(ConfigBlob.sha256.in_(by_sha))
                )
            ).scalars()
        )
        for sha, content in by_sha.items():
            if sha not in have:
                await session.execute(
                    pg_insert(ConfigBlob)
                    .values(sha256=sha, content=content)
                    .on_conflict_do_nothing()
                )
    return manifest


async def load_files(session, manifest: dict[str, str]) -> dict[str, bytes]:
    rows = (
        await session.execute(
            select(ConfigBlob).where(ConfigBlob.sha256.in_(set(manifest.values())))
        )
    ).scalars()
    by_sha = {row.sha256: row.content for row in rows}
    missing = sorted(p for p, h in manifest.items() if h not in by_sha)
    if missing:
        raise RuntimeError(f"config blobs missing for {missing}")
    return {path: by_sha[h] for path, h in manifest.items()}


def _cache_root(slug: str, digest: str) -> Path:
    return get_settings().node_cache_dir / slug / digest


def materialize(slug: str, digest: str, files: dict[str, bytes]) -> Path:
    """Unpack a tree under node_cache_dir/<slug>/<tree hash>/ (once; a tree
    never changes under its hash) and return that directory."""
    root = _cache_root(slug, digest)
    if (root / ".complete").exists():
        return root
    tmp = root.with_name(f"{root.name}.{uuid.uuid4().hex}")
    write_tree(tmp, files)
    (tmp / ".complete").touch()
    try:
        tmp.rename(root)
    except OSError:  # another process got there first
        shutil.rmtree(tmp, ignore_errors=True)
    return root


# --- validation ---------------------------------------------------------------


def validate_files(slug: str, files: dict[str, bytes], key: str | None = None) -> NodeConfig:
    """Load a tree as a NodeConfig exactly as the API would, including every
    data model version, vocabulary and plugin it names; raise ConfigError with
    every problem found."""
    from fiesta.plugins import active_plugins

    yaml_path = f"{slug}.yaml"
    if yaml_path not in files:
        raise ConfigError([f"{yaml_path} is missing"])
    errors: list[str] = []
    for path, content in files.items():
        try:
            check_syntax(path, content)
        except ConfigError as exc:
            errors += exc.errors
    if errors:
        raise ConfigError(errors)
    with tempfile.TemporaryDirectory() as tmp:
        write_tree(Path(tmp), files)
        try:
            node = load_node_yaml(Path(tmp) / yaml_path)
        except (ValidationError, ValueError, KeyError, OSError, TypeError) as exc:
            raise ConfigError([str(exc)]) from None
        try:
            for version in node.data_model.versions:
                tables = node.load_data_model(version).get("tables")
                if not isinstance(tables, dict):
                    errors.append(f"data model {version}: no `tables` object")
            node.load_controlled_vocabularies()
            node.load_suggested_vocabularies()
            node.load_method_codes()
            active_plugins(node)
        except (ValueError, KeyError, OSError) as exc:
            errors.append(str(exc))
        errors += check_pages_and_filters(node, files)
    if node.node.slug != slug:
        errors.append(f"node.slug is {node.node.slug!r}; this node's slug is {slug!r}")
    if key is not None and node.node.key != key:
        errors.append(f"node.key is {node.node.key!r}; this node's key is {key!r}")
    refs = {
        "data_model.dir": node.data_model.dir,
        "vocabularies.controlled": node.vocabularies.controlled,
        "vocabularies.suggested": node.vocabularies.suggested,
        "vocabularies.method_codes": node.vocabularies.method_codes,
        "development.seed_manifest": node.development.seed_manifest,
    }
    for field, ref in refs.items():
        if ref and not ref.startswith(f"{slug}/"):
            errors.append(f"{field} must point inside {slug}/ (got {ref!r})")
    if errors:
        raise ConfigError(errors)
    return node


def data_model_columns(node: NodeConfig) -> dict[str, set[str]]:
    """{table: {column}} of the latest data model."""
    model = node.load_data_model(node.data_model.latest)
    return {t: set((spec or {}).get("columns", {})) for t, spec in model["tables"].items()}


def check_pages_and_filters(node: NodeConfig, files: dict[str, bytes]) -> list[str]:
    """Every page has its HTML file; every facet is a data-model column; every
    filter's levels and views name search levels / result views."""
    errors = []
    for page in node.pages:
        if node.page_path(page.slug) not in files:
            errors.append(f"page {page.slug!r}: {node.page_path(page.slug)} is missing")
    try:
        columns = {c for cols in data_model_columns(node).values() for c in cols}
    except (KeyError, TypeError, AttributeError):
        return errors  # reported by the data model checks
    from fiesta.plugins import active_plugins

    levels = {lvl.name for lvl in node.search.levels}
    try:
        for plugin in active_plugins(node):
            levels |= {lvl.name for lvl in plugin.search_levels(node)}
    except ValueError:
        pass  # unknown plugin names are reported by the plugin check
    for f in node.search.filters:
        if f.type == "facet" and f.field not in columns and not f.field.startswith("_"):
            errors.append(
                f"facet {f.field!r} is not a column of data model {node.data_model.latest}"
            )
        for level in f.levels:
            if level not in levels:
                errors.append(f"filter {f.key!r}: no search level {level!r}")
    return errors


def check_identity(slug: str, key: str) -> None:
    errors = []
    if not SLUG_RE.match(slug) or slug in RESERVED_SLUGS:
        errors.append(
            f"slug {slug!r}: 2-32 lowercase letters, digits or hyphens, starting with a "
            f"letter, and not one of {sorted(RESERVED_SLUGS)}"
        )
    if not KEY_RE.match(key) or key.lower() in RESERVED_SLUGS:
        errors.append(f"key {key!r}: 2-32 letters, digits or hyphens, starting with a letter")
    if errors:
        raise ConfigError(errors)


def protected_changes(old_yaml: bytes, new_yaml: bytes) -> list[str]:
    """PROTECTED_SETTINGS that differ between two node YAMLs."""
    old, new = yaml.safe_load(old_yaml) or {}, yaml.safe_load(new_yaml) or {}

    def get(tree, path):
        for part in path:
            tree = tree.get(part) if isinstance(tree, dict) else None
        return tree

    return [".".join(p) for p in PROTECTED_SETTINGS if get(old, p) != get(new, p)]


# --- YAML edits that keep comments --------------------------------------------


def patch_yaml(content: bytes, ops: list[dict]) -> bytes:
    """Apply [{path: [...], value}] to a YAML document, keeping its comments
    and layout (ruamel round-trip). value None deletes the key."""
    from ruamel.yaml import YAML
    from ruamel.yaml.comments import CommentedMap, CommentedSeq

    ry = YAML()
    ry.preserve_quotes = True
    ry.width = 4096
    ry.indent(mapping=2, sequence=4, offset=2)  # `  - item` under its key, as written by hand
    doc = ry.load(content)

    def node(value, in_list=False):
        """A value as ruamel nodes; a mapping inside a list is written on one
        line (`- { slug: about, title: About }`) like the hand-written lists."""
        if isinstance(value, dict):
            out = CommentedMap((k, node(v)) for k, v in value.items())
            if in_list:
                out.fa.set_flow_style()
            return out
        if isinstance(value, list):
            return CommentedSeq(node(v, in_list=True) for v in value)
        return value

    for op in ops:
        path = list(op["path"])
        if not path:
            raise ConfigError(["empty settings path"])
        parent = doc
        for part in path[:-1]:
            if parent.get(part) is None:
                parent[part] = {}
            parent = parent[part]
            if not isinstance(parent, dict):
                raise ConfigError([f"{'.'.join(map(str, path))}: {part} is not a mapping"])
        if op.get("value") is None:
            parent.pop(path[-1], None)
        else:
            parent[path[-1]] = node(op["value"])
    out = io.BytesIO()
    ry.dump(doc, out)
    return out.getvalue()


# --- records and drafts -------------------------------------------------------


async def get_record(session, slug: str) -> NodeRecord:
    record = await session.get(NodeRecord, slug)
    if record is None:
        raise KeyError(slug)
    return record


async def get_revision(session, revision_id: int | None) -> NodeRevision | None:
    return await session.get(NodeRevision, revision_id) if revision_id else None


async def _next_number(session, slug: str) -> int:
    current = await session.scalar(
        select(func.max(NodeRevision.number)).where(NodeRevision.node == slug)
    )
    return (current or 0) + 1


async def revision_for(session, record: NodeRecord, which: str) -> NodeRevision:
    """`draft`, `published`, `current` (draft if open, else published) or a
    revision number."""
    if which == "current":
        which = "draft" if record.draft_revision_id else "published"
    if which == "draft":
        revision = await get_revision(session, record.draft_revision_id)
    elif which == "published":
        revision = await get_revision(session, record.published_revision_id)
    else:
        revision = await session.scalar(
            select(NodeRevision).where(
                NodeRevision.node == record.slug, NodeRevision.number == int(which)
            )
        )
    if revision is None:
        raise KeyError(which)
    return revision


async def open_draft(
    session, record: NodeRecord, user, from_number: int | None = None
) -> NodeRevision:
    """The node's open draft, or a new one copied from the published revision
    (or from revision `from_number`, to roll back)."""
    if record.draft_revision_id:
        if from_number is not None:
            raise Conflict("discard the open draft before starting one from another revision")
        return await get_revision(session, record.draft_revision_id)
    base = await revision_for(
        session, record, str(from_number) if from_number is not None else "published"
    )
    draft = NodeRevision(
        node=record.slug,
        number=await _next_number(session, record.slug),
        parent_id=base.id,
        files=dict(base.files),
        tree_hash=base.tree_hash,
        state="draft",
        source="ui",
        lock_version=1,
        author_id=user.id,
    )
    session.add(draft)
    await session.flush()
    record.draft_revision_id = draft.id
    return draft


async def _editable_draft(session, record, user, lock_version: int | None) -> NodeRevision:
    existed = record.draft_revision_id is not None
    draft = await open_draft(session, record, user)
    if existed and lock_version is not None and draft.lock_version != lock_version:
        raise Conflict(
            f"the draft changed since you loaded it (version {draft.lock_version}, "
            f"you have {lock_version}); reload and re-apply your edit"
        )
    return draft


def _set_files(draft: NodeRevision, files: dict[str, str]) -> None:
    draft.files = files
    draft.tree_hash = tree_hash(files)
    draft.lock_version += 1


async def put_file(
    session, record, user, path: str, content: bytes, lock_version: int | None
) -> NodeRevision:
    path = check_path(record.slug, path)
    check_syntax(path, content)
    draft = await _editable_draft(session, record, user, lock_version)
    manifest = await store_files(session, {path: content})
    _set_files(draft, {**draft.files, path: manifest[path]})
    return draft


async def delete_file(session, record, user, path: str, lock_version: int | None):
    path = check_path(record.slug, path)
    if path == f"{record.slug}.yaml":
        raise ConfigError([f"{path} is the node itself and cannot be deleted"])
    draft = await _editable_draft(session, record, user, lock_version)
    if path not in draft.files:
        raise KeyError(path)
    _set_files(draft, {p: h for p, h in draft.files.items() if p != path})
    return draft


async def read_file(session, revision: NodeRevision, path: str) -> bytes:
    if path not in revision.files:
        raise KeyError(path)
    return (await load_files(session, {path: revision.files[path]}))[path]


async def patch_settings(session, record, user, ops: list[dict], lock_version: int | None):
    yaml_path = f"{record.slug}.yaml"
    current = await revision_for(session, record, "current")
    content = patch_yaml(await read_file(session, current, yaml_path), ops)
    return await put_file(session, record, user, yaml_path, content, lock_version)


async def discard_draft(session, record: NodeRecord) -> None:
    draft = await get_revision(session, record.draft_revision_id)
    if draft is None:
        raise KeyError("draft")
    draft.state = "discarded"
    record.draft_revision_id = None


async def validate_revision(session, record: NodeRecord, revision: NodeRevision) -> NodeConfig:
    return validate_files(record.slug, await load_files(session, revision.files), key=record.key)


async def diff(session, record: NodeRecord, revision: NodeRevision) -> list[dict]:
    """Paths added / modified / removed relative to the published revision."""
    published = await get_revision(session, record.published_revision_id)
    before = published.files if published else {}
    changes = []
    for path in sorted(set(before) | set(revision.files)):
        if path not in before:
            changes.append({"path": path, "change": "added"})
        elif path not in revision.files:
            changes.append({"path": path, "change": "removed"})
        elif before[path] != revision.files[path]:
            changes.append({"path": path, "change": "modified"})
    return changes


# --- creating and publishing --------------------------------------------------


def template_files(
    template: NodeConfig, files: dict[str, bytes], slug: str, key: str, title: str
) -> dict[str, bytes]:
    """A new node's first tree, copied from an existing node: its data models
    and vocabularies (assets and seeds stay behind), re-keyed to the new node."""
    old = template.node.slug
    raw = yaml.safe_load(files[f"{old}.yaml"])
    keep = {f"{template.data_model.dir}/{v}.json" for v in template.data_model.versions} | {
        ref
        for ref in (
            template.vocabularies.controlled,
            template.vocabularies.suggested,
            template.vocabularies.method_codes,
        )
        if ref
    }

    def moved(ref: str | None) -> str | None:
        return f"{slug}/{ref[len(old) + 1 :]}" if ref and ref.startswith(f"{old}/") else ref

    raw["node"] = {
        "key": key,
        "slug": slug,
        "title": title,
        "subtitle": "",
        "color": raw.get("node", {}).get("color", "#666666"),
        "links": {},
    }
    raw["search"]["index"] = slug
    raw["storage"] = {"bucket": slug}
    raw["data_model"]["dir"] = moved(raw["data_model"]["dir"])
    for field in ("controlled", "suggested", "method_codes"):
        if raw["vocabularies"].get(field):
            raw["vocabularies"][field] = moved(raw["vocabularies"][field])
    raw["doi"] = {}
    raw.setdefault("features", {})["home"] = {}
    raw["pages"] = []  # page HTML lives under <slug>/pages/, which is not copied
    raw.pop("legacy", None)
    raw.pop("development", None)
    header = f"# FIESTA deployment configuration — {key} node (created in the admin UI)\n\n"
    body = yaml.safe_dump(raw, sort_keys=False, allow_unicode=True)
    out = {f"{slug}.yaml": (header + body).encode()}
    for ref in keep:
        out[moved(ref)] = files[ref]
    return out


async def create_node(
    session, user, slug: str, key: str, title: str, template_slug: str
) -> NodeRecord:
    """A new node as a draft only: nothing is served until it is published."""
    check_identity(slug, key)
    taken = await session.scalar(
        select(func.count())
        .select_from(NodeRecord)
        .where((NodeRecord.slug == slug) | (func.lower(NodeRecord.key) == key.lower()))
    )
    deployment = get_deployment()
    if taken or any(
        n.node.slug == slug or n.node.key.lower() == key.lower() for n in deployment.node_list
    ):
        raise Conflict(f"a node with slug {slug!r} or key {key!r} already exists")
    template_record = await get_record(session, template_slug)
    template_rev = await revision_for(session, template_record, "published")
    template_tree = await load_files(session, template_rev.files)
    template = validate_files(template_slug, template_tree)
    files = template_files(template, template_tree, slug, key, title)
    validate_files(slug, files, key=key)
    manifest = await store_files(session, files)
    record = NodeRecord(slug=slug, key=key, created_by=user.id)
    session.add(record)
    draft = NodeRevision(
        node=slug,
        number=1,
        files=manifest,
        tree_hash=tree_hash(manifest),
        state="draft",
        source="ui",
        message=f"Created from {template_record.key}",
        lock_version=1,
        author_id=user.id,
    )
    session.add(draft)
    await session.flush()
    record.draft_revision_id = draft.id
    return record


async def provision(node: NodeConfig) -> None:
    """What `fiesta init` does for one node: schema + migrations, bucket, index."""
    from fiesta.db.migrate import migrate_node_locked
    from fiesta.search.client import get_opensearch
    from fiesta.search.index import ensure_index
    from fiesta.storage import Storage

    await asyncio.to_thread(migrate_node_locked, node.node.slug)
    await Storage.for_node(node).ensure_bucket()
    await ensure_index(get_opensearch(), node.search_index)


async def publish(
    session, record: NodeRecord, user, lock_version: int | None, message: str | None
) -> NodeRevision:
    draft = await get_revision(session, record.draft_revision_id)
    if draft is None:
        raise Conflict("there is no draft to publish")
    if lock_version is not None and draft.lock_version != lock_version:
        raise Conflict(
            f"the draft changed since you loaded it (version {draft.lock_version}, "
            f"you have {lock_version}); reload and review it before publishing"
        )
    files = await load_files(session, draft.files)
    node = validate_files(record.slug, files, key=record.key)
    published = await get_revision(session, record.published_revision_id)
    if published is not None:
        if published.tree_hash == draft.tree_hash:
            raise ConfigError(["the draft is identical to the published revision"])
        yaml_path = f"{record.slug}.yaml"
        changed = protected_changes(
            await read_file(session, published, yaml_path), files[yaml_path]
        )
        if changed and not user.is_admin:
            raise PermissionError(f"only a super admin can change {', '.join(changed)}")
    else:
        # First publication of a node created in the admin UI.
        await provision(node)

    now = utcnow()
    if published is not None:
        published.state = "superseded"
    draft.state = "published"
    draft.published_at = now
    draft.published_by = user.id
    draft.message = message or draft.message
    mode = get_settings().config_publish
    draft.repo_status = "skipped" if mode == "none" else "pending"
    record.published_revision_id = draft.id
    record.draft_revision_id = None
    return draft


async def import_repo_nodes(session, deployment: Deployment) -> list[str]:
    """Record each YAML node's tree as a published revision unless Postgres
    has published that exact tree before (then git is simply behind or equal:
    a UI publication awaiting merge must not be rolled back by a deploy).
    Returns the slugs imported."""
    imported = []
    for node in deployment.node_list:
        slug = node.node.slug
        if not (node.base_dir / f"{slug}.yaml").is_file():
            logger.warning("%s: no %s.yaml beside fiesta.yaml; not imported", slug, slug)
            continue
        files = read_tree(node.base_dir, slug)
        manifest = {path: sha256(content) for path, content in files.items()}
        digest = tree_hash(manifest)
        known = set(
            (
                await session.execute(
                    select(NodeRevision.tree_hash).where(
                        NodeRevision.node == slug, NodeRevision.published_at.is_not(None)
                    )
                )
            ).scalars()
        )
        if digest in known:
            continue
        await store_files(session, files)
        record = await session.get(NodeRecord, slug)
        if record is None:
            record = NodeRecord(slug=slug, key=node.node.key)
            session.add(record)
            await session.flush()
        previous = await get_revision(session, record.published_revision_id)
        if previous is not None:
            previous.state = "superseded"
        revision = NodeRevision(
            node=slug,
            number=await _next_number(session, slug),
            parent_id=previous.id if previous else None,
            files=manifest,
            tree_hash=digest,
            state="published",
            source="repo",
            message="Imported from the repository",
            lock_version=1,
            published_at=utcnow(),
            repo_status="written",
            repo_ref=f"{slug}.yaml",
        )
        session.add(revision)
        await session.flush()
        record.published_revision_id = revision.id
        imported.append(slug)
    return imported


# --- the deployment this process serves ---------------------------------------

_marker: tuple | None = None
_checked = 0.0
_lock: asyncio.Lock | None = None


def _wanted() -> set[str]:
    return {n.strip().lower() for n in get_settings().node.split(",") if n.strip()}


async def load_published(session) -> Deployment:
    """The YAML deployment with every node's published revision swapped in
    (and nodes that exist only in Postgres added), narrowed by FIESTA_NODE."""
    base = load_deployment(only=None)
    nodes = dict(base.nodes)
    rows = (
        await session.execute(
            select(NodeRevision).join(
                NodeRecord, NodeRecord.published_revision_id == NodeRevision.id
            )
        )
    ).scalars()
    for revision in rows:
        slug = revision.node
        root = _cache_root(slug, revision.tree_hash)
        try:
            if not (root / ".complete").exists():
                root = materialize(
                    slug, revision.tree_hash, await load_files(session, revision.files)
                )
            node = load_node_yaml(root / f"{slug}.yaml")
        except Exception:
            logger.exception("%s: published revision %s does not load", slug, revision.number)
            continue
        nodes = {k: n for k, n in nodes.items() if n.node.slug != slug}
        nodes[node.node.key.lower()] = node
    if wanted := _wanted():
        nodes = {k: n for k, n in nodes.items() if k in wanted or n.node.slug.lower() in wanted}
    return Deployment(title=base.title, nodes=nodes)


async def refresh_deployment(force: bool = False) -> Deployment:
    """Swap in the published revisions if any changed since the last look."""
    global _marker, _checked, _lock
    if not enabled():
        return get_deployment()
    from fiesta.db.session import get_sessionmaker

    _lock = _lock or asyncio.Lock()
    async with _lock:
        _checked = time.monotonic()
        try:
            async with get_sessionmaker(None)() as session:
                marker = tuple(
                    (
                        await session.execute(
                            select(
                                func.count(NodeRevision.id), func.max(NodeRevision.published_at)
                            ).where(NodeRevision.state == "published")
                        )
                    ).one()
                )
                if force or marker != _marker:
                    set_deployment(await load_published(session))
                    _marker = marker
        except (SQLAlchemyError, OSError) as exc:
            logger.warning("node configuration not refreshed from Postgres: %s", exc)
    return get_deployment()


async def maybe_refresh() -> None:
    """refresh_deployment at most every REFRESH_SECONDS (per request / task)."""
    global _checked
    if enabled() and time.monotonic() - _checked > REFRESH_SECONDS:
        _checked = time.monotonic()  # one refresh per interval, not one per waiter
        await refresh_deployment()
