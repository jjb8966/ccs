#!/usr/bin/env bash
# Sync CCS auth tokens into ollama-proxy/.env (unquoted, compose-safe).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/deploy-common.sh
source "${ROOT}/scripts/deploy-common.sh"

deploy_load_ccs_env "${ROOT}"

OLLAMA_DIR="${OLLAMA_PROXY_DIR:-${ROOT}/../ollama-proxy}"
OLLAMA_ENV="${OLLAMA_DIR}/.env"
CCS_HOST="${CCS_CONTAINER_NAME:-ccs}"
CURSOR_PORT="${CCS_CURSOR_DAEMON_PORT:-20129}"

if [[ ! -d "${OLLAMA_DIR}" ]]; then
  echo "[i] ollama-proxy not found at ${OLLAMA_DIR} — skip env sync"
  exit 0
fi

python3 - "${OLLAMA_ENV}" "${CCS_PROXY_TOKEN}" "${CCS_HOST}" "${CURSOR_PORT}" << 'PY'
import re
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
token = sys.argv[2]
ccs_host = sys.argv[3]
cursor_port = sys.argv[4]

keys = {
    "PROXY_API_TOKEN": token,
    "CCS_API_KEYS": token,
    "CCS_API_BASE_URL": f"http://{ccs_host}:{cursor_port}/v1",
}

lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []

def set_key(existing: list[str], key: str, value: str) -> list[str]:
    pattern = re.compile(rf"^{re.escape(key)}=")
    out: list[str] = []
    found = False
    for line in existing:
        if pattern.match(line):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    return out

for key, value in keys.items():
    lines = set_key(lines, key, value)

env_path.parent.mkdir(parents=True, exist_ok=True)
env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

echo "[OK] Synced ollama-proxy auth (${OLLAMA_ENV})"
