#!/usr/bin/env bash
# Remove stored Cursor OAuth accounts from the ccs container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/cursor-common.sh
source "${ROOT}/scripts/cursor-common.sh"

cursor_require_container

echo "[i] Logging out Cursor accounts in ${CONTAINER}..."
cursor_exec cursor --logout

echo "[i] Restarting cliproxy..."
cursor_restart_cliproxy

echo "[OK] Cursor logout finished."
echo "    Next: ${ROOT}/cursor-auth.sh"
