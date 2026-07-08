#!/usr/bin/env bash
# Build dist/cursor before docker compose up (empty mount shadows npm cursor module).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="${ROOT}/dist/cursor/cursor-daemon-entry.js"

if [[ -f "${MARKER}" ]]; then
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[X] bun is required to build dist/cursor (install: https://bun.sh)" >&2
  exit 1
fi

echo "==> Building dist/cursor overlay for container mount..."
if [[ ! -x "${ROOT}/node_modules/.bin/tsc" ]]; then
  (cd "${ROOT}" && bun install)
fi
(cd "${ROOT}" && bun run build)
echo "[OK] dist/cursor ready"
