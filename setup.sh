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
    read -rp "$(echo -e "${BOLD}$prompt${NC} ${DIM}[$default]${NC}: ")" input < /dev/tty
    eval "$var=\"${input:-$default}\""
  else
    read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" input < /dev/tty
    eval "$var=\"$input\""
  fi
}

ask_yn() {
  local prompt="$1" default="$2" var="$3"
  read -rp "$(echo -e "${BOLD}$prompt${NC} ${DIM}[$default]${NC}: ")" input < /dev/tty
  input="${input:-$default}"
  case "$input" in
    [yY]*) eval "$var=yes" ;;
    *) eval "$var=no" ;;
  esac
}

generate_hex() {
  openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | xxd -p | tr -d '\n' | head -c "$(($1*2))"
}

show_public_proxy_warning() {
  echo ""
  echo -e "${RED}${BOLD}"
  echo "  ┌──────────────────────────────────────────────────────────────────────┐"
  echo "  │  WARNING: You are exposing the Overbearer proxy to the internet.    │"
  echo "  │                                                                      │"
  echo "  │  Overbearer is designed for PRIVATE infrastructure. An internet-     │"
  echo "  │  facing proxy allows anyone to route traffic through it.             │"
  echo "  │                                                                      │"
  echo "  │  If you proceed, you MUST:                                           │"
  echo "  │    - Configure proxy source ACLs to restrict which services can      │"
  echo "  │      connect (Settings > Proxy ACLs in the management UI)            │"
  echo "  │    - Use firewall rules to limit access to known IP ranges           │"
  echo "  │    - Monitor the 'New Activity' tab for unexpected clients           │"
  echo "  │                                                                      │"
  echo "  │  Consider using an internal/VPC load balancer instead.               │"
  echo "  └──────────────────────────────────────────────────────────────────────┘"
  echo -e "${NC}"
  ask_yn "Do you still want to expose the proxy to the internet?" "n" CONFIRM_PUBLIC
  if [ "$CONFIRM_PUBLIC" = "no" ]; then
    echo -e "${GREEN}Good call. Switching proxy to internal load balancer.${NC}"
    PROXY_LB_SCOPE="internal"
  fi
}

# ---------------------------------------------------------------------------
# Collect configuration: General
# ---------------------------------------------------------------------------

echo -e "${YELLOW}General${NC}"
ask "Kubernetes namespace" "overbearer" NAMESPACE
ask "Container image registry" "ghcr.io/rderaison/overbearer" REGISTRY
ask "Image tag" "latest" IMAGE_TAG

IMAGE_PULL_SECRET=""
REGISTRY_HOST="${REGISTRY%%/*}"
if [ "$REGISTRY_HOST" != "ghcr.io" ] && [ "$REGISTRY_HOST" != "docker.io" ]; then
  echo ""
  echo -e "  ${DIM}Private registry detected (${REGISTRY_HOST}).${NC}"
  echo -e "  ${DIM}If your cluster needs credentials to pull images, provide the name${NC}"
  echo -e "  ${DIM}of an existing Kubernetes docker-registry secret, or leave empty to skip.${NC}"
  echo -e "  ${DIM}To create one: kubectl -n ${NAMESPACE} create secret docker-registry <name> \\${NC}"
  echo -e "  ${DIM}  --docker-server=${REGISTRY_HOST} --docker-username=<user> --docker-password=<pass>${NC}"
  ask "Image pull secret name (leave empty to skip)" "" IMAGE_PULL_SECRET
fi

# ---------------------------------------------------------------------------
# Kubernetes platform selection
# ---------------------------------------------------------------------------

