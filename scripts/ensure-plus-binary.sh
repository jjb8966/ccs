#!/usr/bin/env bash
# Ensure CLIProxy Plus binary in the ccs volume supports Cursor OAuth.
# Run from run-dev.sh only — not during cursor auth.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUS_DIR="${ROOT}/deploy/state/.ccs/cliproxy/bin/plus"
BIN="${PLUS_DIR}/cli-proxy-api-plus"
VERSION_FILE="${PLUS_DIR}/.version"
CONTAINER="${CCS_CONTAINER_NAME:-ccs}"
CONTAINER_BIN="/root/.ccs/cliproxy/bin/plus/cli-proxy-api-plus"
PIN_VERSION="${CLIPROXY_PLUS_VERSION:-7.1.68-6}"
CONTAINER_ARCH="${CLIPROXY_PLUS_ARCH:-}"

mkdir -p "${PLUS_DIR}"

resolve_container_arch() {
  if [[ -n "${CONTAINER_ARCH}" ]]; then
    echo "${CONTAINER_ARCH}"
    return
  fi
  if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    case "$(docker exec "${CONTAINER}" uname -m)" in
      aarch64|arm64) echo "linux_aarch64" ;;
      x86_64|amd64) echo "linux_amd64" ;;
      *) echo "linux_amd64" ;;
    esac
    return
  fi
  echo "linux_aarch64"
}

binary_supports_cursor() {
  [[ -x "${BIN}" ]] || return 1
  if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    docker exec "${CONTAINER}" "${CONTAINER_BIN}" --help 2>&1 | grep -q -- '-cursor-login'
    return
  fi
  strings "${BIN}" 2>/dev/null | grep -q -- '-cursor-login'
}

installed_version() {
  if [[ -f "${VERSION_FILE}" ]]; then
    tr -d 'v' < "${VERSION_FILE}"
  fi
}

download_plus_binary() {
  local arch="$1"
  local version="$2"
  local url tmpdir archive extracted
  url="https://github.com/kaitranntt/CLIProxyAPIPlus/releases/download/v${version}/CLIProxyAPIPlus_${version}_${arch}_no-plugin.tar.gz"
  tmpdir="$(mktemp -d)"
  archive="${tmpdir}/plus.tar.gz"

  echo "[i] Installing CLIProxy Plus v${version} into ccs data volume (${arch})..."
  curl -fsSL "${url}" -o "${archive}"
  tar -xzf "${archive}" -C "${tmpdir}"
  extracted="${tmpdir}/cli-proxy-api-plus"
  if [[ ! -f "${extracted}" ]]; then
    echo "[X] Archive did not contain cli-proxy-api-plus" >&2
    rm -rf "${tmpdir}"
    exit 1
  fi

  cp "${extracted}" "${BIN}"
  chmod +x "${BIN}"
  echo "${version}" > "${VERSION_FILE}"
  rm -rf "${tmpdir}"
  echo "[OK] CLIProxy Plus v${version} ready for ccs embedded cliproxy"
}

ARCH="$(resolve_container_arch)"
CURRENT="$(installed_version || true)"

if binary_supports_cursor && [[ "${CURRENT}" == "${PIN_VERSION}" ]]; then
  exit 0
fi

download_plus_binary "${ARCH}" "${PIN_VERSION}"
