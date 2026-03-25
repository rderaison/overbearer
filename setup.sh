#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Overbearer Installer
# Generates Kubernetes manifests for deploying Overbearer.
# ============================================================================

BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}"
echo "  ┌─────────────────────────────────┐"
echo "  │        OVERBEARER SETUP         │"
echo "  │   API Token Management Proxy    │"
echo "  └─────────────────────────────────┘"
echo -e "${NC}"

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

ask() {
  local prompt="$1" default="$2" var="$3"
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BOLD}$prompt${NC} ${DIM}[$default]${NC}: ")" input
    eval "$var=\"${input:-$default}\""
  else
    read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" input
    eval "$var=\"$input\""
  fi
}

ask_yn() {
  local prompt="$1" default="$2" var="$3"
  read -rp "$(echo -e "${BOLD}$prompt${NC} ${DIM}[$default]${NC}: ")" input
  input="${input:-$default}"
  case "$input" in
    [yY]*) eval "$var=yes" ;;
    *) eval "$var=no" ;;
  esac
}

generate_hex() {
  openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | xxd -p | tr -d '\n' | head -c "$(($1*2))"
}

# ---------------------------------------------------------------------------
# Collect configuration
# ---------------------------------------------------------------------------

echo -e "${YELLOW}General${NC}"
ask "Kubernetes namespace" "overbearer" NAMESPACE
ask "Container image registry" "ghcr.io/overbearer" REGISTRY
ask "Image tag" "latest" IMAGE_TAG

echo ""
echo -e "${YELLOW}Hostnames${NC}"
ask "Management UI hostname (for TLS & passkeys)" "" MGMT_HOSTNAME
ask "Proxy hostname" "" PROXY_HOSTNAME

echo ""
echo -e "${YELLOW}Networking${NC}"
ask_yn "Use LoadBalancer services? (requires MetalLB or cloud LB)" "y" USE_LB
MGMT_LB_IP=""
PROXY_LB_IP=""
if [ "$USE_LB" = "yes" ]; then
  ask "Management LoadBalancer IP (leave empty for auto)" "" MGMT_LB_IP
  ask "Proxy LoadBalancer IP (leave empty for auto)" "" PROXY_LB_IP
fi

echo ""
echo -e "${YELLOW}Storage${NC}"
ask "Storage class (leave empty for emptyDir / testing)" "" STORAGE_CLASS
POSTGRES_SIZE="5Gi"
CLICKHOUSE_SIZE="20Gi"
if [ -n "$STORAGE_CLASS" ]; then
  ask "PostgreSQL volume size" "5Gi" POSTGRES_SIZE
  ask "ClickHouse volume size" "20Gi" CLICKHOUSE_SIZE
fi

echo ""
echo -e "${YELLOW}Kafka${NC}"
ask_yn "Use Kafka for log shipping? (recommended for production)" "y" USE_KAFKA
KAFKA_BROKERS=""
KAFKA_TOPIC="overbearer.proxy-logs"
if [ "$USE_KAFKA" = "yes" ]; then
  ask "Kafka broker(s) (comma-separated)" "" KAFKA_BROKERS
  ask "Kafka topic" "$KAFKA_TOPIC" KAFKA_TOPIC
fi

echo ""
echo -e "${YELLOW}Scaling${NC}"
ask "Proxy replicas (min for HPA)" "3" PROXY_MIN_REPLICAS
ask "Proxy max replicas (max for HPA)" "50" PROXY_MAX_REPLICAS

# ---------------------------------------------------------------------------
# Generate secrets
# ---------------------------------------------------------------------------

MASTER_KEY=$(generate_hex 32)
JWT_SECRET=$(generate_hex 32)
PG_PASSWORD=$(generate_hex 16)

# ---------------------------------------------------------------------------
# Create output directory
# ---------------------------------------------------------------------------

OUTDIR="./generated"
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR/storage" "$OUTDIR/deployments" "$OUTDIR/network"

echo ""
echo -e "${CYAN}Generating manifests in ${OUTDIR}/...${NC}"

# ---------------------------------------------------------------------------
# 01-namespace.yaml
# ---------------------------------------------------------------------------

cat > "$OUTDIR/01-namespace.yaml" <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
  labels:
    app.kubernetes.io/part-of: overbearer
EOF

