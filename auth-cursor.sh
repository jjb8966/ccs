#!/usr/bin/env bash
# Cursor OAuth for CLIProxy Plus (ccs container).
# Prefer: ./cursor-auth.sh
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cursor-auth.sh" "$@"