echo ""
echo -e "${YELLOW}Kubernetes Platform${NC}"
echo ""
echo -e "  ${BOLD}1)${NC}  GKE       ${DIM}(Google Kubernetes Engine)${NC}"
echo -e "  ${BOLD}2)${NC}  EKS       ${DIM}(Amazon Elastic Kubernetes Service)${NC}"
echo -e "  ${BOLD}3)${NC}  AKS       ${DIM}(Azure Kubernetes Service)${NC}"
echo -e "  ${BOLD}4)${NC}  DOKS      ${DIM}(DigitalOcean Kubernetes)${NC}"
echo -e "  ${BOLD}5)${NC}  LKE       ${DIM}(Linode / Akamai)${NC}"
echo -e "  ${BOLD}6)${NC}  Hetzner   ${DIM}(Hetzner Cloud)${NC}"
echo -e "  ${BOLD}7)${NC}  Scaleway  ${DIM}(Scaleway Kapsule)${NC}"
echo -e "  ${BOLD}8)${NC}  OVH       ${DIM}(OVH Managed Kubernetes)${NC}"
echo -e "  ${BOLD}9)${NC}  Vultr     ${DIM}(Vultr Kubernetes Engine)${NC}"
echo -e "  ${BOLD}10)${NC} Bare Metal ${DIM}(MetalLB / on-prem)${NC}"
echo -e "  ${BOLD}11)${NC} k3s / k0s ${DIM}(lightweight distributions)${NC}"
echo -e "  ${BOLD}12)${NC} Other     ${DIM}(custom / self-managed)${NC}"
echo ""
ask "Select your platform" "10" K8S_PLATFORM

# Map platform to defaults
DEFAULT_STORAGE_CLASS=""
SUPPORTS_INTERNAL_LB="yes"
LB_NEEDS_USER_IP="no"

case "$K8S_PLATFORM" in
  1)  # GKE
    K8S_FLAVOR="gke"
    DEFAULT_STORAGE_CLASS="standard-rw"
    ;;
  2)  # EKS
    K8S_FLAVOR="eks"
    DEFAULT_STORAGE_CLASS="gp3"
    ;;
  3)  # AKS
    K8S_FLAVOR="aks"
    DEFAULT_STORAGE_CLASS="managed-csi"
    ;;
  4)  # DOKS
    K8S_FLAVOR="doks"
    DEFAULT_STORAGE_CLASS="do-block-storage"
    SUPPORTS_INTERNAL_LB="no"
    ;;
  5)  # LKE
    K8S_FLAVOR="lke"
    DEFAULT_STORAGE_CLASS="linode-block-storage-retain"
    SUPPORTS_INTERNAL_LB="no"
    ;;
  6)  # Hetzner
    K8S_FLAVOR="hetzner"
    DEFAULT_STORAGE_CLASS="hcloud-volumes"
    ;;
  7)  # Scaleway
    K8S_FLAVOR="scaleway"
    DEFAULT_STORAGE_CLASS="scw-bssd"
    ;;
  8)  # OVH
    K8S_FLAVOR="ovh"
    DEFAULT_STORAGE_CLASS="csi-cinder-high-speed"
    SUPPORTS_INTERNAL_LB="no"
    ;;
  9)  # Vultr
    K8S_FLAVOR="vultr"
    DEFAULT_STORAGE_CLASS="vultr-block-storage-hdd"
    ;;
  10) # Bare Metal
    K8S_FLAVOR="baremetal"
    LB_NEEDS_USER_IP="yes"
    ;;
  11) # k3s / k0s
    K8S_FLAVOR="k3s"
    DEFAULT_STORAGE_CLASS="local-path"
    LB_NEEDS_USER_IP="yes"
    ;;
  12|*) # Other
    K8S_FLAVOR="other"
    ;;
esac

# ---------------------------------------------------------------------------
# Hostnames
# ---------------------------------------------------------------------------

echo ""
echo -e "${YELLOW}Hostnames${NC}"
ask "Management UI hostname (for TLS & passkeys)" "" MGMT_HOSTNAME
ask "Proxy hostname" "" PROXY_HOSTNAME

