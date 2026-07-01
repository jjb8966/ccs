#!/usr/bin/env bash
# Authenticate a Cursor account in the ccs container (management API OAuth).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/cursor-common.sh
source "${ROOT}/scripts/cursor-common.sh"

bash "${ROOT}/scripts/cursor-oauth-flow.sh"

cursor_require_container

echo ""
echo "[i] Accounts:"
cursor_exec cursor --accounts || true

echo ""
echo "[OK] Cursor auth finished."
echo "    Verify: ${ROOT}/cursor-accounts.sh"
