"""Seed local FIESTA nodes with real contributions from EarthRef production.

Contribution IDs come from the production OpenSearch indices; the canonical
files come from S3 (`{node}-activated-contributions/{id}/{node}_contribution_{id}.txt`)
where available, or are reconstructed from the OpenSearch contribution doc's
nested tables (CDR, whose files live only in a pipeline index). Credentials are
read from the committed Meteor `settings.json` (EarthRef infra).

Files + manifests are written straight into the local node's storage bucket;
`fiesta rebuild <node>` then regenerates Postgres + OpenSearch from the bucket.

Prior-version FILES are not retained in production, so to exercise the
version-chain UI this reconstructs a short chain per contribution by reusing
the current file for the prior versions (a test convenience).

Usage (from backend/, against the running compose stack):
    uv run python scripts/seed_from_live.py --node karar --count 10
    uv run python scripts/seed_from_live.py --node cdr --count 10
"""

import argparse
import json
import subprocess
import uuid
import warnings
from datetime import UTC, datetime, timedelta

import boto3
import urllib3
from botocore.config import Config
from opensearchpy import OpenSearch

warnings.filterwarnings("ignore")
urllib3.disable_warnings()

SETTINGS = "/home/rminnett/git/earthref/CDR/settings.json"

# node slug -> (repo key, prod OpenSearch index, source, prod S3 bucket)
NODES = {
    "magic": ("MagIC", "magic", "s3", "magic-activated-contributions"),
    "karar": ("KArAr", "karar", "s3", "karar-activated-contributions"),
    "kdd": ("KdD", "kdd", "s3", "kdd-activated-contributions"),
    "cdr": ("CDR", "fiesta-cdr-20260615-full", "opensearch", None),
}

LOCAL_S3 = {
    "endpoint_url": "http://localhost:9000",
    "aws_access_key_id": "fiesta",
    "aws_secret_access_key": "fiesta-secret",
}

MAX_FILE_BYTES = 1_500_000
MAX_CHAIN = 3


def _settings() -> dict:
    return json.load(open(SETTINGS))


def prod_opensearch() -> OpenSearch:
    return OpenSearch(
        [_settings()["opensearch"]["node"]], verify_certs=False, ssl_show_warn=False, timeout=60
    )


def prod_s3():
    cfg = _settings()["s3"]
    return boto3.client(
        "s3",
        aws_access_key_id=cfg["accessKeyId"],
        aws_secret_access_key=cfg["secretAccessKey"],
        region_name="us-west-2",
        config=Config(retries={"max_attempts": 2}),
    )


def local_s3():
    return boto3.client("s3", config=Config(s3={"addressing_style": "path"}), **LOCAL_S3)


def discover(osc: OpenSearch, index: str, count: int) -> list[dict]:
    """Recent activated+latest contribution docs (id, version, metadata)."""
    body = {
        "size": count * 4,
        "_source": ["summary.contribution", "contribution.contribution"],
        "query": {"bool": {"filter": [{"term": {"type": "contribution"}}]}},
        "sort": [{"summary.contribution.id": {"order": "desc", "unmapped_type": "long"}}],
    }
    hits = osc.search(index=index, body=body)["hits"]["hits"]
    out = []
    for h in hits:
        summary = h["_source"].get("summary", {}).get("contribution", {})
        cid = summary.get("id")
        if cid is None:
            continue
        # activation flags are strings ("true") in the legacy index
        if str(summary.get("_is_activated", "true")).lower() == "false":
            continue
        if str(summary.get("_is_latest", "true")).lower() == "false":
            continue
        out.append(
            {
                "id": int(cid),
                "version": int(summary.get("version") or 1),
                "contributor": summary.get("_contributor") or "@earthref",
                "data_model_version": str(summary.get("data_model_version") or "1.0"),
                "reference": (summary.get("_reference") or {}).get("doi"),
                "timestamp": summary.get("timestamp"),
            }
        )
    return out


def reconstruct_file(contribution: dict) -> bytes:
    """Serialize a nested {table: [rows]} contribution to the tab format."""
    blocks = []
    # contribution table first, then the rest in document order
    ordered = ["contribution"] + [t for t in contribution if t != "contribution"]
    for table in ordered:
        rows = contribution.get(table)
        if not isinstance(rows, list) or not rows:
            continue
        columns: list[str] = []
        for row in rows:
            for col in row:
                if col not in columns:
                    columns.append(col)
        lines = [f"tab delimited\t{table}", "\t".join(columns)]
        for row in rows:
            lines.append("\t".join(_cell(row.get(c)) for c in columns))
        blocks.append("\n".join(lines))
    return ("\n>>>>>>>>>>\n".join(blocks) + "\n").encode("utf-8")


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ":".join(str(v) for v in value)
    return str(value)


