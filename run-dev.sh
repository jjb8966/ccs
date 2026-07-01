#!/usr/bin/env bash
# CCS: docker + nginx-network
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

if [[ ! -f "${ROOT}/.env" ]]; then
  echo "[X] Create ${ROOT}/.env from .env.example and set CCS_PROXY_TOKEN." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "${ROOT}/.env"
set +a

COMPOSE=(docker compose -f "${ROOT}/deploy/docker-compose.yml")
CONTAINER="${CCS_CONTAINER_NAME:-ccs}"

echo "==> Rendering CCS config (Plus backend + Cursor model)..."
bash "${ROOT}/render-config.sh"

echo "==> Ensuring CLIProxy Plus binary on host volume..."
bash "${ROOT}/scripts/ensure-plus-binary.sh"

echo "==> Removing legacy containers (ccs-dev, ccs-dashboard) if present..."
docker rm -f ccs-dev ccs-dashboard 2>/dev/null || true

echo "==> Ensuring ccs embedded cliproxy (Plus backend for Cursor)..."
bash "${ROOT}/scripts/ensure-plus-binary.sh" || true

echo "==> Starting ${CONTAINER}..."
"${COMPOSE[@]}" up -d --force-recreate

echo "==> Waiting for ccs cliproxy..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${CCS_CLIPROXY_PORT:-8320}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${CCS_CLIPROXY_PORT:-8320}/" >/dev/null 2>&1; then
  echo "[!] cliproxy not ready — restarting ${CONTAINER}..."
  docker restart "${CONTAINER}" >/dev/null
  sleep 8
fi

echo "==> Installing CLIProxy Plus config in ccs..."
"${COMPOSE[@]}" exec -T "${CONTAINER}" ccs cliproxy --backend plus 2>/dev/null || true

echo "==> Starting native Cursor daemon (composer-2.5 path)..."
"${COMPOSE[@]}" exec -T "${CONTAINER}" ccs legacy cursor enable 2>/dev/null || true
"${COMPOSE[@]}" exec -T "${CONTAINER}" ccs legacy cursor auth --import-cliproxy 2>/dev/null || true
"${COMPOSE[@]}" exec -T "${CONTAINER}" ccs legacy cursor start 2>/dev/null || true

echo "==> Connecting ${CONTAINER} to nginx-network..."
docker network connect nginx-network "${CONTAINER}" 2>/dev/null \
  || echo "[!] Already on nginx-network or network missing (create: docker network create nginx-network)"

echo "==> Reloading nginx..."
docker exec nginx nginx -s reload 2>/dev/null \
  || echo "[!] nginx container not running — add deploy/nginx/ccs-proxy.conf and reload manually"

PUBLIC_BASE="https://${CCS_PUBLIC_HOST:-jjb8966.duckdns.org}${CCS_PUBLIC_PATH:-/ccs}/api/provider/cursor"

echo ""
echo "=============================================="
echo "[OK] CCS stack is up (container: ${CONTAINER})"
echo "  Dashboard:  http://127.0.0.1:${CCS_DASHBOARD_PORT:-3000}"
echo "  CLIProxy:   http://127.0.0.1:${CCS_CLIPROXY_PORT:-8320}"
echo "  Cursor:     http://127.0.0.1:${CCS_CURSOR_DAEMON_PORT:-20129}"
echo "  Public URL: ${PUBLIC_BASE}"
echo "  Bearer:     CCS_PROXY_TOKEN from .env"
echo ""
echo "Next (first time): ${ROOT}/cursor-auth.sh"
echo "Claude Code: edit ~/agent/claude-code/settings.env.json yourself"
echo "=============================================="

# Optional health probe
if curl -fsS "http://127.0.0.1:${CCS_CLIPROXY_PORT:-8320}/" >/dev/null; then
  echo "[OK] CLIProxy health check passed"
else
  echo "[!] CLIProxy not reachable on :${CCS_CLIPROXY_PORT:-8320} — check: docker logs ${CONTAINER}"
fi