# --- Optional custom TLS certificate for management UI ---
echo ""
echo -e "  ${DIM}The management UI serves HTTPS on port 443. By default it will${NC}"
echo -e "  ${DIM}auto-generate a certificate from its internal CA on first start.${NC}"
echo -e "  ${DIM}If you have a .pem file (certificate + private key) you'd like to${NC}"
echo -e "  ${DIM}use instead (e.g. from Let's Encrypt or your corporate CA), provide${NC}"
echo -e "  ${DIM}its path below. Otherwise leave empty.${NC}"
ask "Path to management TLS .pem file (leave empty to auto-generate)" "" MGMT_TLS_PEM_PATH
MGMT_TLS_PEM_CONTENT=""
if [ -n "$MGMT_TLS_PEM_PATH" ]; then
  if [ ! -f "$MGMT_TLS_PEM_PATH" ]; then
    echo -e "  ${RED}File not found: ${MGMT_TLS_PEM_PATH}${NC}"
    echo -e "  ${DIM}Falling back to auto-generated certificate.${NC}"
    MGMT_TLS_PEM_PATH=""
  else
    MGMT_TLS_PEM_CONTENT=$(cat "$MGMT_TLS_PEM_PATH")
    # Quick sanity check
    if ! echo "$MGMT_TLS_PEM_CONTENT" | grep -q "BEGIN CERTIFICATE"; then
      echo -e "  ${RED}Warning: file does not appear to contain a PEM certificate.${NC}"
      ask_yn "Use it anyway?" "n" USE_BAD_PEM
      if [ "$USE_BAD_PEM" = "no" ]; then
        MGMT_TLS_PEM_PATH=""
        MGMT_TLS_PEM_CONTENT=""
        echo -e "  ${DIM}Falling back to auto-generated certificate.${NC}"
      fi
    else
      echo -e "  ${GREEN}Certificate loaded.${NC}"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Networking: LoadBalancers
# ---------------------------------------------------------------------------

echo ""
echo -e "${YELLOW}Networking${NC}"
ask_yn "Use LoadBalancer services?" "y" USE_LB

MGMT_LB_SCOPE="internal"
PROXY_LB_SCOPE="internal"
MGMT_LB_IP=""
PROXY_LB_IP=""
PROXY_IS_PUBLIC="no"

if [ "$USE_LB" = "yes" ]; then
  # --- Management LB scope ---
  if [ "$SUPPORTS_INTERNAL_LB" = "yes" ]; then
    echo ""
    echo -e "  ${DIM}Management UI load balancer:${NC}"
    echo -e "    ${BOLD}1)${NC} Internal ${DIM}(VPC / private network -- recommended)${NC}"
    echo -e "    ${BOLD}2)${NC} External ${DIM}(internet-facing)${NC}"
    ask "Management LB scope" "1" MGMT_LB_SCOPE_CHOICE
    case "$MGMT_LB_SCOPE_CHOICE" in
      2) MGMT_LB_SCOPE="external" ;;
      *) MGMT_LB_SCOPE="internal" ;;
    esac
  else
    echo -e "  ${DIM}Note: ${K8S_FLAVOR} does not support native internal load balancers.${NC}"
    echo -e "  ${DIM}Use firewall rules to restrict access to the management UI.${NC}"
    MGMT_LB_SCOPE="external"
  fi

  # --- Proxy LB scope ---
  if [ "$SUPPORTS_INTERNAL_LB" = "yes" ]; then
    echo ""
    echo -e "  ${DIM}Proxy load balancer:${NC}"
    echo -e "    ${BOLD}1)${NC} Internal ${DIM}(VPC / private network -- strongly recommended)${NC}"
    echo -e "    ${BOLD}2)${NC} External ${DIM}(internet-facing -- dangerous for a proxy)${NC}"
    ask "Proxy LB scope" "1" PROXY_LB_SCOPE_CHOICE
    case "$PROXY_LB_SCOPE_CHOICE" in
      2)
        PROXY_LB_SCOPE="external"
        PROXY_IS_PUBLIC="yes"
        show_public_proxy_warning
        # Re-check after warning (user may have switched back)
        [ "$PROXY_LB_SCOPE" = "internal" ] && PROXY_IS_PUBLIC="no"
        ;;
      *) PROXY_LB_SCOPE="internal" ;;
    esac
  else
    echo -e "  ${DIM}Note: ${K8S_FLAVOR} does not support native internal load balancers.${NC}"
    PROXY_LB_SCOPE="external"
    PROXY_IS_PUBLIC="yes"
    show_public_proxy_warning
    [ "$PROXY_LB_SCOPE" = "internal" ] && PROXY_IS_PUBLIC="no"
  fi

  # --- Static IPs for bare metal / k3s ---
  if [ "$LB_NEEDS_USER_IP" = "yes" ]; then
    echo ""
    echo -e "  ${DIM}Your platform requires you to specify load balancer IP addresses.${NC}"
    ask "Management LoadBalancer IP" "" MGMT_LB_IP
    ask "Proxy LoadBalancer IP" "" PROXY_LB_IP
  fi
