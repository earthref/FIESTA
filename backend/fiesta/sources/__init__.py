"""Data-source sync clients: what the per-node scripts in `sources/` are built from.

A node in data-source mode is fed by a script that reads its source on a
schedule (config/ops/schedules.yaml) and writes changed records through the
FIESTA API's `/v2/{node}/source` routes (`client.SourceAPI`). It never touches
FIESTA's database: its credentials are a node admin account and whatever
reading the source needs. `meteor` reads a legacy Meteor node (MagIC, KdD,
KArAr, CDR). See docs/data-sources.md.
"""
