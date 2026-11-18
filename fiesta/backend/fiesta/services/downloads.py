"""Contribution downloads: one file (plain, gzip or zip), prepared on output
by `fiesta.domain.download` and labelled with its checksums. Download
Results' contribution files zip (`/search/{table}/download?files=true`)
prepares each of its files here too.

Two checksums, never confused:
- the stored checksum: sha256 of the canonical file in the bucket, recorded in
  the revision snapshot when it was saved (immutable; what `?original=true`
  serves byte for byte);
- the served checksum: sha256 of the text a download actually delivers (the
  stored file after the BOM, separator and metadata fixes). It is the
  checksum of the `.txt`, also inside a `.gz` or `.zip`.

Callers check visibility first (`fiesta.plugins.util.load_visible_contribution`,
the search router's private-key check, or the workspace `can_access`).
"""

import base64
import gzip
import hashlib
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from fastapi import HTTPException
from fastapi.responses import Response

from fiesta.db.models import Contribution, Revision, User
from fiesta.domain.download import prepare_download
from fiesta.nodeconfig import NodeConfig
from fiesta.storage import Storage, file_key

Compression = Literal["gzip", "zip"]
SUMS_NAME = "SHA256SUMS"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def timestamp(value: datetime | None) -> str | None:
    """Legacy's activation timestamp form, 2017-10-20T17:47:21.383Z."""
    if value is None:
        return None
    value = value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class StoredFile:
    """Where a contribution's file is, what it was stored as, and the
    workflow values its download writes into the contribution table."""

    contribution_id: int
    name: str
    key: str
    sha256: str | None
    size: int | None
    data_model_version: str | None
    record: dict = field(default_factory=dict)


@dataclass
class ServedFile:
    name: str
    data: bytes
    sha256: str
    stored_sha256: str | None
    original: bool = False


async def locate(
    session, node: NodeConfig, contribution: Contribution, revision_id: str | None = None
) -> StoredFile:
    """The contribution's current canonical file (or a revision's). 404 when
    there is none."""
    revision_id = revision_id or contribution.head_revision
    if revision_id:
        rev = await session.get(Revision, revision_id)
        if rev is None or rev.contribution_id != contribution.id:
            raise HTTPException(404, "revision not found")
        name = rev.snapshot.get("canonical")
        entry = rev.snapshot.get("files", {}).get(name) if name else None
        if entry is None:
            raise HTTPException(404, "this contribution has no file")
        stored = StoredFile(
            contribution.id,
            name,
            entry["key"],
            entry.get("sha256"),
            entry.get("size"),
            rev.snapshot.get("data_model_version") or contribution.data_model_version,
        )
    elif contribution.filename:
        # A legacy file from before revisions: its checksum is computed on read.
        stored = StoredFile(
            contribution.id,
            contribution.filename,
            file_key(contribution.id, contribution.filename),
            None,
            None,
            contribution.data_model_version,
        )
    else:
        raise HTTPException(404, "this contribution has no file")
    contributor = await session.get(User, contribution.contributor_id)
    stored.record = {
        "id": contribution.id,
        "version": contribution.version,
        "timestamp": timestamp(contribution.activated_at) if contribution.is_activated else None,
        # The contributor's name, not the legacy `@handle` (which Excel reads
        # as a formula, MagIC #497).
        "contributor": contributor.name if contributor else None,
        "data_model_version": stored.data_model_version,
    }
    return stored


async def read(node: NodeConfig, stored: StoredFile) -> bytes:
    raw = await Storage.for_node(node).get_bytes(stored.key)
    if stored.sha256 is None:
        stored.sha256, stored.size = sha256(raw), len(raw)
    elif sha256(raw) != stored.sha256:
        raise RuntimeError("stored file checksum does not match revision")
    return raw


def _model(node: NodeConfig, version: str | None) -> dict:
    try:
        return node.load_data_model(version or node.data_model.latest)
    except KeyError:
        return node.load_data_model(node.data_model.latest)


