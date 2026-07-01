#!/usr/bin/env bash
# Shared helpers for Cursor account scripts (ccs container).
set -euo pipefail

cursor_init() {
  if [[ -z "${ROOT:-}" ]]; then
    ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  fi
  CONTAINER="${CCS_CONTAINER_NAME:-ccs}"
  COMPOSE=(docker compose -f "${ROOT}/deploy/docker-compose.yml")
  export ROOT CONTAINER
}

cursor_require_container() {
  cursor_init
  if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    echo "[X] ${CONTAINER} is not running. Start with: ${ROOT}/run-dev.sh" >&2
    exit 1
  fi
}

cursor_exec() {
  docker exec -e CCS_CLAUDE_PATH=/bin/true "${CONTAINER}" ccs "$@"
}

cursor_exec_it() {
  docker exec -it -e CCS_CLAUDE_PATH=/bin/true "${CONTAINER}" ccs "$@"
}

cursor_restart_cliproxy() {
  if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    return 0
  fi
  # Auth tokens are picked up by cliproxy's auth-dir watcher; restart is best-effort.
  if docker exec "${CONTAINER}" supervisorctl -c /etc/supervisord.conf restart cliproxy 2>/dev/null; then
    return 0
  fi
  sleep 2
  if docker exec "${CONTAINER}" supervisorctl -c /etc/supervisord.conf start cliproxy 2>/dev/null; then
    return 0
  fi
  echo "[!] cliproxy restart skipped (still running or will reload auth on next request)" >&2
}

cursor_require_cliproxy() {
  cursor_init
  local port="${CCS_CLIPROXY_PORT:-8320}"
  local url="http://127.0.0.1:${port}/"
  if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
    return 0
  fi
  echo "[X] CCS cliproxy is not reachable on ${url}" >&2
  echo "    Start or restart the ccs container: ${ROOT}/run-dev.sh" >&2
  echo "    (ccs bundles cliproxy internally; auth uses its management API on :${port})" >&2
  exit 1
}

# Headless auth: explicit flag, SSH session, or non-TTY. macOS has no DISPLAY by default.
cursor_use_headless_auth() {
  [[ -n "${CCS_AUTH_HEADLESS:-}" || -n "${SSH_CONNECTION:-}" || ! -t 1 ]]
}

read_mgmt_secret_from_config() {
  local config_path="$1"
  python3 << 'PY'
import os
import re
from pathlib import Path

config_path = Path(os.environ["CCS_CONFIG_PATH"])
text = config_path.read_text(encoding="utf-8")
match = re.search(r"^\s*management_secret:\s*(\S+)\s*$", text, re.MULTILINE)
if not match:
    raise SystemExit("management_secret missing in config.yaml")
print(match.group(1).strip("'\""))
PY
}