fi

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

echo ""
echo -e "${YELLOW}Storage${NC}"
if [ -n "$DEFAULT_STORAGE_CLASS" ]; then
  ask "Storage class" "$DEFAULT_STORAGE_CLASS" STORAGE_CLASS
else
  ask "Storage class (leave empty for emptyDir / testing)" "" STORAGE_CLASS
fi
POSTGRES_SIZE="5Gi"
CLICKHOUSE_SIZE="20Gi"
if [ -n "$STORAGE_CLASS" ]; then
  ask "PostgreSQL volume size" "5Gi" POSTGRES_SIZE
  ask "ClickHouse volume size" "20Gi" CLICKHOUSE_SIZE
fi

# ---------------------------------------------------------------------------
# Kafka
# ---------------------------------------------------------------------------

echo ""
echo -e "${YELLOW}Kafka${NC}"
ask_yn "Use Kafka for log shipping? (recommended for production)" "y" USE_KAFKA
KAFKA_BROKERS=""
KAFKA_TOPIC="overbearer.proxy-logs"
if [ "$USE_KAFKA" = "yes" ]; then
  ask "Kafka broker(s) (comma-separated)" "" KAFKA_BROKERS
  ask "Kafka topic" "$KAFKA_TOPIC" KAFKA_TOPIC
fi

# ---------------------------------------------------------------------------
# Scaling
# ---------------------------------------------------------------------------

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
# Build annotations based on platform and scope
# ---------------------------------------------------------------------------

