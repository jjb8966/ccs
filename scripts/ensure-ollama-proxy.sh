#!/usr/bin/env bash
# Start ollama-proxy via docker compose (never ad-hoc docker run).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/deploy-common.sh
source "${ROOT}/scripts/deploy-common.sh"

deploy_load_ccs_env "${ROOT}"

OLLAMA_DIR="${OLLAMA_PROXY_DIR:-${ROOT}/../ollama-proxy}"
CONTAINER="${CCS_CONTAINER_NAME:-ccs}"
OLLAMA_PORT="${OLLAMA_PROXY_PORT:-5002}"
ENABLED="${OLLAMA_PROXY_ENABLED:-1}"

if [[ "${ENABLED}" == "0" ]]; then
  echo "[i] OLLAMA_PROXY_ENABLED=0 — skip ollama-proxy"
  exit 0
fi

if [[ ! -f "${OLLAMA_DIR}/docker-compose.yml" ]]; then
  echo "[i] No ollama-proxy compose at ${OLLAMA_DIR} — skip"
  exit 0
fi

bash "${ROOT}/scripts/render-ollama-proxy-env.sh"

# Remove containers started outside compose (quoted env / wrong network).
for name in ollama-proxy antigravity-proxy; do
  if ! docker ps -a --format '{{.Names}}' | grep -qx "${name}"; then
    continue
  fi
  project="$(docker inspect "${name}" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  if [[ -z "${project}" ]]; then
    echo "[!] Removing ad-hoc ${name} container (use docker compose only)"
    docker rm -f "${name}" >/dev/null 2>&1 || true
  fi
done

echo "==> Starting ollama-proxy (compose, no-deps)..."
(
  cd "${OLLAMA_DIR}"
  if [[ "${OLLAMA_PROXY_REBUILD:-0}" == "1" ]]; then
    docker compose build ollama-proxy
  fi
  # antigravity-proxy may already run from a sibling compose project.
  docker compose up -d --no-deps --force-recreate ollama-proxy
)

CCS_NETWORK="$(deploy_ccs_compose_network "${CONTAINER}")"
if [[ -n "${CCS_NETWORK}" ]]; then
  echo "==> Connecting ollama-proxy to ${CCS_NETWORK} (ccs hostname)..."
  docker network connect "${CCS_NETWORK}" ollama-proxy 2>/dev/null \
    || echo "[i] ollama-proxy already on ${CCS_NETWORK}"
else
  echo "[!] Could not detect CCS compose network — ollama-proxy may not reach ccs:20129"
fi

echo "==> Waiting for ollama-proxy :${OLLAMA_PORT}..."
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${OLLAMA_PORT}/v1/models" \
    -H "Authorization: Bearer ${CCS_PROXY_TOKEN}" 2>/dev/null; then
    break
  fi
  sleep 1
done

if curl -fsS -o /dev/null "http://127.0.0.1:${OLLAMA_PORT}/v1/models" \
  -H "Authorization: Bearer ${CCS_PROXY_TOKEN}"; then
  echo "[OK] ollama-proxy ingress auth OK (:${OLLAMA_PORT})"
else
  echo "[X] ollama-proxy not reachable or PROXY_API_TOKEN mismatch" >&2
  echo "    Check: docker logs ollama-proxy" >&2
  exit 1
fi

# Upstream CCS cursor daemon via ollama-proxy internal routing.
if curl -fsS -o /dev/null -X POST "http://127.0.0.1:${OLLAMA_PORT}/v1/messages" \
  -H "Authorization: Bearer ${CCS_PROXY_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"ccs:composer-2.5","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}' \
  --max-time 120; then
  echo "[OK] ollama-proxy -> CCS cursor path OK"
else
  echo "[!] ollama-proxy up but CCS upstream failed — check cursor daemon on :${CCS_CURSOR_DAEMON_PORT:-20129}"
fi
