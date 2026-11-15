"""Download the field models from their public sources, convert them and
store them where the field-models plugin reads them.

Every model in models.yaml is fetched from its original publisher (GFZ,
EarthRef ERDA, the University of Potsdam Kalmag service), checked against the
pinned sha256, converted to the B-spline layout (convert.py) and validated by
parsing it with the engine (shmodel.py). The results go to the node's storage
under the plugin's `storage_prefix` (default `field-models/`):

    <prefix>models/<name>.txt      B-spline coefficients (as published, or converted)
    <prefix>ensembles/<name>.npy   (epochs, coefficients, members) float64 cube
    <prefix>catalog.json           what is there, with citations, terms and sha256s

catalog.json is written last, so a partial run never advertises a missing file.

Run from fiesta/backend with the deployment's settings (S3 credentials in the
environment, as for the API):

    FIESTA_CONFIG_FILE=../../configurations/fiesta.yaml uv run python \\
        ../../configurations/plugins/field-models/fetch_models.py --node geomagia --upload

Options: --only NAME (repeatable; merges into the stored catalogue), --out DIR
(also write the files locally), --cache DIR (downloads, default
./field-models-cache; re-runs reuse them, so the Kalmag service sees one
request per model and statistic), --no-ensembles, --no-kalmag, --record (print
the observed sha256 of every source instead of requiring the pinned one),
--publish DIR (upload an earlier --out directory without downloading: convert
where bsdtar is, upload from where the credentials are).
RAR archives (SHA.DIF.14k, SHAWQ) need `bsdtar` (libarchive-tools) on PATH;
without it those models are skipped and reported.
"""

import argparse
import asyncio
import datetime as dt
import hashlib
import http.cookiejar
import io
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
USER_AGENT = "EarthRef-FIESTA-field-models/1.0 (+https://earthref.org)"
TIMEOUT = 1800


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def members_digest(files: dict[str, bytes]) -> str:
    """One digest for a set of files: sha256 over sorted `name sha256` lines."""
    lines = "\n".join(f"{Path(name).name} {sha256(data)}" for name, data in sorted(files.items()))
    return sha256(lines.encode())


def slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


class SourceError(Exception):
    pass


