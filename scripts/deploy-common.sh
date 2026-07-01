#!/usr/bin/env bash
# Shared helpers for run-dev.sh and deploy scripts.
set -euo pipefail

deploy_strip_env_quotes() {
  local v="${1:-}"
  v="${v#\'}"
  v="${v%\'}"
  v="${v#\"}"
  v="${v%\"}"
  printf '%s' "${v}"
}

deploy_load_ccs_env() {
  local root="${1:?root required}"
  local env_file="${root}/.env"
  if [[ ! -f "${env_file}" ]]; then
    echo "[X] Missing ${env_file}. Copy .env.example to .env and set CCS_PROXY_TOKEN." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a
  source "${env_file}"
  set +a
  if [[ -z "${CCS_PROXY_TOKEN:-}" ]]; then
    echo "[X] CCS_PROXY_TOKEN is empty in .env" >&2
    exit 1
  fi
  CCS_PROXY_TOKEN="$(deploy_strip_env_quotes "${CCS_PROXY_TOKEN}")"
  export CCS_PROXY_TOKEN
}

deploy_ccs_compose_network() {
  local container="${1:-ccs}"
  docker inspect "${container}" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null \
    | tr ' ' '\n' \
    | grep -E '^deploy_' \
    | head -1
}
