#!/usr/bin/env bash
#
# Overbearer E2E Test Runner
# Usage: ./e2e/run-e2e.sh <namespace> <registry> <image-tag> <category>
#
# Categories: setup, proxy, api, ui, cleanup
#
set -euo pipefail

if [ -n "${KUBECONFIG_B64:-}" ]; then
  mkdir -p /root/.kube
  echo "$KUBECONFIG_B64" | base64 -d > /root/.kube/config
  export KUBECONFIG=/root/.kube/config
fi

NS="${1:?Usage: $0 <namespace> <registry> <tag> <category>}"
REGISTRY="${2:?}"
TAG="${3:?}"
CATEGORY="${4:?}"
API_INTERNAL="http://overbearer-management.${NS}.svc.cluster.local:3000"
PROXY_INTERNAL="http://overbearer-proxy.${NS}.svc.cluster.local:8080"
PASS=0
FAIL=0
ERRORS=""

check() {
  local name="$1" actual="$2" expect="$3"
  if echo "$actual" | grep -q "$expect"; then
    echo "    PASS: $name"
    PASS=$((PASS+1))
  else
    echo "    FAIL: $name"
    echo "      expected: $expect"
    echo "      got: $(echo "$actual" | head -2)"
    FAIL=$((FAIL+1))
    ERRORS="${ERRORS}\n  - ${name}"
  fi
}

wait_for_pods() {
  echo "  Waiting for pods in ${NS}..."
  for label in postgres clickhouse memcached overbearer-management overbearer-proxy; do
    kubectl -n "$NS" wait --for=condition=ready pod -l "app=${label}" --timeout=120s 2>/dev/null || true
  done
}

get_session() {
  # Create admin and get session cookie
  curl -s --retry 5 --retry-delay 2 -c /tmp/ovb-e2e-cookies \
    -X POST -H "Content-Type: application/json" \
    -d '{"username":"e2e-admin","displayName":"E2E Admin"}' \
    "${API_INTERNAL}/api/auth/setup" > /dev/null 2>&1
}

# ============================================================================
case "$CATEGORY" in

# ============================================================================
setup)
  echo "=== E2E Setup: Deploy environment ==="

  MASTER_KEY=$(openssl rand -hex 32)
  JWT_SECRET=$(openssl rand -hex 32)
  PG_PASSWORD=$(openssl rand -hex 16)

  echo "  Creating namespace ${NS}..."
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

  echo "  Creating secrets..."
  kubectl -n "$NS" create secret generic overbearer-secrets \
    --from-literal=OVERBEARER_MASTER_KEY="$MASTER_KEY" \
    --from-literal=OVERBEARER_JWT_SECRET="$JWT_SECRET" \
    --from-literal=PGPASSWORD="$PG_PASSWORD" \
    --dry-run=client -o yaml | kubectl apply -f -

  kubectl -n "$NS" create secret generic postgres-credentials \
    --from-literal=POSTGRES_USER=overbearer \
    --from-literal=POSTGRES_PASSWORD="$PG_PASSWORD" \
    --from-literal=POSTGRES_DB=overbearer \
    --dry-run=client -o yaml | kubectl apply -f -

  echo "  Deploying infrastructure..."

  # PostgreSQL
  kubectl -n "$NS" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  labels: { app: postgres }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          ports: [{ containerPort: 5432 }]
          envFrom: [{ secretRef: { name: postgres-credentials } }]
          readinessProbe:
            exec: { command: [pg_isready, -U, overbearer] }
            initialDelaySeconds: 3
            periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata: { name: postgres }
spec:
  selector: { app: postgres }
  ports: [{ port: 5432 }]
EOF

  # Memcached
  kubectl -n "$NS" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memcached
  labels: { app: memcached }
spec:
  replicas: 1
  selector: { matchLabels: { app: memcached } }
  template:
    metadata: { labels: { app: memcached } }
    spec:
      containers:
        - name: memcached
          image: memcached:1.6-alpine
          args: ["-m", "64"]
          ports: [{ containerPort: 11211 }]
