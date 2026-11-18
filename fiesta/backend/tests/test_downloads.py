"""Contribution downloads (fiesta.domain.download, fiesta.services.downloads
and the public routes): the text served from a stored file, its checksums,
and compression, with a fake session holding the rows and a fake bucket."""

import base64
import gzip
import hashlib
import io
import uuid
import zipfile
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fiesta.apps.routers import search
from fiesta.db.models import Contribution, NodeAdmin, Revision, User
from fiesta.domain.download import clean_text, contribution_values, prepare_download
from fiesta.domain.parse import parse_text
from fiesta.services import downloads

RECORD = {
    "id": 7,
    "version": 2,
    "timestamp": "2026-11-16T10:00:00.000Z",
    "contributor": "Ada Lovelace",
    "data_model_version": "3.0",
}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---- the served text (fiesta.domain.download) ---------------------------------------


def test_leading_bom_is_stripped(magic_node):
    model = magic_node.load_data_model("3.0")
    raw = "﻿tab delimited\tsites\r\nsite\tlat\r\nS1\t10\r\n".encode()
    text = prepare_download(raw, model, {}).decode()
    assert text == "tab delimited\tsites\nsite\tlat\nS1\t10\n"
    # With a contribution id the stored identifiers are written too.
    text = prepare_download(raw, model, {"id": 7}).decode()
    assert not text.startswith("﻿")
    assert text.startswith("tab delimited\tcontribution\nid\n7\n>>>>>>>>>>\ntab delimited\tsites")


def test_stray_separators_are_dropped():
    # MagIC #311: a legacy export left "\t\t\t\t>>>>>>>>>>" after a table, and
    # files carry runs of separators, short ones, and blank or tab-only rows.
    text = (
        ">>>>>>>>>>\n"
        "tab delimited\tsites\nsite\tlat\nS1\t10\n\t\t\n\t\t\t\t>>>>>>>>>>\n"
        ">>>>>\n\n>>>>>>>>>>\n"
        "tab delimited\tsamples\nsample\tsite\nA\tS1\n"
        ">>>>>>>>>>\n\n"
    )
    assert clean_text(text) == (
        "tab delimited\tsites\nsite\tlat\nS1\t10\n"
        ">>>>>>>>>>\n"
        "tab delimited\tsamples\nsample\tsite\nA\tS1\n"
    )
    # Real cells survive, including one that merely contains `>`s.
    assert clean_text("tab\tsites\nsite\tnote\nS1\t>>> see note\n") == (
        "tab\tsites\nsite\tnote\nS1\t>>> see note\n"
    )
    assert clean_text("") == ""


def test_contribution_metadata_is_filled(magic_node):
    model = magic_node.load_data_model("3.0")
    stored = (
        b"tab delimited\tcontribution\n"
        b"version\ttimestamp\tcontributor\tdata_model_version\treference\n"
        b"1\t2017-09-29T04:43:48.218Z\t@grevean\t3.0\t10.1016/J.PEPI.2017.05.009\n"
        b">>>>>>>>>>\n"
        b"tab delimited\tsites\nsite\tlat\nS1\t10\nS2\t11\n"
    )
    text = prepare_download(stored, model, RECORD).decode()
    parsed = parse_text(text)
    # The workflow's values overwrite the stored ones (the legacy `@handle`,
    # MagIC #497), the id leads its table, and the rows carry their ids (#291).
    assert parsed.tables["contribution"] == [
        {
            "id": "7",
            "version": "2",
            "timestamp": "2026-11-16T10:00:00.000Z",
            "contributor": "Ada Lovelace",
            "data_model_version": "3.0",
            "reference": "10.1016/J.PEPI.2017.05.009",
        }
    ]
    assert text.split("\n")[1].startswith("id\t")
    assert [r["row_id"] for r in parsed.tables["sites"]] == ["1", "2"]
    assert {r["contribution_id"] for r in parsed.tables["sites"]} == {"7"}