class Fetcher:
    def __init__(self, manifest: dict, cache: Path, record: bool, kalmag: bool):
        self.manifest = manifest
        self.cache = cache
        self.record = record
        self.kalmag_enabled = kalmag
        self.observed: dict[str, str] = {}
        cache.mkdir(parents=True, exist_ok=True)

    # --- downloads ---------------------------------------------------------------

    def _get(self, url: str, target: Path) -> Path:
        if target.exists():
            return target
        print(f"  downloading {url}", flush=True)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        partial = target.with_suffix(target.suffix + ".part")
        with (
            urllib.request.urlopen(request, timeout=TIMEOUT) as response,
            partial.open("wb") as out,
        ):
            shutil.copyfileobj(response, out, 1 << 20)
        partial.replace(target)
        return target

    def check(self, label: str, expected, actual: str) -> None:
        self.observed[label] = actual
        if self.record or expected is None:
            return
        if expected in ("", "TBD") or expected != actual:
            raise SourceError(f"{label}: sha256 {actual} does not match the pinned {expected}")

    def archive(self, key: str) -> Path:
        spec = self.manifest["archives"][key]
        if spec["format"] == "directory":
            return Path(spec["url"])
        target = self._get(spec["url"], self.cache / f"{key}.{spec['format']}")
        data = target.read_bytes()
        try:
            self.check(f"archive {key}", spec.get("sha256"), sha256(data))
        except SourceError:
            target.unlink()  # a stale or truncated download: fetch afresh next run
            raise
        return target

    def _rar_member(self, path: Path, member: str) -> bytes:
        tool = shutil.which("bsdtar")
        if tool is None:
            raise SourceError(f"{path.name} is a RAR archive: install bsdtar (libarchive-tools)")
        out = subprocess.run([tool, "-xOf", str(path), member], capture_output=True, check=False)
        if out.returncode != 0 or not out.stdout:
            raise SourceError(f"bsdtar could not extract {member}: {out.stderr.decode()[:200]}")
        return out.stdout

    def member(self, source: dict) -> bytes:
        key = source["archive"]
        spec = self.manifest["archives"][key]
        name = source["member"]
        if spec["format"] == "directory":
            data = self._get(spec["url"] + name, self.cache / f"{key}-{slug(name)}").read_bytes()
        elif spec["format"] == "zip":
            with zipfile.ZipFile(self.archive(key)) as z:
                data = z.read(name)
        elif spec["format"] == "rar":
            data = self._rar_member(self.archive(key), name)
        else:
            raise SourceError(f"unknown archive format {spec['format']}")
        self.check(f"{key}:{name}", source.get("sha256"), sha256(data))
        return data

    def members(self, source: dict) -> dict[str, bytes]:
        """Numbered member files matching the source's `members` pattern."""
        key = source["archive"]
        pattern = re.compile(source["members"])
        with zipfile.ZipFile(self.archive(key)) as z:
            found = sorted(
                (int(m[1]), n) for n in z.namelist() if (m := pattern.fullmatch(n)) is not None
            )
            numbers = [i for i, _ in found]
            if not found or numbers != list(range(numbers[0], numbers[-1] + 1)):
                raise SourceError(f"{key}: missing or duplicate numbered members")
            files = {n: z.read(n) for _, n in found}
        self.check(f"{key}:{source['members']}", source.get("sha256"), members_digest(files))
        return files

    def kalmag(self, source: dict) -> bytes:
        """One POST to the Kalmag form (cached in the download cache)."""
        if not self.kalmag_enabled:
            raise SourceError("Kalmag downloads disabled (--no-kalmag)")
        settings = self.manifest["kalmag"]
        page = source["kalmag"]
        fields = {
            "modelc": source["modelc"],
            "statistics": source["statistics"],
            "Nsample": str(settings["members"]),
            "SHdegree": str(source["degree"]),
            "radius": str(settings["radius"]),
            "dateInit": str(source["start"]),
            "dateEnd": str(source["end"]),
            "timeStep": str(source["step"]),
            "contact_email": "",
        }
        target = self.cache / (
            "kalmag-"
            + "-".join(
                slug(fields[k])
                for k in ("modelc", "statistics", "SHdegree", "dateInit", "dateEnd", "timeStep")
            )
            + ".zip"
        )
        if not target.exists():
            print(
                f"  requesting {fields['modelc']} {fields['statistics']} from the Kalmag service",
                flush=True,
            )
            jar = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            opener.addheaders = [("User-Agent", USER_AGENT)]
            html = opener.open(page, timeout=120).read().decode("utf-8", "replace")
            token = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', html)
            if token is None:
                raise SourceError(f"{page}: no form token")
            body = urllib.parse.urlencode({"csrfmiddlewaretoken": token[1], **fields}).encode()
            request = urllib.request.Request(page, data=body, headers={"Referer": page})
            partial = target.with_suffix(".part")
            with opener.open(request, timeout=TIMEOUT) as response, partial.open("wb") as out:
                shutil.copyfileobj(response, out, 1 << 20)
            partial.replace(target)
        data = target.read_bytes()
        if not zipfile.is_zipfile(io.BytesIO(data)):
            target.unlink()
            raise SourceError(f"{page}: the service did not return a zip")
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if source["statistics"] == "ENS":
                files = {
                    n: z.read(n)
                    for n in z.namelist()
                    if re.search(r"_ENS_Radius_[0-9.]+_\d+\.txt$", n)
                }
                self.check(
                    f"kalmag {source['modelc']} ENS", source.get("sha256"), members_digest(files)
                )
            else:
                names = [n for n in z.namelist() if n.startswith("Model/") and n.endswith(".txt")]
                if len(names) != 1:
                    raise SourceError(f"{page}: expected one model file, found {names}")
                text = z.read(names[0])
                self.check(
                    f"kalmag {source['modelc']} {source['statistics']}",
                    source.get("sha256"),
                    sha256(text),
                )
                return text
        return data

    def source_bytes(self, source: dict) -> bytes:
        return self.kalmag(source) if "kalmag" in source else self.member(source)


# --- conversion -----------------------------------------------------------------------


def build_model(fetcher: Fetcher, entry: dict, convert, shmodel):
    """The stored text and parsed model for one manifest entry."""
    raw = fetcher.source_bytes(entry["source"])
    fmt = entry["format"]
    epochs = None
    if fmt == "spline":
        text = raw.decode("latin-1")
    elif fmt == "ka-bp-spline":
        text = convert.reverse_ka_bp(raw.decode("ascii"))
    else:
        if fmt == "epoch-matrix":
            epochs = convert.read_epoch_matrix(raw.decode("ascii"))
        elif fmt == "sha-dif":
            epochs = convert.read_sha_dif(raw.decode("ascii"))
        elif fmt == "shawq-xlsx":
            epochs = convert.read_shawq(raw)
        else:
            raise SourceError(f"unknown format {fmt}")
        text = convert.convert_epochs(*epochs)
    model = shmodel.parse_model(text, entry["name"])
    if epochs is not None:
        times, rows = epochs
        g, _ = shmodel.gauss_coefficients(model, times)
        error = float(np.max(np.abs(g - np.asarray(rows))))
        if error > 1e-7:
            raise SourceError(f"{entry['name']}: converted spline misses the epochs by {error} nT")
    return text, model, epochs is not None