def serve(node: NodeConfig, stored: StoredFile, raw: bytes, original: bool = False) -> ServedFile:
    """The file a download delivers: RAW as stored (`original`), else prepared."""
    data = (
        raw
        if original
        else prepare_download(raw, _model(node, stored.data_model_version), stored.record)
    )
    return ServedFile(stored.name, data, sha256(data), stored.sha256 or sha256(raw), original)


async def served_file(
    session,
    node: NodeConfig,
    contribution: Contribution,
    *,
    revision_id: str | None = None,
    original: bool = False,
) -> ServedFile:
    stored = await locate(session, node, contribution, revision_id)
    return serve(node, stored, await read(node, stored), original)


def _repr_digest(body: bytes) -> str:
    """RFC 9530 Repr-Digest of a response body."""
    return f"sha-256=:{base64.b64encode(hashlib.sha256(body).digest()).decode()}:"


def _stem(name: str) -> str:
    return name.rsplit(".", 1)[0] if "." in name else name


def sums(entries: Iterable[tuple[str, str]]) -> bytes:
    """`sha256sum -c` lines for (path, sha256) pairs."""
    return "".join(f"{digest}  {path}\n" for path, digest in entries).encode()


def file_response(served: ServedFile, compress: Compression | None = None) -> Response:
    """One file as an attachment: the text, gzipped (`<name>.gz`) or zipped
    with a SHA256SUMS line (`<stem>.zip`). X-Checksum-SHA256 is the served
    text's checksum (inside any compression), X-Stored-SHA256 the stored
    file's, Repr-Digest the response body's."""
    name, body, media_type = served.name, served.data, "text/plain; charset=utf-8"
    if compress == "gzip":
        # mtime=0: the same file always compresses to the same bytes.
        name, body, media_type = f"{name}.gz", gzip.compress(body, mtime=0), "application/gzip"
    elif compress == "zip":
        writer = _ZipStream()
        body = writer.add(served.name, served.data)
        body += writer.add(SUMS_NAME, sums([(served.name, served.sha256)]))
        name, body, media_type = (
            f"{_stem(served.name)}.zip",
            body + writer.close(),
            "application/zip",
        )
    headers = {
        "Content-Disposition": f'attachment; filename="{name}"',
        "X-Checksum-SHA256": served.sha256,
        "Repr-Digest": _repr_digest(body),
    }
    if served.stored_sha256:
        headers["X-Stored-SHA256"] = served.stored_sha256
    return Response(body, media_type=media_type, headers=headers)


def file_info(served: ServedFile, stored: StoredFile) -> dict:
    return {
        "filename": served.name,
        "size": len(served.data),
        "sha256": served.sha256,
        "stored": {"size": stored.size, "sha256": stored.sha256},
        "formats": ["txt", "gzip", "zip"],
    }


# ---- zips ---------------------------------------------------------------------------


class _Sink:
    """A write-only, unseekable file: ZipFile then writes data descriptors,
    and what it wrote so far can be taken and sent."""

    def __init__(self):
        self.chunks: list[bytes] = []

    def write(self, data) -> int:
        self.chunks.append(bytes(data))
        return len(data)

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        data, self.chunks = b"".join(self.chunks), []
        return data


class _ZipStream:
    def __init__(self):
        self.sink = _Sink()
        self.zip = zipfile.ZipFile(self.sink, "w", zipfile.ZIP_DEFLATED, allowZip64=True)

    def add(self, path: str, data: bytes) -> bytes:
        info = zipfile.ZipInfo(path, date_time=datetime.now(UTC).timetuple()[:6])
        info.compress_type = zipfile.ZIP_DEFLATED
        self.zip.writestr(info, data)
        return self.sink.take()

    def close(self) -> bytes:
        self.zip.close()
        return self.sink.take()
