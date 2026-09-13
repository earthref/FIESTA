#!/bin/bash
# Logical restore rehearsal for the isolated Phase M test project only.
# Run make test-phase-m first. Never uses the main project's .env or database.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -p fiesta-phase-m-test -f compose.phase-m-test.yml)
RESTORE_DATABASE="fiesta_restore_$(date +%s)_$$"
DUMP=$(mktemp)
cleanup() {
  rm -f "$DUMP"
  "${COMPOSE[@]}" exec -T postgres dropdb -U fiesta --if-exists "$RESTORE_DATABASE"
}
trap cleanup EXIT
"${COMPOSE[@]}" exec -T postgres pg_dump -U fiesta -Fc fiesta > "$DUMP"
"${COMPOSE[@]}" exec -T postgres createdb -U fiesta "$RESTORE_DATABASE"
"${COMPOSE[@]}" exec -T postgres pg_restore -U fiesta -d "$RESTORE_DATABASE" < "$DUMP"
# Verify complete shared account rows (including credentials and settings) without
# printing them, then verify retained history and rebuild a separate search alias.
QUERY="SELECT md5(string_agg(row_to_json(u)::text, '' ORDER BY u.id)) FROM public.users u"
BEFORE=$("${COMPOSE[@]}" exec -T postgres psql -U fiesta -d fiesta -Atc "$QUERY")
AFTER=$("${COMPOSE[@]}" exec -T postgres psql -U fiesta -d "$RESTORE_DATABASE" -Atc "$QUERY")
[[ "$BEFORE" == "$AFTER" ]]
"${COMPOSE[@]}" run --no-deps --rm \
  -e "FIESTA_DATABASE_URL=postgresql+asyncpg://fiesta:fiesta@postgres:5432/$RESTORE_DATABASE" \
  -e "FIESTA_INDEX_PREFIX=$RESTORE_DATABASE-" \
  tests sh -c 'fiesta verify-storage && fiesta rebuild --yes && fiesta verify-storage'
echo "Logical restore rehearsal passed; production PITR remains an operator gate."
