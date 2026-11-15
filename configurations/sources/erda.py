"""ERDA data source: the legacy EarthRef.org Digital Archive (earthref.org/ERDA) -> FIESTA ERDA.

Runs while FIESTA ERDA is in data-source mode (docs/data-sources.md), on the ops
scheduler (configurations/erda.yaml `legacy.sync`), from fiesta/backend/:

    FIESTA_SOURCE_EMAIL=... FIESTA_SOURCE_PASSWORD=... \\
        uv run python ../../configurations/sources/erda.py --api http://localhost:18000 \\
        --owner-map <owner_map.json> [--dry-run] [--refresh-all]

The legacy archive is a Perl CGI app with no API, so the source is its public
record pages, read by the same crawler as the September 2026 bulk import
(`legacy.kind: earthref-cgi`, fiesta.services.legacy_cgi) into `--state-dir`:
`pages/` and `files/` are cached between runs, so seeding the state directory
with that import's snapshot means a run fetches only what is new. Each run
re-reads the archive's home page, which lists its ten newest records, re-reads
those pages and probes every id up to the newest of them, then sends the records
whose fingerprint differs from the API's checkpoint (`legacy-erda`).
`--refresh-all` re-reads every page (about 4,900 requests at
`legacy.concurrency`), for edits to or withdrawals of older records.

Contributor names map to er_users accounts by exact full name, read with the
FIESTA_OPENSEARCH_* credentials in the environment; the unmatched go to the
steward `default_owner` from `--owner-map` (never checked in). Files listed over
`--max-file-mb` (100, as in the bulk import) are deferred and the record is
sent metadata only, as `legacy.incomplete_records` says; a later run with a
higher limit attaches them (docs/OPERATOR_TODO.md, "ERDA large files into S3").
"""

from fiesta.sources.meteor import main


def add_arguments(parser) -> None:
    parser.add_argument(
        "--refresh-all",
        action="store_true",
        help="re-read every record page, not only the newest records and new ids",
    )
    parser.add_argument(
        "--max-file-mb",
        type=float,
        default=100,
        help="defer files listed over this size; the record is sent metadata only (0: no limit)",
    )
    parser.add_argument(
        "--max-total-gb",
        type=float,
        default=20,
        help="download nothing when this run's pending files are listed at over this",
    )


def snapshot(args):
    async def read(node, state_dir, client):
        from fiesta.services.legacy_cgi import build_inventory

        return await build_inventory(
            node,
            state_dir,
            client=client,
            max_total_bytes=int(args.max_total_gb * 1000**3),
            max_file_bytes=int(args.max_file_mb * 1024**2) or None,
            refresh="all" if args.refresh_all else "new",
        )

    return read


if __name__ == "__main__":
    main(
        "erda",
        __doc__.splitlines()[0],
        kind="earthref-cgi",
        add_arguments=add_arguments,
        snapshot=snapshot,
    )