def fetch_file(node: str, meta: dict, osc: OpenSearch, ps3) -> bytes | None:
    repo, index, source, bucket = NODES[node]
    cid = meta["id"]
    if source == "s3":
        key = f"{cid}/{node}_contribution_{cid}.txt"
        try:
            obj = ps3.get_object(Bucket=bucket, Key=key)
            if obj["ContentLength"] > MAX_FILE_BYTES:
                return None
            return obj["Body"].read()
        except Exception:
            return None
    # opensearch reconstruction
    r = osc.search(
        index=index,
        body={
            "size": 1,
            "_source": ["contribution"],
            "query": {"bool": {"filter": [{"term": {"type": "contribution"}},
                                          {"term": {"summary.contribution.id": cid}}]}},
        },
    )
    hits = r["hits"]["hits"]
    if not hits:
        return None
    contribution = hits[0]["_source"].get("contribution")
    if not isinstance(contribution, dict):
        return None
    raw = reconstruct_file(contribution)
    return raw if len(raw) <= MAX_FILE_BYTES else None


def collect(node: str, count: int) -> list[dict]:
    osc, ps3 = prod_opensearch(), prod_s3()
    candidates = discover(osc, NODES[node][1], count)
    collected = []
    for meta in candidates:
        raw = fetch_file(node, meta, osc, ps3)
        if raw is None:
            print(f"  skip {meta['id']} (missing or > {MAX_FILE_BYTES // 1000}KB)")
            continue
        meta["text"] = raw
        collected.append(meta)
        print(f"  got {meta['id']} v{meta['version']} ({len(raw) // 1000}KB)")
        if len(collected) >= count:
            break
    return collected


def _parse_ts(ts: str | None) -> datetime:
    if ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime(2024, 1, 1, tzinfo=UTC)


def build_chain(c: dict, prior_id_start: int) -> tuple[list[dict], int]:
    n = min(c["version"], MAX_CHAIN)
    base_ts = _parse_ts(c["timestamp"])
    rows, prev_id, prior_id, top = [], None, prior_id_start, c["version"]
    for offset in range(n - 1, -1, -1):
        version = top - offset
        is_latest = offset == 0
        vid = c["id"] if is_latest else prior_id
        if not is_latest:
            prior_id += 1
        rows.append(
            {
                "id": vid,
                "version": version,
                "previous_id": prev_id,
                "is_latest": is_latest,
                "text": c["text"],
                "contributor": c["contributor"],
                "data_model_version": c["data_model_version"],
                "reference": c["reference"],
                "created_at": (base_ts - timedelta(days=30 * offset)).isoformat(),
            }
        )
        prev_id = vid
    return rows, prior_id


def write_version(bucket: str, node: str, row: dict, client) -> None:
    filename = f"{node}_contribution_{row['id']}.txt"
    prefix = f"contributions/{row['id']}/"
    client.put_object(Bucket=bucket, Key=f"{prefix}{filename}", Body=row["text"])
    manifest = {
        "id": row["id"],
        "node": node,
        "version": row["version"],
        "previous_id": row.get("previous_id"),
        "contributor": {
            "id": None,
            "email": f"{str(row['contributor']).lstrip('@')}@earthref.org",
            "name": row["contributor"],
            "orcid": None,
        },
        "private_key": str(uuid.uuid4()),
        "is_activated": True,
        "is_latest": row["is_latest"],
        "data_model_version": row["data_model_version"],
        "reference_doi": row.get("reference"),
        "filename": filename,
        "status": "ready",
        "created_at": row["created_at"],
        "updated_at": row["created_at"],
        "activated_at": row["created_at"],
    }
    client.put_object(
        Bucket=bucket, Key=f"{prefix}manifest.json", Body=json.dumps(manifest, default=str).encode()
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default="karar", choices=list(NODES))
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--no-rebuild", action="store_true")
    args = ap.parse_args()

    node = args.node
    print(f"Collecting up to {args.count} real contributions for {node}...")
    contributions = collect(node, args.count)
    print(f"Collected {len(contributions)}.")

    client = local_s3()
    prior_id, total = 900_000_000, 0
    for c in contributions:
        rows, prior_id = build_chain(c, prior_id)
        for row in rows:
            write_version(node, node, row, client)
            total += 1
    print(f"Wrote {total} version files across {len(contributions)} contributions.")

    if not args.no_rebuild and contributions:
        print(f"Rebuilding {node} from bucket...")
        subprocess.run(  # noqa: S603
            ["docker", "compose", "run", "--rm", f"backend-{node}", "fiesta", "rebuild", "--yes"],
            cwd="..",
            check=True,
        )


if __name__ == "__main__":
    main()