# ---------------------------------------------------------------------------
# 02-secrets.yaml
# ---------------------------------------------------------------------------

cat > "$OUTDIR/02-secrets.yaml" <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: overbearer-secrets
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  OVERBEARER_MASTER_KEY: "${MASTER_KEY}"
  OVERBEARER_JWT_SECRET: "${JWT_SECRET}"
  PGPASSWORD: "${PG_PASSWORD}"
---
apiVersion: v1
kind: Secret
metadata:
  name: postgres-credentials
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  POSTGRES_USER: "overbearer"
  POSTGRES_PASSWORD: "${PG_PASSWORD}"
  POSTGRES_DB: "overbearer"
EOF

# ---------------------------------------------------------------------------
# Storage: PostgreSQL
# ---------------------------------------------------------------------------

PG_VOLUME_SPEC="emptyDir: {}"
if [ -n "$STORAGE_CLASS" ]; then
  PG_VOLUME_SPEC="persistentVolumeClaim:
            claimName: postgres-data"
  cat > "$OUTDIR/storage/postgres-pvc.yaml" <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: ${NAMESPACE}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${STORAGE_CLASS}
  resources:
    requests:
      storage: ${POSTGRES_SIZE}
EOF
fi

cat > "$OUTDIR/storage/postgres.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: ${NAMESPACE}
  labels:
    app: postgres
    app.kubernetes.io/part-of: overbearer
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
          envFrom:
            - secretRef:
                name: postgres-credentials
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
          livenessProbe:
            exec:
              command: [pg_isready, -U, overbearer]
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            exec:
              command: [pg_isready, -U, overbearer]
            initialDelaySeconds: 5
            periodSeconds: 5
      volumes:
        - name: data
          ${PG_VOLUME_SPEC}
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: ${NAMESPACE}
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
  type: ClusterIP
EOF

# ---------------------------------------------------------------------------
# Storage: ClickHouse
# ---------------------------------------------------------------------------

CH_VOLUME_SPEC="emptyDir: {}"
if [ -n "$STORAGE_CLASS" ]; then
  CH_VOLUME_SPEC="persistentVolumeClaim:
            claimName: clickhouse-data"
  cat > "$OUTDIR/storage/clickhouse-pvc.yaml" <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: clickhouse-data
  namespace: ${NAMESPACE}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${STORAGE_CLASS}
  resources:
    requests:
      storage: ${CLICKHOUSE_SIZE}
EOF
fi

# Build ClickHouse init SQL
CH_KAFKA_TABLE=""
if [ "$USE_KAFKA" = "yes" ] && [ -n "$KAFKA_BROKERS" ]; then
  CH_KAFKA_TABLE="
    CREATE TABLE IF NOT EXISTS overbearer.proxy_logs_kafka (
        timestamp String,
        service_name String,
        service_ip String,
        target_host String,
        target_path String,
        method String,
        token_type String,
        token_id String,
        token_preview String,
        token_encrypted String,
        response_status UInt16,
        latency_ms Float32
    ) ENGINE = Kafka()
    SETTINGS
        kafka_broker_list = '${KAFKA_BROKERS}',
        kafka_topic_list = '${KAFKA_TOPIC}',
        kafka_group_name = 'clickhouse_overbearer',
        kafka_format = 'JSONEachRow',
        kafka_num_consumers = 1,
        kafka_skip_broken_messages = 100,
        kafka_poll_timeout_ms = 500;

    CREATE MATERIALIZED VIEW IF NOT EXISTS overbearer.proxy_logs_mv TO overbearer.proxy_logs AS
    SELECT
        parseDateTimeBestEffort(timestamp) AS timestamp,
        service_name, service_ip, target_host, target_path, method,
        token_type, token_id, token_preview, token_encrypted,
        response_status, latency_ms
    FROM overbearer.proxy_logs_kafka;"
fi

cat > "$OUTDIR/storage/clickhouse.yaml" <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: clickhouse-config
  namespace: ${NAMESPACE}
