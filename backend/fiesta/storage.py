"""S3-compatible object storage (MinIO in dev, AWS S3 in production).

The bucket is the durable record of a node: for every contribution version it
holds the canonical text file plus a manifest.json with the workflow metadata.
Postgres and OpenSearch are projections that `fiesta rebuild` can regenerate
from the bucket + the deployment YAML.

Layout within a node's bucket (or, with FIESTA_S3_BUCKET, under the node's
"<slug>/" prefix inside the shared bucket -- Storage adds and strips that
prefix, callers only ever see the keys below):
    contributions/{id}/{filename}      canonical contribution file
    contributions/{id}/manifest.json   workflow metadata (see manifest_for)
    uploads/{user_id}/{uuid}/{name}    raw uploads before parsing
"""

import json
from typing import Any

import aioboto3
from botocore.config import Config
from botocore.exceptions import ClientError

from fiesta.settings import get_settings


class Storage:
    def __init__(self, bucket: str, prefix: str = ""):
        self.bucket = bucket
        self.prefix = prefix
        settings = get_settings()
        self._session = aioboto3.Session()
        self._client_kwargs: dict[str, Any] = {
            "aws_access_key_id": settings.s3_access_key,
            "aws_secret_access_key": settings.s3_secret_key,
            "region_name": settings.s3_region,
            # MinIO wants path-style; AWS (no endpoint) prefers virtual-hosted.
            "config": Config(
                s3={"addressing_style": "path" if settings.s3_endpoint else "virtual"}
            ),
        }
        if settings.s3_endpoint:
            self._client_kwargs["endpoint_url"] = settings.s3_endpoint

    @classmethod
    def for_node(cls, node) -> "Storage":
        return cls(node.bucket, node.storage_prefix)

    def _key(self, key: str) -> str:
        return f"{self.prefix}{key}"

    def _strip(self, key: str) -> str:
        return key[len(self.prefix) :] if self.prefix and key.startswith(self.prefix) else key

    def client(self):
        return self._session.client("s3", **self._client_kwargs)

    async def ensure_bucket(self) -> None:
        async with self.client() as s3:
            try:
                await s3.head_bucket(Bucket=self.bucket)
            except ClientError:
                try:
                    await s3.create_bucket(Bucket=self.bucket)
                except ClientError as exc:
                    # Concurrent service start-ups race to create the bucket.
                    code = exc.response.get("Error", {}).get("Code")
                    if code not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                        raise

    async def put_bytes(self, key: str, data: bytes, content_type: str = "text/plain") -> None:
        async with self.client() as s3:
            await s3.put_object(
                Bucket=self.bucket, Key=self._key(key), Body=data, ContentType=content_type
            )

    async def put_json(self, key: str, data: Any) -> None:
        await self.put_bytes(
            key, json.dumps(data, default=str).encode(), content_type="application/json"
        )

    async def get_bytes(self, key: str) -> bytes:
        async with self.client() as s3:
            obj = await s3.get_object(Bucket=self.bucket, Key=self._key(key))
            return await obj["Body"].read()

    async def get_json(self, key: str) -> Any:
        return json.loads(await self.get_bytes(key))

    async def exists(self, key: str) -> bool:
        async with self.client() as s3:
            try:
                await s3.head_object(Bucket=self.bucket, Key=self._key(key))
                return True
            except ClientError:
                return False

    async def _list_raw(self, prefix: str) -> list[str]:
        """Bucket keys (prefix included) under a caller-relative prefix."""
        keys: list[str] = []
        async with self.client() as s3:
            paginator = s3.get_paginator("list_objects_v2")
            async for page in paginator.paginate(Bucket=self.bucket, Prefix=self._key(prefix)):
                keys.extend(item["Key"] for item in page.get("Contents", []))
        return keys

    async def list_keys(self, prefix: str) -> list[str]:
        return [self._strip(k) for k in await self._list_raw(prefix)]

    async def delete_prefix(self, prefix: str) -> None:
        keys = await self._list_raw(prefix)
        if not keys:
            return
        async with self.client() as s3:
            for start in range(0, len(keys), 1000):
                chunk = keys[start : start + 1000]
                await s3.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in chunk]}
                )


def contribution_prefix(contribution_id: int) -> str:
    return f"contributions/{contribution_id}/"


def manifest_key(contribution_id: int) -> str:
    return f"{contribution_prefix(contribution_id)}manifest.json"


def file_key(contribution_id: int, filename: str) -> str:
    return f"{contribution_prefix(contribution_id)}{filename}"
