#!/bin/bash
# End-to-end FIESTA workflow test against a running compose stack
# (`make up-public-api`). Exercises: register -> login -> create -> upload ->
# async worker processing -> validation -> publish -> search/facets ->
# download -> public /v1 API -> notification email.
#
# Ports are overridable: BACKEND_PORT, PUBLIC_API_PORT, MAILPIT_PORT.
set -euo pipefail

API=http://localhost:${BACKEND_PORT:-8000}/api
PUB=http://localhost:${PUBLIC_API_PORT:-8001}/v1
MAILPIT=http://localhost:${MAILPIT_PORT:-8025}
EMAIL=${E2E_EMAIL:-test@earthref.org}
PASSWORD=${E2E_PASSWORD:-testpassword}

FILE=$(mktemp --suffix=.txt)
trap 'rm -f "$FILE"' EXIT
cat > "$FILE" <<'EOF'
tab delimited	contribution
id	version	data_model_version	reference	lab_names
12345	1	3.0	10.1029/93JB00024	Paleomagnetic Laboratory (AGICO Inc., Czech Republic)
>>>>>>>>>>
tab delimited	locations
location	location_type	geologic_classes	lithologies	age_unit	lat_s	lat_n	lon_w	lon_e
Hawaii	Outcrop	Igneous	Basalt	Ma	19.0	20.3	203.9	205.2
>>>>>>>>>>
tab delimited	sites
site	location	citations	geologic_types	geologic_classes	lithologies	age_unit	lat	lon	method_codes
HW01	Hawaii	This study	Lava Flow	Igneous	Basalt	Ma	19.5	204.5	LP-DC3:SM-VSM
HW02	Hawaii	This study	Lava Flow	Igneous	Basalt	Ma	19.7	204.6	LP-DC3
EOF

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "== register =="
curl -sf -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Test User\"}" || echo "(already exists)"
echo

echo "== login =="
TOKEN=$(curl -sf -X POST "$API/auth/login" -d "username=$EMAIL&password=$PASSWORD" | json 'd["access_token"]')
AUTH="Authorization: Bearer $TOKEN"
echo "token ok"

echo "== create contribution =="
CID=$(curl -sf -X POST "$API/private/contributions" -H "$AUTH" | json 'd["id"]')
echo "id=$CID"

echo "== upload file =="
curl -sf -X PUT "$API/private/contributions/$CID/file" -H "$AUTH" -F "file=@$FILE" | json '"status: " + d["status"]'

echo "== wait for worker =="
STATUS=unknown
for _ in $(seq 1 30); do
  STATUS=$(curl -sf "$API/private/contributions/$CID" -H "$AUTH" | json 'd["status"]')
  echo "  status: $STATUS"
  [ "$STATUS" = ready ] && break
  [ "$STATUS" = failed ] && { curl -s "$API/private/contributions/$CID" -H "$AUTH"; exit 1; }
  sleep 2
done
[ "$STATUS" = ready ] || { echo "TIMEOUT waiting for worker"; exit 1; }

echo "== validation result =="
curl -sf "$API/private/contributions/$CID/validation" -H "$AUTH" \
  | json '"is_valid: %s | errors: %d | warnings: %d" % (d["is_valid"], len(d["errors"]), len(d["warnings"]))'

echo "== publish =="
curl -sf -X POST "$API/private/contributions/$CID/activate" -H "$AUTH" | json '"activated: " + str(d["is_activated"])'

echo "== public search after publish =="
curl -sf "$API/search/contribution?query=Hawaii&facets=true" \
  | json '"total: %d | method_codes facet: %s" % (d["total"], d["aggregations"]["method_codes"])'
curl -sf "$API/search/contribution?query=doi:%2210.1029/93JB00024%22" | json '"doi search total: %d" % d["total"]'
curl -sf "$API/search/sites?query=" | json '"sites total: %d" % d["total"]'

echo "== detail + download =="
curl -sf "$API/contributions/$CID" | json '"n sites: %d" % d["summary"]["sites"]["_n_results"]'
curl -sf "$API/contributions/$CID/download" | head -1

echo "== public API (/v1) =="
curl -sf "$PUB/MagIC/search/contribution?query=Hawaii" | json '"v1 search total: %d" % d["total"]'
curl -sf "$PUB/magic/data/$CID" | head -1
curl -sf -X POST "$PUB/MagIC/validate" -F "file=@$FILE" | json '"v1 validate is_valid: %s" % d["is_valid"]'
curl -sf -u "$EMAIL:$PASSWORD" "$PUB/authenticate" | json '"v1 basic auth: " + d["email"]'

echo "== notification email (mailpit) =="
curl -sf "$MAILPIT/api/v1/messages" \
  | json '"messages: %d | latest: %s" % (d["total"], d["messages"][0]["Subject"] if d["messages"] else None)'

echo "ALL E2E CHECKS PASSED"
