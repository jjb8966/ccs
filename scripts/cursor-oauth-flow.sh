#!/usr/bin/env bash
# Cursor OAuth via CLIProxy management API (works without -cursor-login CLI spawn).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/cursor-common.sh
source "${ROOT}/scripts/cursor-common.sh"

ENV_FILE="${ROOT}/.env"
CONFIG="${ROOT}/deploy/state/.ccs/config.yaml"
AUTH_DIR="${ROOT}/deploy/state/.ccs/cliproxy/auth"
OPEN_BROWSER="${CCS_OPEN_BROWSER:-auto}"
TIMEOUT_SEC="${CCS_AUTH_TIMEOUT_SEC:-300}"
POLL_SEC="${CCS_AUTH_POLL_SEC:-3}"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a
fi

PORT="${CCS_CLIPROXY_PORT:-8320}"
BASE="http://127.0.0.1:${PORT}"

cursor_require_container
cursor_require_cliproxy

if [[ ! -f "${CONFIG}" ]]; then
  echo "[X] Missing ${CONFIG}. Run: ${ROOT}/render-config.sh" >&2
  exit 1
fi

export CCS_CONFIG_PATH="${CONFIG}"
MGMT_SECRET="$(read_mgmt_secret_from_config "${CONFIG}")"
mkdir -p "${AUTH_DIR}"
BEFORE="$(find "${AUTH_DIR}" -maxdepth 1 -name 'cursor*.json' 2>/dev/null | sort || true)"

echo "[i] Requesting Cursor login URL from CLIProxy..."
START_JSON="$(
  curl -fsS \
    -H "Authorization: Bearer ${MGMT_SECRET}" \
    -H "Accept: application/json" \
    "${BASE}/v0/management/cursor-auth-url?is_webui=true"
)"

AUTH_URL="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("url") or d.get("auth_url") or "")' <<<"${START_JSON}")"
STATE="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("state") or "")' <<<"${START_JSON}")"

if [[ -z "${AUTH_URL}" && -z "${STATE}" ]]; then
  echo "[X] No auth URL or state from CLIProxy. Response:" >&2
  echo "${START_JSON}" >&2
  exit 1
fi

maybe_open_browser() {
  local url="$1"
  [[ -n "${url}" ]] || return 0
  if [[ "${OPEN_BROWSER}" == "0" || "${OPEN_BROWSER}" == "false" ]]; then
    return 0
  fi
  if [[ "${OPEN_BROWSER}" == "auto" && ( -n "${SSH_CONNECTION:-}" || -n "${CCS_AUTH_HEADLESS:-}" ) ]]; then
    return 0
  fi
  if command -v open >/dev/null 2>&1; then
    echo "[i] Opening browser..."
    open "${url}" || true
  elif command -v xdg-open >/dev/null 2>&1; then
    echo "[i] Opening browser..."
    xdg-open "${url}" || true
  fi
}

echo ""
echo "=============================================="
if [[ -n "${SSH_CONNECTION:-}" || -n "${CCS_AUTH_HEADLESS:-}" ]]; then
  echo " Open this URL in a browser on YOUR machine:"
else
  echo " Complete Cursor login in your browser:"
fi
echo ""
if [[ -n "${AUTH_URL}" ]]; then
  echo "  ${AUTH_URL}"
  maybe_open_browser "${AUTH_URL}"
else
  echo "  (waiting for URL — polling management API...)"
fi
echo ""
echo " Waiting for auth to complete (timeout: ${TIMEOUT_SEC}s)"
echo "=============================================="
echo ""

DEADLINE=$((SECONDS + TIMEOUT_SEC))
while (( SECONDS < DEADLINE )); do
  if [[ -z "${AUTH_URL}" && -n "${STATE}" ]]; then
    POLL_JSON="$(
      curl -fsS \
        -H "Authorization: Bearer ${MGMT_SECRET}" \
        -H "Accept: application/json" \
        "${BASE}/v0/management/get-auth-status?state=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "${STATE}")" \
        2>/dev/null || echo '{}'
    )"
    NEW_URL="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("url") or d.get("auth_url") or "")' <<<"${POLL_JSON}")"
    if [[ -n "${NEW_URL}" ]]; then
      AUTH_URL="${NEW_URL}"
      echo "[i] Login URL: ${AUTH_URL}"
      maybe_open_browser "${AUTH_URL}"
    fi
  fi

  AFTER="$(find "${AUTH_DIR}" -maxdepth 1 -name 'cursor*.json' 2>/dev/null | sort || true)"
  if [[ "${BEFORE}" != "${AFTER}" ]]; then
    echo "[OK] New Cursor auth token file detected."
    break
  fi

  if [[ -n "${STATE}" ]]; then
    STATUS_JSON="$(
      curl -fsS \
        -H "Authorization: Bearer ${MGMT_SECRET}" \
        -H "Accept: application/json" \
        "${BASE}/v0/management/get-auth-status?state=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "${STATE}")" \
        2>/dev/null || echo '{}'
    )"
    ST="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status") or "")' <<<"${STATUS_JSON}")"
    if [[ "${ST}" == "error" ]]; then
      echo "[X] Auth failed: ${STATUS_JSON}" >&2
      exit 1
    fi
    if [[ "${ST}" == "ok" ]]; then
      sleep 5
      AFTER="$(find "${AUTH_DIR}" -maxdepth 1 -name 'cursor*.json' 2>/dev/null | sort || true)"
      if [[ "${BEFORE}" != "${AFTER}" ]]; then
        echo "[OK] Cursor auth completed (status=ok)."
        break
      fi
    fi
  fi

  sleep "${POLL_SEC}"
done

AFTER="$(find "${AUTH_DIR}" -maxdepth 1 -name 'cursor*.json' 2>/dev/null | sort || true)"
if [[ "${BEFORE}" == "${AFTER}" ]]; then
  echo "[X] Timed out waiting for Cursor auth." >&2
  echo "    Retry: ${ROOT}/cursor-auth.sh" >&2
  exit 1
fi

echo "[i] Restarting cliproxy..."
cursor_restart_cliproxy

echo "[OK] Cursor OAuth finished."