# Returns the YAML annotations block for a LoadBalancer service.
# Usage: build_lb_annotations <scope> <static_ip>
#   scope: "internal" or "external"
#   static_ip: IP address or "" for auto-assignment
build_lb_annotations() {
  local scope="$1"
  local static_ip="$2"
  local annotations=""
  local lb_ip_field=""

  case "$K8S_FLAVOR" in
    gke)
      if [ "$scope" = "internal" ]; then
        annotations="    networking.gke.io/load-balancer-type: \"Internal\""
      fi
      [ -n "$static_ip" ] && lb_ip_field="  loadBalancerIP: ${static_ip}"
      ;;
    eks)
      if [ "$scope" = "internal" ]; then
        annotations="    service.beta.kubernetes.io/aws-load-balancer-scheme: internal
    service.beta.kubernetes.io/aws-load-balancer-type: nlb"
      else
        annotations="    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
    service.beta.kubernetes.io/aws-load-balancer-type: nlb"
      fi
      ;;
    aks)
      if [ "$scope" = "internal" ]; then
        annotations="    service.beta.kubernetes.io/azure-load-balancer-internal: \"true\""
      fi
      [ -n "$static_ip" ] && lb_ip_field="  loadBalancerIP: ${static_ip}"
      ;;
    doks)
      # DigitalOcean does not support internal LBs natively
      annotations="    service.beta.kubernetes.io/do-loadbalancer-size-unit: \"1\"
    service.beta.kubernetes.io/do-loadbalancer-disable-lets-encrypt-dns-records: \"true\""
      ;;
    lke)
      annotations="    service.beta.kubernetes.io/linode-loadbalancer-throttle: \"20\""
      ;;
    hetzner)
      if [ "$scope" = "internal" ]; then
        annotations="    load-balancer.hetzner.cloud/use-private-ip: \"true\""
      fi
      if [ -n "$static_ip" ]; then
        annotations="${annotations:+${annotations}
}    load-balancer.hetzner.cloud/ipv4: \"${static_ip}\""
      fi
      ;;
    scaleway)
      if [ "$scope" = "internal" ]; then
        annotations="    service.beta.kubernetes.io/scw-loadbalancer-type: inner"
      fi
      ;;
    ovh)
      # OVH has limited internal LB support
      [ -n "$static_ip" ] && lb_ip_field="  loadBalancerIP: ${static_ip}"
      ;;
    vultr)
      if [ "$scope" = "internal" ]; then
        annotations="    service.beta.kubernetes.io/vultr-loadbalancer-private-network: \"true\""
      fi
      [ -n "$static_ip" ] && lb_ip_field="  loadBalancerIP: ${static_ip}"
      ;;
    baremetal)
      if [ -n "$static_ip" ]; then
        annotations="    metallb.universe.tf/loadBalancerIPs: \"${static_ip}\""
      fi
      ;;
    k3s)
      if [ -n "$static_ip" ]; then
        annotations="    metallb.universe.tf/loadBalancerIPs: \"${static_ip}\""
      fi
      ;;
    other)
      [ -n "$static_ip" ] && lb_ip_field="  loadBalancerIP: ${static_ip}"
      ;;
  esac

  # Output the metadata annotations block
  if [ -n "$annotations" ]; then
    echo "  annotations:"
    echo "$annotations"
  fi

  # Output loadBalancerIP as a separate marker (caller puts it in spec)
  if [ -n "$lb_ip_field" ]; then
    echo "LB_IP_SPEC:${lb_ip_field}"
  fi
}

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

MGMT_TLS_SECRET=""
if [ -n "$MGMT_TLS_PEM_PATH" ]; then
  MGMT_TLS_SECRET="---
apiVersion: v1
kind: Secret
metadata:
  name: management-tls
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  tls.pem: |
$(echo "$MGMT_TLS_PEM_CONTENT" | sed 's/^/    /')"
fi

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
${MGMT_TLS_SECRET}
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
          image: postgres:17-alpine
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
        token_type Enum8('fake' = 1, 'real_direct' = 2, 'unknown' = 3, 'acl_denied' = 4),
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
          image: clickhouse/clickhouse-server:26.2-alpine
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
      serviceAccountName: overbearer-proxy${IMAGE_PULL_SECRET:+
      imagePullSecrets:
        - name: ${IMAGE_PULL_SECRET}}
      containers:
        - name: proxy
          image: ${REGISTRY}/proxy:${IMAGE_TAG}
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 8443
              name: https
          env:
            - name: NODE_OPTIONS
              value: "--no-deprecation"
            - name: PORT
              value: "8080"
            - name: TLS_PORT
              value: "8443"
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
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

MGMT_TLS_VOLUME_MOUNT=""
MGMT_TLS_VOLUME=""
if [ -n "$MGMT_TLS_PEM_PATH" ]; then
  MGMT_TLS_VOLUME_MOUNT="          volumeMounts:
            - name: tls-cert
              mountPath: /etc/ssl/management
              readOnly: true"
  MGMT_TLS_VOLUME="      volumes:
        - name: tls-cert
          secret:
            secretName: management-tls
            items:
              - key: tls.pem
                path: tls.pem"
fi

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
    spec:${IMAGE_PULL_SECRET:+
      imagePullSecrets:
        - name: ${IMAGE_PULL_SECRET}}
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
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
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
${MGMT_TLS_VOLUME_MOUNT}
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
${MGMT_TLS_VOLUME}
EOF

# ---------------------------------------------------------------------------
# Network: Services (with platform-specific annotations)
# ---------------------------------------------------------------------------

