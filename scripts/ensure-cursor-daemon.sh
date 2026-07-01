#!/usr/bin/env bash
# Start and verify the native CCS Cursor daemon inside the ccs container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/deploy-common.sh
source "${ROOT}/scripts/deploy-common.sh"

deploy_load_ccs_env "${ROOT}"

CONTAINER="${CCS_CONTAINER_NAME:-ccs}"
CURSOR_PORT="${CCS_CURSOR_DAEMON_PORT:-20129}"
COMPOSE=(docker compose -f "${ROOT}/deploy/docker-compose.yml")

cursor_exec() {
  docker exec -e CCS_CLAUDE_PATH=/bin/true "${CONTAINER}" ccs "$@"
}

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  echo "[X] ${CONTAINER} is not running" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  echo "==> Building dist/cursor overlay..."
  (cd "${ROOT}" && bun run build)
else
  echo "[!] bun not found — using existing dist/cursor overlay"
fi

echo "==> Enabling native Cursor daemon..."
cursor_exec legacy cursor enable

echo "==> Importing Cursor auth from cliproxy..."
if ! cursor_exec legacy cursor auth --import-cliproxy; then
  echo "[!] Cursor auth import failed — run ${ROOT}/cursor-auth.sh if needed"
fi

echo "==> Starting native Cursor daemon..."
if ! cursor_exec legacy cursor start; then
  echo "[!] cursor start failed — retrying once after cliproxy restart..."
  docker exec "${CONTAINER}" supervisorctl -c /etc/supervisord.conf restart cliproxy 2>/dev/null || true
  sleep 3
  cursor_exec legacy cursor start
fi

echo "==> Waiting for Cursor daemon on :${CURSOR_PORT}..."
for _ in $(seq 1 45); do
  if curl -fsS -o /dev/null \
    -H "Authorization: Bearer ${CCS_PROXY_TOKEN}" \
    "http://127.0.0.1:${CURSOR_PORT}/v1/models" 2>/dev/null; then
    echo "[OK] Cursor daemon ready on :${CURSOR_PORT}"
    exit 0
  fi
  sleep 1
done

echo "[X] Cursor daemon did not become ready on :${CURSOR_PORT}" >&2
echo "    Check: docker logs ${CONTAINER}" >&2
"${COMPOSE[@]}" exec -T "${CONTAINER}" ccs legacy cursor status 2>/dev/null || true
exit 1