---
apiVersion: v1
kind: Service
metadata: { name: memcached }
spec:
  selector: { app: memcached }
  ports: [{ port: 11211 }]
EOF

  # ClickHouse
  kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata: { name: clickhouse-config }
data:
  users-override.xml: |
    <clickhouse><users><default><password></password><networks><ip>::/0</ip></networks><profile>default</profile><quota>default</quota></default></users></clickhouse>
  init.sql: |
    CREATE DATABASE IF NOT EXISTS overbearer;
    CREATE TABLE IF NOT EXISTS overbearer.proxy_logs (
      timestamp DateTime64(3), service_name String, service_ip String,
      target_host String, target_path String, method String,
      token_type Enum8('fake'=1,'real_direct'=2,'unknown'=3),
      token_id String DEFAULT '', token_preview String DEFAULT '',
      token_encrypted String DEFAULT '', response_status UInt16, latency_ms Float32
    ) ENGINE = MergeTree() PARTITION BY toYYYYMM(timestamp) ORDER BY (timestamp, service_name)
    TTL toDateTime(timestamp) + INTERVAL 90 DAY SETTINGS index_granularity = 8192;
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clickhouse
  labels: { app: clickhouse }
spec:
  replicas: 1
  selector: { matchLabels: { app: clickhouse } }
  template:
    metadata: { labels: { app: clickhouse } }
    spec:
      containers:
        - name: clickhouse
          image: clickhouse/clickhouse-server:26.1-alpine
          ports: [{ containerPort: 8123 }]
          volumeMounts:
            - { name: config, mountPath: /docker-entrypoint-initdb.d/init.sql, subPath: init.sql }
            - { name: config, mountPath: /etc/clickhouse-server/users.d/override.xml, subPath: users-override.xml }
          readinessProbe:
            httpGet: { path: /ping, port: 8123 }
            initialDelaySeconds: 5
            periodSeconds: 3
      volumes:
        - name: config
          configMap: { name: clickhouse-config }
---
apiVersion: v1
kind: Service
metadata: { name: clickhouse }
spec:
  selector: { app: clickhouse }
  ports: [{ port: 8123 }]
EOF

  echo "  Waiting for infrastructure..."
  kubectl -n "$NS" wait --for=condition=ready pod -l app=postgres --timeout=120s
  kubectl -n "$NS" wait --for=condition=ready pod -l app=clickhouse --timeout=120s
  kubectl -n "$NS" wait --for=condition=ready pod -l app=memcached --timeout=60s

  echo "  Deploying Overbearer..."

  # RBAC
  kubectl -n "$NS" apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata: { name: overbearer-proxy }
EOF

  # Management
  kubectl -n "$NS" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: overbearer-management
  labels: { app: overbearer-management }
