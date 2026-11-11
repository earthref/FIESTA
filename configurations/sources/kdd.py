"""KdD data source: Meteor KdD (earthref.org/KdD) -> FIESTA KdD.

Runs while FIESTA KdD is in data-source mode (docs/data-sources.md), on the ops
scheduler (configurations/ops/schedules.yaml: kdd-source), from fiesta/backend/:

    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../../configurations/sources/kdd.py --api http://localhost:18000 [--dry-run]

Reads the legacy `kdd` index and `kdd-activated-contributions` bucket named in
configurations/kdd.yaml's `legacy:` block with the FIESTA_OPENSEARCH_* / FIESTA_S3_*
credentials in its environment, and writes through the API as a KdD node admin.
KdD needs nothing beyond the shared Meteor reader; a node-specific fix-up of the
legacy records belongs here, not in fiesta.sources.
"""

from fiesta.sources.meteor import main

if __name__ == "__main__":
    main("kdd", __doc__.splitlines()[0])
