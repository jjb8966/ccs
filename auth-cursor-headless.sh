#!/usr/bin/env bash
# Cursor OAuth without local browser (SSH / headless).
# Prefer: CCS_AUTH_HEADLESS=1 ./cursor-auth.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CCS_AUTH_HEADLESS=1
export CCS_OPEN_BROWSER=0
exec "${ROOT}/scripts/cursor-oauth-flow.sh" "$@"