def test_dropped_stray_rows_keep_every_row_id(magic_node):
    # A stray `>` row inside a table is a row to parse_text, so it holds a
    # row id; dropping it from the download must not renumber the rows after
    # it, or their row_id would no longer match the row links.
    model = magic_node.load_data_model("3.0")
    stored = (
        "tab delimited\tsites\nsite\tlat\tlon\nS1\t10\t20\n\t\t>>>>>>>>>>\n"
        ">>>>>>>>>>\ntab delimited\tsamples\nsample\tsite\nA\tS1\nB\tS1\n"
    )
    ids = parse_text(stored).row_ids
    assert ids == {"sites": [1, 2], "samples": [3, 4]}
    parsed = parse_text(prepare_download(stored.encode(), model, RECORD).decode())
    assert [r["site"] for r in parsed.tables["sites"]] == ["S1"]
    assert [r["row_id"] for r in parsed.tables["sites"]] == ["1"]
    assert [r["row_id"] for r in parsed.tables["samples"]] == ["3", "4"]


def test_a_missing_contribution_table_is_added(magic_node):
    # MagIC #315: a file without a contribution table still says whose it is.
    model = magic_node.load_data_model("3.0")
    text = prepare_download(b"tab delimited\tsites\nsite\nS1\n", model, RECORD).decode()
    assert parse_text(text).tables["contribution"][0]["contributor"] == "Ada Lovelace"
    assert text.startswith("tab delimited\tcontribution\n")


def test_only_declared_download_only_columns_are_written(magic_node):
    model = {
        "tables": {
            "contribution": {
                "columns": {
                    "id": {"validations": ["downloadOnly()"]},
                    "contributor": {"validations": ["downloadOnly()"]},
                    # Declared but not download-only: the contributor's to set.
                    "version": {},
                }
            }
        }
    }
    # An empty value never blanks a stored one.
    assert contribution_values(model, {**RECORD, "contributor": ""}) == {"id": "7"}
    assert contribution_values(model, RECORD) == {"id": "7", "contributor": "Ada Lovelace"}


def test_unreadable_files_are_served_as_they_are(magic_node):
    model = magic_node.load_data_model("3.0")
    latin1 = "tab delimited\tsites\nsite\nS\xe9\n".encode("latin-1")
    assert prepare_download(latin1, model, RECORD) == latin1
    # Text that does not parse is cleaned but gets no metadata.
    broken = b"\xef\xbb\xbfnot a table\n>>>>\n"
    assert prepare_download(broken, model, RECORD) == b"not a table\n"


# ---- checksums and compression ------------------------------------------------------


def _served(data=b"tab delimited\tsites\nsite\nS1\n", stored="ab" * 32):
    return downloads.ServedFile("magic_contribution_7.txt", data, sha(data), stored)


def test_checksum_headers_name_each_checksum():
    served = _served()
    response = downloads.file_response(served)
    assert response.body == served.data
    assert response.headers["x-checksum-sha256"] == sha(served.data)
    assert response.headers["x-stored-sha256"] == "ab" * 32
    digest = base64.b64encode(hashlib.sha256(served.data).digest()).decode()
    assert response.headers["repr-digest"] == f"sha-256=:{digest}:"
    assert response.headers["content-type"].startswith("text/plain")


def test_gzip_and_zip_downloads():
    served = _served()
    gz = downloads.file_response(served, "gzip")
    assert gz.headers["content-disposition"] == 'attachment; filename="magic_contribution_7.txt.gz"'
    assert gzip.decompress(gz.body) == served.data
    # The text's checksum is unchanged by compression; Repr-Digest is the body's.
    assert gz.headers["x-checksum-sha256"] == sha(served.data)
    body_digest = base64.b64encode(hashlib.sha256(gz.body).digest()).decode()
    assert gz.headers["repr-digest"] == f"sha-256=:{body_digest}:"
    assert downloads.file_response(served, "gzip").body == gz.body  # deterministic

    zipped = downloads.file_response(served, "zip")
    assert zipped.headers["content-disposition"] == (
        'attachment; filename="magic_contribution_7.zip"'
    )
    with zipfile.ZipFile(io.BytesIO(zipped.body)) as zf:
        assert zf.namelist() == ["magic_contribution_7.txt", "SHA256SUMS"]
        assert zf.read("magic_contribution_7.txt") == served.data
        assert zf.read("SHA256SUMS").decode() == (f"{sha(served.data)}  magic_contribution_7.txt\n")


# ---- routes, with a fake session and bucket -----------------------------------------

ADA, BOB, ADMIN = 1, 2, 3
PUBLIC, PRIVATE, DELETED, OTHER_NODE, BIG = 10, 11, 12, 13, 14


def _file(cid: int) -> bytes:
    return (
        "﻿tab delimited\tcontribution\nreference\n10.1/x\n>>>>>>>>>>\n"
        f"tab delimited\tsites\nsite\nS{cid}\n\t\t>>>>>>>>>>\n"
    ).encode()


