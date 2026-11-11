"""MagIC data source: Meteor MagIC (earthref.org/MagIC) -> FIESTA MagIC.

Runs while FIESTA MagIC is in data-source mode (docs/data-sources.md), hourly on
the ops scheduler (configurations/magic.yaml `legacy.sync`, schedule magic-source), from
fiesta/backend/:

    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../../configurations/sources/magic.py --api http://localhost:18000 [--dry-run]

Reads the legacy `magic` index and the `magic-activated-contributions`,
`magic-contributions` and `magic-private-contributions` buckets named in
configurations/magic.yaml's `legacy:` block with the FIESTA_OPENSEARCH_* / FIESTA_S3_*
credentials in its environment, and writes through the API as a MagIC node admin.
It continues from the September 2026 bulk import (checkpoints `legacy-magic`), so
a run sends only the contributions created, activated or re-versioned since.

MagIC needs nothing beyond the shared Meteor reader: the one MagIC quirk, a
private key shared across a version chain, is handled by the importer (the key
follows the newest version). A node-specific fix-up of the legacy records
belongs here, not in fiesta.sources.
"""

from fiesta.sources.meteor import main

if __name__ == "__main__":
    main("magic", __doc__.splitlines()[0])
