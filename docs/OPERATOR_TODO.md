# Operator TODO

The one place for actions only a human can do: credentials, money, DNS, vendor
registrations, production access, and product judgement calls. A "you'll need to
set X" said in chat and not written here is lost by the next session.
Maintained by `/operator-todo`. Never put a secret VALUE here, only its name.

Last updated: 2026-09-10

## A — Decisions

- [ ] **Approve Phase A (one FIESTA API).** Confirms: node in the path
      (`/v1/{node}/...`), `/api` folds into `/v1`, SPA talks to the API directly,
      SPA node comes from `FIESTA_NODE`. Then Claude starts A1 on a worktree branch.
      Unblocks: ROADMAP Phase A, B1, B3.
- [ ] **Hosting for the FIESTA API and frontends** (where, who pays, how deploys
      run). Unblocks: ROADMAP E1, B2.
- [ ] **Cutover shape**: `dev.earthref.org/<Node>/` first, then `earthref.org/<Node>/`
      as a proxy change (deployment.md) — confirm or change. Unblocks: E4.

## B — Credentials and access (names only)

- [ ] Production Postgres, OpenSearch, and S3 access for the FIESTA API host:
      `FIESTA_DATABASE_URL`, `FIESTA_OPENSEARCH_URL`, `FIESTA_INDEX_PREFIX` (must be
      set on the shared cluster), `FIESTA_S3_BUCKET` + `FIESTA_S3_ACCESS_KEY` /
      `FIESTA_S3_SECRET_KEY` (IAM user scoped to that bucket), `FIESTA_SECRET_KEY`,
      `FIESTA_SMTP_*`. Unblocks: E1, E2.
- [ ] **CORS on the live API** must allow the Vite dev origin (`http://localhost:5173`)
      so frontend contributors can log in from a local SPA (`FIESTA_CORS_ORIGINS`).
      Safe with bearer tokens and no cookies. Unblocks: B2.
- [ ] **EZID account** for DOI minting (username/password names TBD when C1 is built).
      Unblocks: C1 live path.
- [ ] **ORCID API client** (client id/secret, redirect URI per host). Unblocks: C2.

## C — Data

- [ ] **Where do the existing contributions live** (files + metadata) and may Claude
      read them to size the import (E2)? A read-only export is enough.

## Done

_(none yet)_
