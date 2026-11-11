"""KArAr data source: Meteor KArAr (earthref.org/KArAr) -> FIESTA KArAr.

Runs while FIESTA KArAr is in data-source mode (docs/data-sources.md), on the ops
scheduler (config/karar.yaml `legacy.sync`), from backend/:

    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../sources/karar.py --api http://localhost:18000 [--dry-run]

Reads the legacy `karar` index and the `karar-activated-contributions` and
`karar-contributions` buckets named in config/karar.yaml's `legacy:` block with the
FIESTA_OPENSEARCH_* / FIESTA_S3_* credentials in its environment, and writes through
the API as a KArAr node admin. It continues from the September 2026 bulk import
(checkpoints `legacy-karar`), so a run sends only what changed since. KArAr needs
nothing beyond the shared Meteor reader; a node-specific fix-up of the legacy records
belongs here, not in fiesta.sources.
"""

from fiesta.sources.meteor import main

if __name__ == "__main__":
    main("karar", __doc__.splitlines()[0])
