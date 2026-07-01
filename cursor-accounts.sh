#!/usr/bin/env bash
# List Cursor accounts registered in the ccs container.
set -euo pipefail

# shellcheck source=scripts/cursor-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/cursor-common.sh"

cursor_require_container

cursor_exec cursor --accounts
