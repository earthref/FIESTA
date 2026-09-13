#!/bin/bash
# End-to-end FIESTA workflow test against a running compose stack
# (`make up FIESTA_NODE=magic`). Exercises, all on the one /v2 API:
# register -> login -> create -> upload -> async worker processing ->
# validation -> publish -> search/facets -> download -> notification email.
#
# Ports are overridable: API_PORT, MAILPIT_PORT.
set -euo pipefail

V2=http://localhost:${API_PORT:-8000}/v2
API=$V2/magic
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
curl -sf "$V2/health-check" | json '"status: %s | repositories: %s" % (d["status"], d["repositories"])'

echo "== register =="
curl -sf -X POST "$V2/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Test User\"}" || echo "(already exists)"
echo

echo "== login =="
TOKEN=$(curl -sf -X POST "$V2/auth/login" -d "username=$EMAIL&password=$PASSWORD" | json 'd["access_token"]')
AUTH="Authorization: Bearer $TOKEN"
echo "token ok"

echo "== node config (same process, two nodes) =="
curl -sf "$API/config" | json '"magic: " + d["title"]'
curl -sf "$V2/MagIC/config" | json '"MagIC (key, any case): " + d["slug"]'
curl -s -o /dev/null -w "kdd: HTTP %{http_code} (404 = not enabled in this stack)\n" "$V2/kdd/config"

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

echo "== public search after publish (the outbox flips the index flags asynchronously) =="
TOTAL=0
for _ in $(seq 1 30); do
  TOTAL=$(curl -sf "$API/search/contribution?query=Hawaii" | json 'd["total"]')
  [ "$TOTAL" -ge 1 ] && break
  sleep 2
done
[ "$TOTAL" -ge 1 ] || { echo "TIMEOUT waiting for the published contribution to be searchable"; exit 1; }
curl -sf "$API/search/contribution?query=Hawaii&facets=true" \
  | json '"total: %d | method_codes facet: %s" % (d["total"], d["aggregations"]["method_codes"])'
curl -sf "$API/search/contribution?query=doi:%2210.1029/93JB00024%22" | json '"doi search total: %d" % d["total"]'
curl -sf "$API/search/sites?query=" | json '"sites total: %d" % d["total"]'

echo "== detail + download =="
curl -sf "$API/contributions/$CID" | json '"n sites: %d" % d["summary"]["sites"]["_n_results"]'
curl -sf "$API/contributions/$CID/download" | head -1

echo "== legacy /v1 contract (same process, frozen api.earthref.org surface) =="
V1=http://localhost:${API_PORT:-8000}/v1
curl -sf "$V1/health-check" | json '"v1 health: " + d["message"]'
curl -sf "$V1/MagIC/search/contributions?query=summary.contribution.id:$CID" | json '"v1 search: id %d of %d" % (d["results"][0]["id"], d["total"])'
curl -sf "$V1/MagIC/data?id=$CID" | head -1
curl -sf -o /dev/null -w "v1 download: HTTP %{http_code} %{content_type}\n" "$V1/MagIC/download?id=$CID&only_latest=true"
curl -s -o /dev/null -w "v1 undefined path: HTTP %{http_code}\n" "$V1/MagIC/nope"
curl -s -o /dev/null -w "v1 private without credentials: HTTP %{http_code}\n" "$V1/MagIC/private/search/contributions"

echo "== plugin route guard =="
curl -sf "$API/plugins/poles/plate-boundaries" | json '"poles on magic: %s" % d["type"]'
curl -s -o /dev/null -w "poles on kdd: HTTP %{http_code}\n" "$V2/kdd/plugins/poles/plate-boundaries"

echo "== notification email (mailpit; the worker sends it asynchronously) =="
MESSAGES=0
for _ in $(seq 1 15); do
  MESSAGES=$(curl -s "$MAILPIT/api/v2/messages" | json 'd["total"]' 2>/dev/null || echo 0)
  [ "$MESSAGES" -ge 1 ] && break
  sleep 2
done
[ "$MESSAGES" -ge 1 ] || { echo "TIMEOUT waiting for the publication email"; curl -si "$MAILPIT/api/v2/messages" | head -5; exit 1; }
curl -sf "$MAILPIT/api/v2/messages" | json '"messages: %d | latest: %s" % (d["total"], d["messages"][0]["Subject"])'

echo "ALL E2E CHECKS PASSED"
