#!/usr/bin/env bash
# Render deploy/state/.ccs from .env (host-side, before docker compose up)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[X] Missing ${ENV_FILE}. Copy .env.example to .env and set CCS_PROXY_TOKEN." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

if [[ -z "${CCS_PROXY_TOKEN:-}" ]]; then
  echo "[X] CCS_PROXY_TOKEN is empty in .env" >&2
  exit 1
fi

CCS_PUBLIC_HOST="${CCS_PUBLIC_HOST:-jjb8966.duckdns.org}"
CCS_PUBLIC_PATH="${CCS_PUBLIC_PATH:-/ccs}"
CCS_CURSOR_MODEL="${CCS_CURSOR_MODEL:-composer-2.5}"

STATE="${ROOT}/deploy/state/.ccs"
PROVIDERS="${STATE}/cliproxy/providers"
mkdir -p "${PROVIDERS}"

# cursor provider settings (inside container)
sed \
  -e "s|__CCS_PROXY_TOKEN__|${CCS_PROXY_TOKEN}|g" \
  -e "s|__CCS_CURSOR_MODEL__|${CCS_CURSOR_MODEL}|g" \
  "${ROOT}/deploy/templates/cursor.settings.json" > "${PROVIDERS}/cursor.settings.json"

export CCS_RENDER_ROOT="${ROOT}"
export CCS_CURSOR_MODEL
python3 << 'PY'
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

root = Path(os.environ["CCS_RENDER_ROOT"])
state = root / "deploy/state/.ccs"
token = os.environ["CCS_PROXY_TOKEN"]
cursor_model = os.environ.get("CCS_CURSOR_MODEL", "composer-2.5")
config_path = state / "config.yaml"

if yaml and config_path.exists():
    with config_path.open() as f:
        config = yaml.safe_load(f) or {}
elif yaml:
    config = {"version": 1}
else:
    config = None

if config is not None:
    cliproxy = config.setdefault("cliproxy", {})
    cliproxy["backend"] = "plus"
    auth = cliproxy.setdefault("auth", {})
    auth["api_key"] = token
    cliproxy.setdefault("oauth_accounts", {})
    cliproxy.setdefault("variants", {})
    cursor_cfg = config.setdefault("cursor", {})
    cursor_cfg["enabled"] = True
    cursor_cfg["auto_start"] = True
    cursor_cfg["port"] = 20129
    cursor_cfg["ghost_mode"] = True
    cursor_cfg["model"] = cursor_model
    with config_path.open("w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
        f.write("\n")
else:
    # PyYAML not installed: write minimal config if missing
    if not config_path.exists():
        config_path.write_text(
            f"""version: 1
cliproxy:
  backend: plus
  auth:
    api_key: {token}
  oauth_accounts: {{}}
  variants: {{}}
cursor:
  enabled: true
  auto_start: true
  port: 20129
  ghost_mode: true
  model: {cursor_model}
""",
            encoding="utf-8",
        )
    else:
        print("[!] PyYAML not found; kept existing config.yaml (ensure cliproxy.backend: plus and api_key match .env)")

cliproxy_cfg_path = state / "cliproxy/config.yaml"
if yaml and cliproxy_cfg_path.exists():
    with cliproxy_cfg_path.open() as f:
        cp_cfg = yaml.safe_load(f) or {}
    cp_cfg["api-keys"] = [token]
    with cliproxy_cfg_path.open("w") as f:
        yaml.dump(cp_cfg, f, default_flow_style=False, sort_keys=False)
        f.write("\n")
    print(f"[OK] Synced api-keys in {cliproxy_cfg_path}")

def bridge_native_cursor_credentials() -> None:
    auth_dir = state / "cliproxy/auth"
    cred_path = state / "cursor/credentials.json"
    if not auth_dir.exists():
        print("[!] No cliproxy auth dir; skip native Cursor credential bridge")
        return

    candidates = sorted(
        auth_dir.glob("cursor*.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for file_path in candidates:
        try:
            record = json.loads(file_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if record.get("disabled") or record.get("type") != "cursor":
            continue
        access_token = str(record.get("access_token") or "").strip()
        subject = str(record.get("sub") or "").strip()
        if len(access_token) < 50 or not subject:
            continue
        machine_id = hashlib.sha256(subject.encode("utf-8")).hexdigest()[:32]
        auto_machine_id = None
        cursor_db_candidates = [
            Path.home() / "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
            Path.home() / ".config/Cursor/User/globalStorage/state.vscdb",
        ]
        for db_path in cursor_db_candidates:
            if not db_path.exists():
                continue
            try:
                import sqlite3

                conn = sqlite3.connect(db_path)
                try:
                    for key in (
                        "storage.serviceMachineId",
                        "storage.machineId",
                        "telemetry.machineId",
                    ):
                        row = conn.execute(
                            "SELECT value FROM itemTable WHERE key=?",
                            (key,),
                        ).fetchone()
                        if row and row[0]:
                            candidate = str(row[0]).strip().strip('"')
                            normalized = candidate.replace("-", "")
                            if len(normalized) == 32:
                                auto_machine_id = normalized
                                break
                finally:
                    conn.close()
            except Exception:
                continue
            if auto_machine_id:
                break
        if auto_machine_id:
            machine_id = auto_machine_id
        cred_path.parent.mkdir(parents=True, exist_ok=True)
        cred_path.write_text(
            json.dumps(
                {
                    "accessToken": access_token,
                    "machineId": machine_id,
                    "authMethod": "manual",
                    "importedAt": datetime.now(timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "userId": subject,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        cred_path.chmod(0o600)
        print(f"[OK] Bridged native Cursor credentials from {file_path.name}")
        return

    print("[!] No usable CLIProxy Cursor auth file found for native bridge")

bridge_native_cursor_credentials()

print(f"[OK] Wrote {state / 'cliproxy/providers/cursor.settings.json'}")
if config_path.exists():
    print(f"[OK] Updated {config_path}")
PY

chmod 600 "${PROVIDERS}/cursor.settings.json" 2>/dev/null || true

echo "[i] Public Claude base URL:"
echo "    https://${CCS_PUBLIC_HOST}${CCS_PUBLIC_PATH}/api/provider/cursor"