MGMT_SVC_TYPE="ClusterIP"
MGMT_ANNOTATIONS=""
MGMT_LB_IP_SPEC=""
PROXY_SVC_TYPE="ClusterIP"
PROXY_ANNOTATIONS=""
PROXY_LB_IP_SPEC=""

if [ "$USE_LB" = "yes" ]; then
  MGMT_SVC_TYPE="LoadBalancer"
  PROXY_SVC_TYPE="LoadBalancer"

  # Build management LB annotations
  MGMT_RAW=$(build_lb_annotations "$MGMT_LB_SCOPE" "$MGMT_LB_IP")
  MGMT_ANNOTATIONS=$(echo "$MGMT_RAW" | grep -v "^LB_IP_SPEC:" || true)
  MGMT_LB_IP_LINE=$(echo "$MGMT_RAW" | grep "^LB_IP_SPEC:" | sed 's/^LB_IP_SPEC://' || true)

  # Build proxy LB annotations
  PROXY_RAW=$(build_lb_annotations "$PROXY_LB_SCOPE" "$PROXY_LB_IP")
  PROXY_ANNOTATIONS=$(echo "$PROXY_RAW" | grep -v "^LB_IP_SPEC:" || true)
  PROXY_LB_IP_LINE=$(echo "$PROXY_RAW" | grep "^LB_IP_SPEC:" | sed 's/^LB_IP_SPEC://' || true)
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
${MGMT_ANNOTATIONS}
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
${MGMT_LB_IP_LINE}
---
apiVersion: v1
kind: Service
metadata:
  name: overbearer-proxy
  namespace: ${NAMESPACE}
  labels:
    app: overbearer-proxy
    app.kubernetes.io/part-of: overbearer
${PROXY_ANNOTATIONS}
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
${PROXY_LB_IP_LINE}
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
    verbs: [get, list, watch]
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
echo -e "  ${DIM}Platform: ${K8S_FLAVOR}${NC}"
if [ -n "$IMAGE_PULL_SECRET" ]; then
  echo -e "  ${DIM}Image pull secret: ${IMAGE_PULL_SECRET}${NC}"
fi
if [ "$USE_LB" = "yes" ]; then
  echo -e "  ${DIM}Management LB: ${MGMT_LB_SCOPE}${NC}"
  echo -e "  ${DIM}Proxy LB: ${PROXY_LB_SCOPE}${NC}"
fi
echo ""
echo -e "  ${OUTDIR}/"
echo -e "  ├── 01-namespace.yaml"
if [ -n "$MGMT_TLS_PEM_PATH" ]; then
echo -e "  ├── 02-secrets.yaml       ${DIM}(contains encryption keys + TLS cert)${NC}"
else
echo -e "  ├── 02-secrets.yaml       ${DIM}(contains encryption keys)${NC}"
fi
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
if [ -n "$MGMT_TLS_PEM_PATH" ]; then
  echo -e "  ${DIM}Management TLS: custom certificate${NC}"
else
  echo -e "  ${DIM}Management TLS: auto-generated (from internal CA)${NC}"
fi
echo ""
echo -e "${BOLD}After deployment:${NC}"
echo ""
echo "  1. Open https://${MGMT_HOSTNAME}/ and create your admin account"
echo "  2. Create token mappings and configure your services"
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

if [ "$PROXY_IS_PUBLIC" = "yes" ]; then
  echo -e "${RED}${BOLD}IMPORTANT:${NC} The proxy is configured with a public IP."
  echo "  Configure proxy ACLs immediately after first login (Settings → Proxy ACLs)."
  echo "  Until ACLs are configured, any host on the internet can use the proxy."
  echo ""
fi

echo -e "${RED}${BOLD}IMPORTANT:${NC} ${OUTDIR}/02-secrets.yaml contains your encryption keys."
echo "  Back it up securely and do not commit it to version control."
echo ""
echo -e "${DIM}Master Key: ${MASTER_KEY}${NC}"
echo -e "${DIM}JWT Secret: ${JWT_SECRET}${NC}"
