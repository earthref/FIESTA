"""CDR data source: Meteor CDR (earthref.org/CDR) -> FIESTA CDR.

Runs while FIESTA CDR is in data-source mode (docs/data-sources.md), on the ops
scheduler (config/cdr.yaml `legacy.sync`), from backend/:

    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../sources/cdr.py --api http://localhost:18000 \\
        --owner-map <owner_map.json> [--dry-run]

Reads the legacy `cdr-3` index named in config/cdr.yaml's `legacy:` block with the
FIESTA_OPENSEARCH_* credentials in its environment (CDR has no S3 archive: every
record is exported from its indexed tables), imports each as data model 1.0, and
writes through the API as a CDR node admin. Every cdr-3 record carries the bulk
loader's handle `cdr`, which is no account, so pass the operator's owner map
(`owner_handles: {"cdr": <steward email>}`, never in checked-in config); without it
every record is quarantined. CDR needs nothing beyond the shared Meteor reader; a
node-specific fix-up of the legacy records belongs here, not in fiesta.sources.
"""

from fiesta.sources.meteor import main

if __name__ == "__main__":
    main("cdr", __doc__.splitlines()[0])