data:
  users-override.xml: |
    <clickhouse>
      <users>
        <default>
          <password></password>
          <networks><ip>::/0</ip></networks>
          <profile>default</profile>
          <quota>default</quota>
        </default>
      </users>
    </clickhouse>
  init.sql: |
    CREATE DATABASE IF NOT EXISTS overbearer;

    CREATE TABLE IF NOT EXISTS overbearer.proxy_logs (
        timestamp DateTime64(3),
        service_name String,
        service_ip String,
        target_host String,
        target_path String,
        method String,
        token_type Enum8('fake' = 1, 'real_direct' = 2, 'unknown' = 3),
        token_id String DEFAULT '',
        token_preview String DEFAULT '',
        token_encrypted String DEFAULT '',
        response_status UInt16,
        latency_ms Float32
    ) ENGINE = MergeTree()
    PARTITION BY toYYYYMM(timestamp)
    ORDER BY (timestamp, service_name)
    TTL toDateTime(timestamp) + INTERVAL 90 DAY
    SETTINGS index_granularity = 8192;
    ${CH_KAFKA_TABLE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clickhouse
  namespace: ${NAMESPACE}
  labels:
    app: clickhouse
    app.kubernetes.io/part-of: overbearer
spec:
  replicas: 1
  selector:
    matchLabels:
      app: clickhouse
  template:
    metadata:
      labels:
        app: clickhouse
    spec:
      containers:
        - name: clickhouse
          image: clickhouse/clickhouse-server:26.1-alpine
          ports:
            - containerPort: 8123
              name: http
            - containerPort: 9000
              name: native
          volumeMounts:
            - name: data
              mountPath: /var/lib/clickhouse
            - name: config
              mountPath: /docker-entrypoint-initdb.d/init.sql
              subPath: init.sql
            - name: config
              mountPath: /etc/clickhouse-server/users.d/override.xml
              subPath: users-override.xml
          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "2000m"
          livenessProbe:
            httpGet:
              path: /ping
              port: 8123
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ping
              port: 8123
            initialDelaySeconds: 5
            periodSeconds: 5
      volumes:
        - name: data
          ${CH_VOLUME_SPEC}
        - name: config
          configMap:
            name: clickhouse-config
---
apiVersion: v1
kind: Service
metadata:
  name: clickhouse
  namespace: ${NAMESPACE}
spec:
  selector:
    app: clickhouse
  ports:
    - port: 8123
      targetPort: 8123
      name: http
    - port: 9000
      targetPort: 9000
      name: native
  type: ClusterIP
EOF

# ---------------------------------------------------------------------------
# Storage: Memcached
# ---------------------------------------------------------------------------

cat > "$OUTDIR/storage/memcached.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memcached
  namespace: ${NAMESPACE}
  labels:
    app: memcached
    app.kubernetes.io/part-of: overbearer
spec:
  replicas: 1
  selector:
    matchLabels:
      app: memcached
  template:
    metadata:
      labels:
        app: memcached
    spec:
      containers:
        - name: memcached
          image: memcached:1.6-alpine
          args: ["-m", "256", "-c", "4096", "-t", "4"]
          ports:
            - containerPort: 11211
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            tcpSocket:
              port: 11211
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: memcached
  namespace: ${NAMESPACE}
spec:
  selector:
    app: memcached
  ports:
    - port: 11211
      targetPort: 11211
  type: ClusterIP
EOF

# ---------------------------------------------------------------------------
# Deployments: Proxy
# ---------------------------------------------------------------------------

KAFKA_ENV=""
if [ "$USE_KAFKA" = "yes" ] && [ -n "$KAFKA_BROKERS" ]; then
  KAFKA_ENV="            - name: KAFKA_BROKERS
              value: \"${KAFKA_BROKERS}\"
            - name: KAFKA_TOPIC
              value: \"${KAFKA_TOPIC}\""
else
  KAFKA_ENV="            - name: CLICKHOUSE_URL
              value: \"http://clickhouse.${NAMESPACE}.svc.cluster.local:8123\"
            - name: CLICKHOUSE_DATABASE
              value: \"overbearer\""
fi

PROXY_TLS_HOSTNAMES="${PROXY_HOSTNAME}"
[ -n "$PROXY_HOSTNAME" ] && PROXY_TLS_HOSTNAMES="${PROXY_HOSTNAME},overbearer-proxy,overbearer-proxy.${NAMESPACE}.svc.cluster.local"

cat > "$OUTDIR/deployments/proxy.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: overbearer-proxy
  namespace: ${NAMESPACE}
  labels:
    app: overbearer-proxy
    app.kubernetes.io/part-of: overbearer
spec:
  replicas: ${PROXY_MIN_REPLICAS}
  selector:
    matchLabels:
      app: overbearer-proxy
  template:
    metadata:
      labels:
        app: overbearer-proxy
    spec:
      serviceAccountName: overbearer-proxy
      containers:
        - name: proxy
          image: ${REGISTRY}/proxy:${IMAGE_TAG}
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 8443
              name: https
          env:
            - name: PORT
              value: "8080"
            - name: TLS_PORT
              value: "8443"
            - name: PROXY_TLS_HOSTNAMES
              value: "${PROXY_TLS_HOSTNAMES}"
            - name: MEMCACHED_HOST
              value: "memcached.${NAMESPACE}.svc.cluster.local:11211"
${KAFKA_ENV}
            - name: PGHOST
              value: "postgres.${NAMESPACE}.svc.cluster.local"
            - name: PGDATABASE
              value: "overbearer"
            - name: PGUSER
              value: "overbearer"
          envFrom:
            - secretRef:
                name: overbearer-secrets
          resources:
            requests:
              memory: "128Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: overbearer-proxy
  namespace: ${NAMESPACE}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: overbearer-proxy
  minReplicas: ${PROXY_MIN_REPLICAS}
  maxReplicas: ${PROXY_MAX_REPLICAS}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
EOF

# ---------------------------------------------------------------------------
# Deployments: Management
# ---------------------------------------------------------------------------

cat > "$OUTDIR/deployments/management.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: overbearer-management
  namespace: ${NAMESPACE}
  labels:
    app: overbearer-management
    app.kubernetes.io/part-of: overbearer
spec:
  replicas: 1
  selector:
    matchLabels:
      app: overbearer-management
  template:
    metadata:
      labels:
        app: overbearer-management
    spec:
      containers:
        - name: management
          image: ${REGISTRY}/management:${IMAGE_TAG}
          ports:
            - containerPort: 3000
              name: http
            - containerPort: 3443
              name: https
          env:
            - name: PORT
              value: "3000"
            - name: TLS_PORT
              value: "3443"
            - name: MEMCACHED_HOST
              value: "memcached.${NAMESPACE}.svc.cluster.local:11211"
            - name: CLICKHOUSE_URL
              value: "http://clickhouse.${NAMESPACE}.svc.cluster.local:8123"
            - name: CLICKHOUSE_DATABASE
              value: "overbearer"
            - name: PGHOST
              value: "postgres.${NAMESPACE}.svc.cluster.local"
            - name: PGDATABASE
              value: "overbearer"
            - name: PGUSER
              value: "overbearer"
            - name: OVERBEARER_RP_ID
              value: "${MGMT_HOSTNAME}"
            - name: OVERBEARER_ORIGIN
              value: "https://${MGMT_HOSTNAME}"
          envFrom:
            - secretRef:
                name: overbearer-secrets
          resources:
            requests:
              memory: "128Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
EOF

# ---------------------------------------------------------------------------
# Network: Services
# ---------------------------------------------------------------------------

MGMT_SVC_TYPE="ClusterIP"
MGMT_LB_ANNOTATION=""
PROXY_SVC_TYPE="ClusterIP"
PROXY_LB_ANNOTATION=""

if [ "$USE_LB" = "yes" ]; then
  MGMT_SVC_TYPE="LoadBalancer"
  PROXY_SVC_TYPE="LoadBalancer"
  if [ -n "$MGMT_LB_IP" ]; then
    MGMT_LB_ANNOTATION="  annotations:
    metallb.universe.tf/loadBalancerIPs: \"${MGMT_LB_IP}\""
  fi
  if [ -n "$PROXY_LB_IP" ]; then
    PROXY_LB_ANNOTATION="  annotations:
    metallb.universe.tf/loadBalancerIPs: \"${PROXY_LB_IP}\""
  fi
fi

cat > "$OUTDIR/network/services.yaml" <<EOF
apiVersion: v1
kind: Service
metadata:
  name: overbearer-management
  namespace: ${NAMESPACE}
  labels:
    app: overbearer-management
    app.kubernetes.io/part-of: overbearer
${MGMT_LB_ANNOTATION}
spec:
  selector:
    app: overbearer-management
  ports:
    - port: 443
      targetPort: 3443
      name: https
    - port: 80
      targetPort: 3000
      name: http
  type: ${MGMT_SVC_TYPE}
---
apiVersion: v1
kind: Service
metadata:
  name: overbearer-proxy
  namespace: ${NAMESPACE}
  labels:
    app: overbearer-proxy
    app.kubernetes.io/part-of: overbearer
${PROXY_LB_ANNOTATION}
spec:
  selector:
    app: overbearer-proxy
  ports:
    - port: 8080
      targetPort: 8080
      name: http
    - port: 8443
      targetPort: 8443
      name: https
  type: ${PROXY_SVC_TYPE}
EOF

# ---------------------------------------------------------------------------
# Network: RBAC (proxy needs to read pods/services for identification)
# ---------------------------------------------------------------------------

cat > "$OUTDIR/network/rbac.yaml" <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: overbearer-proxy
  namespace: ${NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: overbearer-proxy-reader
rules:
  - apiGroups: [""]
    resources: [pods, services, endpoints]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: overbearer-proxy-reader
subjects:
  - kind: ServiceAccount
    name: overbearer-proxy
    namespace: ${NAMESPACE}
roleRef:
  kind: ClusterRole
  name: overbearer-proxy-reader
  apiGroup: rbac.authorization.k8s.io
EOF

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo -e "${GREEN}${BOLD}Manifests generated successfully!${NC}"
echo ""
echo -e "  ${OUTDIR}/"
echo -e "  ├── 01-namespace.yaml"
echo -e "  ├── 02-secrets.yaml       ${DIM}(contains encryption keys)${NC}"
echo -e "  ├── storage/"
if [ -n "$STORAGE_CLASS" ]; then
echo -e "  │   ├── postgres-pvc.yaml"
echo -e "  │   ├── clickhouse-pvc.yaml"
fi
echo -e "  │   ├── postgres.yaml"
echo -e "  │   ├── clickhouse.yaml"
echo -e "  │   └── memcached.yaml"
echo -e "  ├── deployments/"
echo -e "  │   ├── proxy.yaml"
echo -e "  │   └── management.yaml"
echo -e "  └── network/"
echo -e "      ├── services.yaml"
echo -e "      └── rbac.yaml"
echo ""
echo -e "${BOLD}To deploy:${NC}"
echo ""
echo "  kubectl apply -f ${OUTDIR}/01-namespace.yaml"
echo "  kubectl apply -f ${OUTDIR}/02-secrets.yaml"
echo "  kubectl apply -f ${OUTDIR}/storage/"
echo "  kubectl apply -f ${OUTDIR}/network/"
echo "  # Wait for storage to be ready:"
echo "  kubectl -n ${NAMESPACE} wait --for=condition=ready pod -l app=postgres --timeout=60s"
echo "  kubectl -n ${NAMESPACE} wait --for=condition=ready pod -l app=clickhouse --timeout=60s"
echo "  kubectl -n ${NAMESPACE} wait --for=condition=ready pod -l app=memcached --timeout=60s"
echo "  # Deploy Overbearer:"
echo "  kubectl apply -f ${OUTDIR}/deployments/"
echo ""
echo -e "${BOLD}After deployment:${NC}"
echo ""
echo "  1. Open https://${MGMT_HOSTNAME}/ and create your admin account"
echo "  2. Go to Settings → Generate CA"
echo "  3. Create token mappings and configure your services"
echo ""
echo -e "${BOLD}Configure services to use the proxy:${NC}"
echo ""
echo "  HTTPS_PROXY=https://${PROXY_HOSTNAME}:8443"
echo "  # or"
echo "  HTTP_PROXY=http://${PROXY_HOSTNAME}:8080"
echo ""
echo "  # Services must trust the Overbearer CA:"
echo "  curl http://${MGMT_HOSTNAME}/api/ca > overbearer-ca.pem"
echo ""
echo -e "${RED}${BOLD}IMPORTANT:${NC} ${OUTDIR}/02-secrets.yaml contains your encryption keys."
echo "  Back it up securely and do not commit it to version control."
echo ""
echo -e "${DIM}Master Key: ${MASTER_KEY}${NC}"
echo -e "${DIM}JWT Secret: ${JWT_SECRET}${NC}"