def build_ensemble(fetcher: Fetcher, entry: dict, model, convert):
    spec = entry["ensemble"]
    if spec["format"] == "kalmag-ens":
        times, cube = convert.kalmag_ensemble(fetcher.kalmag(spec["source"]))
    elif spec["format"] == "epoch-matrix-members":
        tables = [
            convert.read_epoch_matrix(d.decode("ascii"))
            for d in fetcher.members(spec["source"]).values()
        ]
        times = tables[0][0]
        if any(t != times for t, _ in tables):
            raise SourceError(f"{entry['name']}: ensemble member epochs disagree")
        cube = np.stack([np.asarray(rows, dtype=np.float64) for _, rows in tables], axis=2)
    else:
        raise SourceError(f"unknown ensemble format {spec['format']}")
    degree = convert.check_cube(times, cube)
    if degree != model.degree or times[0] > model.start or times[-1] < model.end:
        raise SourceError(f"{entry['name']}: ensemble degree/epochs do not match the mean model")
    out = io.BytesIO()
    np.save(out, np.ascontiguousarray(cube, dtype=np.float64), allow_pickle=False)
    return out.getvalue(), [float(t) for t in times], cube.shape[2]


def uncertainty_kind(model, record) -> str:
    if model.has_uncertainty:
        return "file"
    return "ensemble" if record["ensemble"] else "none"


def catalogue_entry(entry, model, text_key, text, interpolated, manifest):
    source = entry["source"]
    if "kalmag" in source:
        url = source["kalmag"]
    else:
        archive = manifest["archives"][source["archive"]]
        url = archive["url"] + (source["member"] if archive["format"] == "directory" else "")
    return {
        "name": entry["name"],
        "group": entry["group"],
        "author": entry["author"],
        "year": entry["year"],
        "legacy": bool(entry.get("legacy")),
        "citation": " ".join(entry["citation"].split()),
        "doi": entry.get("doi"),
        "terms": entry["terms"],
        "source_url": url,
        "source_member": source.get("member") or source.get("modelc"),
        "format": entry["format"],
        "interpolated_epochs": interpolated,
        "key": text_key,
        "sha256": sha256(text.encode("latin-1")),
        "start": model.start,
        "end": model.end,
        "degree": model.degree,
        "splines": model.splines,
        "has_uncertainty": model.has_uncertainty,
        "ensemble": None,
    }


async def upload(node_slug: str, prefix: str, files: dict[str, bytes], catalog: dict, merge: bool):
    from fiesta.nodeconfig import get_deployment
    from fiesta.storage import Storage

    node = get_deployment().node_for(node_slug)
    storage = Storage.for_node(node)
    await storage.ensure_bucket()
    if merge and await storage.exists(prefix + "catalog.json"):
        stored = await storage.get_json(prefix + "catalog.json")
        catalog["models"] = {**stored.get("models", {}), **catalog["models"]}
    for key, data in files.items():
        kind = "application/octet-stream" if key.endswith(".npy") else "text/plain"
        print(
            f"  uploading {node.bucket}/{node.storage_prefix}{prefix}{key} ({len(data):,} bytes)",
            flush=True,
        )
        await storage.put_bytes(prefix + key, data, kind)
    await storage.put_bytes(
        prefix + "catalog.json", json.dumps(catalog, indent=1).encode(), "application/json"
    )
    print(
        f"  wrote {node.bucket}/{node.storage_prefix}{prefix}catalog.json "
        f"({len(catalog['models'])} models)"
    )


