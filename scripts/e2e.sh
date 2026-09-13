#!/bin/bash
# End-to-end FIESTA workflow test against a running compose stack
# (`make up FIESTA_NODE=magic`). Exercises, all on the one /v1 API:
# register -> login -> create -> upload -> async worker processing ->
# validation -> publish -> search/facets -> download -> the legacy
# api.earthref.org routes (Basic auth, /data, /validate) -> notification email.
#
# Ports are overridable: API_PORT, MAILPIT_PORT.
set -euo pipefail

V1=http://localhost:${API_PORT:-8000}/v1
API=$V1/magic
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

echo "== health =="
curl -sf "$V1/health-check" | json '"status: %s | repositories: %s" % (d["status"], d["repositories"])'

echo "== register =="
curl -sf -X POST "$V1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Test User\"}" || echo "(already exists)"
echo

echo "== login =="
TOKEN=$(curl -sf -X POST "$V1/auth/login" -d "username=$EMAIL&password=$PASSWORD" | json 'd["access_token"]')
AUTH="Authorization: Bearer $TOKEN"
echo "token ok"

echo "== node config (same process, two nodes) =="
curl -sf "$API/config" | json '"magic: " + d["title"]'
curl -sf "$V1/MagIC/config" | json '"MagIC (key, any case): " + d["slug"]'
curl -sf "$V1/kdd/config" | json '"kdd: " + d["title"]' || echo "(kdd not enabled in this stack)"

echo "== create contribution =="
CID=$(curl -sf -X POST "$API/private/contributions" -H "$AUTH" | json 'd["id"]')
echo "id=$CID"

echo "== upload file =="
curl -sf -X PUT "$API/private/contributions/$CID/file" -H "$AUTH" -H "Idempotency-Key: e2e-upload-$CID" -F "file=@$FILE" | json '"status: " + d["status"]'

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

echo "== plugin route guard =="
curl -sf "$API/plugins/poles/plate-boundaries" | json '"poles on magic: %s" % d["type"]'
curl -s -o /dev/null -w "poles on kdd: HTTP %{http_code}\n" "$V1/kdd/plugins/poles/plate-boundaries"

echo "== legacy api.earthref.org routes =="
curl -sf "$V1/MagIC/search/contribution?query=Hawaii" | json '"v1 search total: %d" % d["total"]'
curl -sf "$V1/magic/data/$CID" | head -1
curl -sf -X POST "$V1/MagIC/validate" -F "file=@$FILE" | json '"v1 validate is_valid: %s" % d["is_valid"]'
curl -sf -u "$EMAIL:$PASSWORD" "$V1/authenticate" | json '"v1 basic auth: " + d["email"]'

echo "== notification email (mailpit) =="
curl -sf "$MAILPIT/api/v1/messages" \
  | json '"messages: %d | latest: %s" % (d["total"], d["messages"][0]["Subject"] if d["messages"] else None)'

echo "ALL E2E CHECKS PASSED"