class FakeSession:
    def __init__(self):
        self.users = {
            ADA: User(id=ADA, email="ada@x.test", name="Ada", is_admin=False),
            BOB: User(id=BOB, email="bob@x.test", name="Bob", is_admin=False),
            ADMIN: User(
                id=ADMIN,
                email="admin@x.test",
                name="Admin",
                is_admin=False,
                node_roles=[NodeAdmin(user_id=ADMIN, node="magic")],
            ),
        }
        when = datetime(2026, 11, 16, 10, tzinfo=UTC)

        def contribution(cid, **fields):
            values = {
                "id": cid,
                "node": "magic",
                "contributor_id": ADA,
                "is_activated": True,
                "is_latest": True,
                "private_key": uuid.uuid4(),
                "workspace_id": None,
                "deleted_at": None,
                "filename": f"magic_contribution_{cid}.txt",
                "head_revision": f"rev-{cid}",
                "version": 1,
                "data_model_version": "3.0",
                "activated_at": when,
            }
            return Contribution(**{**values, **fields})

        self.contributions = {
            PUBLIC: contribution(PUBLIC),
            PRIVATE: contribution(PRIVATE, is_activated=False, activated_at=None),
            DELETED: contribution(DELETED, deleted_at=when),
            OTHER_NODE: contribution(OTHER_NODE, node="cdr"),
            BIG: contribution(BIG),
        }
        self.revisions = {}
        for cid in self.contributions:
            data = _file(cid)
            name = f"magic_contribution_{cid}.txt"
            size = 600 * 1024**2 if cid == BIG else len(data)
            entry = {"key": f"contributions/{cid}/blobs/{sha(data)}/{name}", "sha256": sha(data)}
            self.revisions[f"rev-{cid}"] = Revision(
                id=f"rev-{cid}",
                contribution_id=cid,
                snapshot={
                    "canonical": name,
                    "files": {name: {**entry, "size": size}},
                    "data_model_version": "3.0",
                },
            )

    async def get(self, model, pk):
        return {Contribution: self.contributions, Revision: self.revisions, User: self.users}[
            model
        ].get(pk)


@pytest.fixture
def bucket(monkeypatch):
    """The fake bucket: every file's key reads back its _file bytes, and a
    `broken` set of ids whose reads fail."""
    reads, broken = [], set()

    async def read(node, stored):
        reads.append(stored.contribution_id)
        if stored.contribution_id in broken:
            raise OSError("bucket unavailable")
        return _file(stored.contribution_id)

    monkeypatch.setattr(downloads, "read", read)
    return SimpleNamespace(reads=reads, broken=broken)


async def test_public_download_is_prepared_and_checksummed(magic_node, bucket):
    session = FakeSession()
    response = await search.download_contribution(session, magic_node, PUBLIC)
    text = response.body.decode()
    assert not text.startswith("﻿") and "\t>>>" not in text
    contribution = parse_text(text).tables["contribution"][0]
    assert contribution["id"] == str(PUBLIC)
    assert contribution["contributor"] == "Ada"
    assert contribution["timestamp"] == "2026-11-16T10:00:00.000Z"
    assert response.headers["x-checksum-sha256"] == sha(response.body)
    assert response.headers["x-stored-sha256"] == sha(_file(PUBLIC))
    # `original` serves the stored bytes, whose checksum is the stored one.
    original = await search.download_contribution(session, magic_node, PUBLIC, original=True)
    assert original.body == _file(PUBLIC)
    assert original.headers["x-checksum-sha256"] == sha(_file(PUBLIC))

    info = await search.download_info(session, magic_node, PUBLIC)
    assert info["sha256"] == sha(response.body) and info["size"] == len(response.body)
    assert info["stored"]["sha256"] == sha(_file(PUBLIC))


async def test_private_single_download_needs_its_key(magic_node, bucket):
    session = FakeSession()
    with pytest.raises(HTTPException) as err:
        await search.download_contribution(session, magic_node, PRIVATE)
    assert err.value.status_code == 404
    key = str(session.contributions[PRIVATE].private_key)
    response = await search.download_contribution(session, magic_node, PRIVATE, key, "gzip")
    # Unpublished: no activation timestamp.
    assert (
        "timestamp"
        not in parse_text(gzip.decompress(response.body).decode()).tables["contribution"][0]
    )