def publish(folder: Path, node_slug: str, prefix: str, shmodel) -> int:
    """Upload a --out directory: every file its catalog.json lists, after
    checking its sha256 (and parsing each model)."""
    catalog = json.loads((folder / "catalog.json").read_text())
    files: dict[str, bytes] = {}
    for name, record in catalog["models"].items():
        stored = [(record["key"], record["sha256"])]
        if record["ensemble"]:
            stored.append((record["ensemble"]["key"], record["ensemble"]["sha256"]))
        for key, digest in stored:
            data = (folder / key).read_bytes()
            if sha256(data) != digest:
                raise SystemExit(f"{folder / key}: sha256 does not match catalog.json")
            files[key] = data
        shmodel.parse_model(files[record["key"]].decode("latin-1"), name)
    asyncio.run(upload(node_slug, prefix, files, catalog, merge=True))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--node", default="geomagia", help="node slug whose storage receives the models"
    )
    parser.add_argument("--only", action="append", default=[], help="model name (repeatable)")
    parser.add_argument("--cache", type=Path, default=Path("field-models-cache"))
    parser.add_argument("--out", type=Path, help="also write the files to this directory")
    parser.add_argument("--upload", action="store_true", help="write to the node's storage")
    parser.add_argument(
        "--prefix", help="storage prefix (default: the plugin option, field-models/)"
    )
    parser.add_argument("--no-ensembles", action="store_true")
    parser.add_argument("--no-kalmag", action="store_true")
    parser.add_argument(
        "--record", action="store_true", help="print observed sha256s; do not enforce pins"
    )
    parser.add_argument(
        "--publish",
        type=Path,
        help="upload an earlier --out directory (checked against its catalog.json) instead "
        "of downloading; merges into the stored catalogue",
    )
    args = parser.parse_args(argv)

    os.environ.setdefault("FIESTA_NODE_CONFIG_SOURCE", "files")
    os.environ.setdefault("FIESTA_PLUGINS_DIR", str(HERE.parent))
    from fiesta.plugins import field_models as plugin

    convert, shmodel = plugin.convert, plugin.shmodel
    manifest_text = (HERE / "models.yaml").read_text(encoding="utf-8")
    manifest = yaml.safe_load(manifest_text)
    prefix = args.prefix or plugin.FieldModelsOptions().storage_prefix
    if args.publish:
        return publish(args.publish, args.node, prefix, shmodel)
    fetcher = Fetcher(manifest, args.cache, args.record, not args.no_kalmag)
    wanted = set(args.only)
    unknown = wanted - {e["name"] for e in manifest["models"]}
    if unknown:
        parser.error(f"unknown model(s): {sorted(unknown)}")
    files: dict[str, bytes] = {}
    models: dict[str, dict] = {}
    failures: dict[str, str] = {}
    for entry in manifest["models"]:
        name = entry["name"]
        if wanted and name not in wanted:
            continue
        print(f"{name}", flush=True)
        try:
            text, model, interpolated = build_model(fetcher, entry, convert, shmodel)
        except (SourceError, ValueError, OSError, zipfile.BadZipFile) as exc:
            failures[name] = str(exc)
            print(f"  skipped: {exc}", flush=True)
            continue
        key = f"models/{slug(name)}.txt"
        files[key] = text.encode("latin-1")
        record = catalogue_entry(entry, model, key, text, interpolated, manifest)
        if "ensemble" in entry and not args.no_ensembles:
            try:
                data, times, members = build_ensemble(fetcher, entry, model, convert)
                ens_key = f"ensembles/{slug(name)}.npy"
                files[ens_key] = data
                record["ensemble"] = {
                    "key": ens_key,
                    "sha256": sha256(data),
                    "members": members,
                    "kind": entry["ensemble"]["kind"],
                    "times": times,
                    "degree": model.degree,
                    "bytes": len(data),
                }
            except (SourceError, ValueError, OSError, zipfile.BadZipFile) as exc:
                failures[f"{name} ensemble"] = str(exc)
                print(f"  ensemble skipped: {exc}", flush=True)
        models[name] = record
        print(
            f"  degree {model.degree}, {model.start:g} to {model.end:g}, "
            f"uncertainty={uncertainty_kind(model, record)}",
            flush=True,
        )
    catalog = {
        "format": 1,
        "generated": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "manifest_sha256": sha256(manifest_text.encode()),
        "models": models,
        "unavailable": {
            k: " ".join(v.split()) for k, v in (manifest.get("unavailable") or {}).items()
        },
    }
    if args.out:
        for key, data in files.items():
            path = args.out / key
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (args.out / "catalog.json").write_text(json.dumps(catalog, indent=1))
        print(f"wrote {len(files)} files and catalog.json to {args.out}")
    if args.upload:
        asyncio.run(upload(args.node, prefix, files, catalog, merge=bool(wanted)))
    if args.record:
        print("\nobserved sha256:")
        for label, digest in fetcher.observed.items():
            print(f"  {label}: {digest}")
    if failures:
        print("\nnot converted:")
        for name, reason in failures.items():
            print(f"  {name}: {reason}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