spec:
  replicas: 1
  selector: { matchLabels: { app: overbearer-management } }
  template:
    metadata: { labels: { app: overbearer-management } }
    spec:
      containers:
        - name: management
          image: ${REGISTRY}/management:${TAG}
          ports: [{ containerPort: 3000 }]
          env:
            - { name: PORT, value: "3000" }
            - { name: MEMCACHED_HOST, value: "memcached.${NS}.svc.cluster.local:11211" }
            - { name: CLICKHOUSE_URL, value: "http://clickhouse.${NS}.svc.cluster.local:8123" }
            - { name: CLICKHOUSE_DATABASE, value: overbearer }
            - { name: PGHOST, value: "postgres.${NS}.svc.cluster.local" }
            - { name: PGDATABASE, value: overbearer }
            - { name: PGUSER, value: overbearer }
            - { name: OVERBEARER_RP_ID, value: localhost }
            - { name: OVERBEARER_ORIGIN, value: "http://localhost:3000" }
          envFrom: [{ secretRef: { name: overbearer-secrets } }]
          readinessProbe:
            httpGet: { path: /api/health, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata: { name: overbearer-management }
spec:
  selector: { app: overbearer-management }
  ports: [{ port: 3000 }]
EOF

  # Proxy
  kubectl -n "$NS" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: overbearer-proxy
  labels: { app: overbearer-proxy }
spec:
  replicas: 1
  selector: { matchLabels: { app: overbearer-proxy } }
  template:
    metadata: { labels: { app: overbearer-proxy } }
    spec:
      serviceAccountName: overbearer-proxy
      containers:
        - name: proxy
          image: ${REGISTRY}/proxy:${TAG}
          ports: [{ containerPort: 8080 }]
          env:
            - { name: PORT, value: "8080" }
            - { name: MEMCACHED_HOST, value: "memcached.${NS}.svc.cluster.local:11211" }
            - { name: CLICKHOUSE_URL, value: "http://clickhouse.${NS}.svc.cluster.local:8123" }
            - { name: CLICKHOUSE_DATABASE, value: overbearer }
            - { name: PGHOST, value: "postgres.${NS}.svc.cluster.local" }
            - { name: PGDATABASE, value: overbearer }
            - { name: PGUSER, value: overbearer }
          envFrom: [{ secretRef: { name: overbearer-secrets } }]
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata: { name: overbearer-proxy }
spec:
  selector: { app: overbearer-proxy }
  ports: [{ port: 8080 }]
EOF

  echo "  Waiting for Overbearer..."
  kubectl -n "$NS" wait --for=condition=ready pod -l app=overbearer-management --timeout=120s
  kubectl -n "$NS" wait --for=condition=ready pod -l app=overbearer-proxy --timeout=120s

  echo "  Environment ready."
  ;;

# ============================================================================
api)
  echo "=== E2E: API Tests ==="
  wait_for_pods

  # Port-forward management for direct access
  kubectl -n "$NS" port-forward svc/overbearer-management 13000:3000 &
  PF_PID=$!
  sleep 3
  API="http://localhost:13000"
  trap "kill $PF_PID 2>/dev/null" EXIT

  echo "  --- Auth & Setup ---"
  R=$(curl -s -c /tmp/ovb-e2e-cookies -X POST -H "Content-Type: application/json" \
    -d '{"username":"e2e-admin","displayName":"E2E Admin"}' "$API/api/auth/setup")
  check "Create admin" "$R" "e2e-admin"

  R=$(curl -s -b /tmp/ovb-e2e-cookies "$API/api/auth/me")
  check "Auth me" "$R" "e2e-admin"

  R=$(curl -s "$API/api/auth/setup-status")
  check "Setup status is false" "$R" '"needsSetup":false'

  R=$(curl -s -X POST -H "Content-Type: application/json" \
    -d '{"username":"hacker"}' "$API/api/auth/setup")
  check "Setup blocked" "$R" "already completed"

  echo "  --- CA ---"
  R=$(curl -s -b /tmp/ovb-e2e-cookies -X POST "$API/api/ca/generate")
  check "Generate CA" "$R" "success"

  R=$(curl -s "$API/api/ca")
  check "CA download (public)" "$R" "BEGIN CERTIFICATE"

  echo "  --- Tokens ---"
  R=$(curl -s -b /tmp/ovb-e2e-cookies -X POST -H "Content-Type: application/json" \
    -d '{"name":"Test Key","provider":"anthropic","realToken":"sk-ant-api03-test-real-key"}' "$API/api/tokens")
  check "Create token" "$R" "fakeToken"
  TID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")

  R=$(curl -s -b /tmp/ovb-e2e-cookies "$API/api/tokens")
  check "List tokens" "$R" '"status":"active"'
  check "Created by username" "$R" '"createdBy":"e2e-admin"'
  check "Fake token visible" "$R" "fakeToken"

  if [ -n "$TID" ]; then
    R=$(curl -s -b /tmp/ovb-e2e-cookies -X POST -H "Content-Type: application/json" \
      -d '{"realToken":"sk-ant-rotated"}' "$API/api/tokens/${TID}/rotate")
    check "Rotate token" "$R" "success"

    R=$(curl -s -b /tmp/ovb-e2e-cookies -X DELETE "$API/api/tokens/${TID}")
    check "Revoke token" "$R" "success"
  fi

  echo "  --- Users ---"
  R=$(curl -s -b /tmp/ovb-e2e-cookies -X POST -H "Content-Type: application/json" \
    -d '{"username":"viewer","displayName":"Test Viewer","role":"viewer"}' "$API/api/users")
  check "Create user" "$R" "inviteUrl"

  R=$(curl -s -b /tmp/ovb-e2e-cookies "$API/api/users")
  check "List users" "$R" "viewer"

  echo "  --- RBAC ---"
  # Get viewer JWT
  JWT_SECRET=$(kubectl -n "$NS" get secret overbearer-secrets -o jsonpath='{.data.OVERBEARER_JWT_SECRET}' | base64 -d)
  VID=$(echo "$R" | python3 -c "import sys,json; print([u['id'] for u in json.load(sys.stdin)['users'] if u['username']=='viewer'][0])" 2>/dev/null || echo "")
  if [ -n "$VID" ]; then
    VT=$(node --input-type=module -e "
import { SignJWT } from 'jose';
const s = new TextEncoder().encode('$JWT_SECRET');
const t = await new SignJWT({ userId: '$VID', role: 'viewer' })
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').setIssuer('overbearer').sign(s);
console.log(t);")
    R=$(curl -s -b "overbearer_session=$VT" "$API/api/users")
    check "Viewer cant list users" "$R" "Insufficient permissions"

    R=$(curl -s -b "overbearer_session=$VT" -X POST -H "Content-Type: application/json" \
      -d '{"name":"x","provider":"x","realToken":"x"}' "$API/api/tokens")
    check "Viewer cant create tokens" "$R" "Insufficient permissions"
  fi

  R=$(curl -s "$API/api/tokens")
  check "Unauthed blocked" "$R" "Authentication required"

  echo "  --- Logs & Services ---"
  R=$(curl -s -b /tmp/ovb-e2e-cookies "$API/api/logs")
  check "Logs endpoint" "$R" '"logs"'

  R=$(curl -s -b /tmp/ovb-e2e-cookies "$API/api/services")
  check "Services endpoint" "$R" '"services"'

  echo ""
  echo "  API Tests: ${PASS} passed, ${FAIL} failed"
  [ "$FAIL" -eq 0 ] || exit 1
  ;;

# ============================================================================
proxy)
  echo "=== E2E: Proxy Tests ==="
  wait_for_pods

  # Port-forward both services
  kubectl -n "$NS" port-forward svc/overbearer-management 13000:3000 &
  PF1=$!
  kubectl -n "$NS" port-forward svc/overbearer-proxy 18080:8080 &
  PF2=$!
  sleep 3
  API="http://localhost:13000"
  PROXY="http://localhost:18080"
  trap "kill $PF1 $PF2 2>/dev/null" EXIT

  # Setup admin + CA + token
  curl -s -c /tmp/ovb-e2e-cookies -X POST -H "Content-Type: application/json" \
    -d '{"username":"proxy-admin","displayName":"Proxy Admin"}' "$API/api/auth/setup" > /dev/null 2>&1 || true
  curl -s -b /tmp/ovb-e2e-cookies -X POST "$API/api/ca/generate" > /dev/null 2>&1 || true
  curl -s "$API/api/ca" > /tmp/ovb-e2e-ca.pem

  # Restart proxy to pick up CA
  kubectl -n "$NS" rollout restart deployment/overbearer-proxy > /dev/null 2>&1
  kubectl -n "$NS" rollout status deployment/overbearer-proxy --timeout=90s > /dev/null 2>&1

  # Re-establish port forward
  kill $PF2 2>/dev/null || true
  kubectl -n "$NS" port-forward svc/overbearer-proxy 18080:8080 &
  PF2=$!
  sleep 3

  R=$(curl -s -b /tmp/ovb-e2e-cookies -X POST -H "Content-Type: application/json" \
    -d '{"name":"Proxy Test","provider":"test","realToken":"sk-real-proxy-test-key-999"}' "$API/api/tokens")
  FAKE=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['fakeToken'])" 2>/dev/null || echo "")

  echo "  --- Health ---"
  R=$(curl -s "$PROXY/healthz")
  check "Proxy health" "$R" '"ok"'

  echo "  --- Token Replacement ---"
  if [ -n "$FAKE" ]; then
    R=$(curl -s --proxy "$PROXY" --cacert /tmp/ovb-e2e-ca.pem \
      -H "Authorization: Bearer $FAKE" https://httpbin.org/headers 2>&1)
    check "HTTPS fake→real" "$R" "sk-real-proxy-test-key-999"

    R=$(curl -s --proxy "$PROXY" \
      -H "Authorization: Bearer $FAKE" http://httpbin.org/headers 2>&1)
    check "HTTP fake→real" "$R" "sk-real-proxy-test-key-999"

    R=$(curl -s --proxy "$PROXY" --cacert /tmp/ovb-e2e-ca.pem \
      -H "x-api-key: $FAKE" https://httpbin.org/headers 2>&1)
    check "x-api-key replacement" "$R" "sk-real-proxy-test-key-999"
  else
    echo "    SKIP: no fake token available"
  fi

  echo "  --- Real Token Detection ---"
  curl -s --proxy "$PROXY" --cacert /tmp/ovb-e2e-ca.pem \
    -H "Authorization: Bearer sk-real-proxy-test-key-999" \
    https://httpbin.org/get > /dev/null 2>&1

  echo "  --- Tokenless Request (not logged) ---"
  curl -s --proxy "$PROXY" --cacert /tmp/ovb-e2e-ca.pem \
    https://httpbin.org/get > /dev/null 2>&1

  # Wait for logs to flush
  sleep 5

  echo "  --- ClickHouse Pipeline ---"
  CH_POD=$(kubectl -n "$NS" get pod -l app=clickhouse -o jsonpath='{.items[0].metadata.name}')
  COUNT=$(kubectl -n "$NS" exec -i "$CH_POD" -- clickhouse-client --query "SELECT count() FROM overbearer.proxy_logs" 2>&1)
  check "Logs in ClickHouse" "$COUNT" "[0-9]"

  TYPES=$(kubectl -n "$NS" exec -i "$CH_POD" -- clickhouse-client --query \
    "SELECT token_type, count() FROM overbearer.proxy_logs GROUP BY token_type FORMAT CSV" 2>&1)
  check "Has fake entries" "$TYPES" "fake"
  check "Has real_direct entries" "$TYPES" "real_direct"

  # Check encrypted token_preview
  ENC=$(kubectl -n "$NS" exec -i "$CH_POD" -- clickhouse-client --query \
    "SELECT token_preview FROM overbearer.proxy_logs WHERE token_type='real_direct' LIMIT 1" 2>&1)
  if echo "$ENC" | grep -q "^sk-"; then
    echo "    FAIL: token_preview is plaintext"
    FAIL=$((FAIL+1))
  else
    echo "    PASS: token_preview is encrypted"
    PASS=$((PASS+1))
  fi

  echo ""
  echo "  Proxy Tests: ${PASS} passed, ${FAIL} failed"
  [ "$FAIL" -eq 0 ] || exit 1
  ;;

# ============================================================================
ui)
  echo "=== E2E: UI Tests (Puppeteer) ==="
  wait_for_pods

  kubectl -n "$NS" port-forward svc/overbearer-management 13000:3000 &
  PF_PID=$!
  sleep 3
  trap "kill $PF_PID 2>/dev/null" EXIT

  # Ensure admin exists
  curl -s -c /tmp/ovb-e2e-cookies -X POST -H "Content-Type: application/json" \
    -d '{"username":"ui-admin","displayName":"UI Admin"}' \
    "http://localhost:13000/api/auth/setup" > /dev/null 2>&1 || true

  OVERBEARER_URL="http://localhost:13000" npx tsx e2e/ui-walkthrough.ts 2>&1
  ;;

# ============================================================================
cleanup)
  echo "=== E2E Cleanup: Deleting namespace ${NS} ==="
  kubectl delete namespace "$NS" --ignore-not-found --timeout=120s
  echo "  Cleanup complete."
  ;;

*)
  echo "Unknown category: $CATEGORY"
  echo "Valid categories: setup, api, proxy, ui, cleanup"
  exit 1
  ;;
esac
