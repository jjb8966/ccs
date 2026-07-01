#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/deploy-common.sh
source "${ROOT}/scripts/deploy-common.sh"
deploy_load_ccs_env "${ROOT}"

CURSOR_PORT="${CCS_CURSOR_DAEMON_PORT:-20129}"
OLLAMA_PORT="${OLLAMA_PROXY_PORT:-5002}"
MODEL="${CCS_CURSOR_MODEL:-composer-2.5}"

RED_B64="$(
  python3 - <<'PY'
import base64, struct, zlib

def png_chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xffffffff
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

width, height = 64, 64
raw = b''.join(b'\x00' + b'\xff\x00\x00' * width for _ in range(height))
compressed = zlib.compress(raw, 9)
png = b'\x89PNG\r\n\x1a\n'
png += png_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
png += png_chunk(b'IDAT', compressed)
png += png_chunk(b'IEND', b'')
print(base64.b64encode(png).decode())
PY
)"

auth_header=( -H "Authorization: Bearer ${CCS_PROXY_TOKEN}" )
json_header=( -H "Content-Type: application/json" )

fail() {
  echo "[X] $*" >&2
  exit 1
}

extract_content() {
  python3 - "$1" <<'PY'
import json, re, sys
raw = sys.argv[1]
d = json.loads(raw)
if 'error' in d:
    print('__ERROR__:' + json.dumps(d['error']))
    raise SystemExit(2)
choices = d.get('choices') or []
if not choices:
    print('__ERROR__:missing choices')
    raise SystemExit(2)
msg = choices[0].get('message', {}) or {}
content = msg.get('content')
reasoning = msg.get('reasoning_content')
text = content if isinstance(content, str) and content.strip() else ''
if not text and isinstance(reasoning, str):
    for marker in ('</think>', '<｜final｜>', '<|final|>'):
        idx = reasoning.find(marker)
        if idx != -1:
            text = reasoning[idx + len(marker):].strip()
            break
    if not text:
        text = reasoning.strip()
print(text)
PY
}

echo "==> E2E 1: Cursor daemon text baseline (:${CURSOR_PORT})"
TEXT_RESP="$(
  curl -sS --max-time 120 \
    "${auth_header[@]}" "${json_header[@]}" \
    -d '{"model":"'"${MODEL}"'","max_tokens":16,"stream":false,"messages":[{"role":"user","content":"Reply with exactly the word OK."}]}' \
    "http://127.0.0.1:${CURSOR_PORT}/v1/chat/completions"
)"
TEXT_CONTENT="$(extract_content "${TEXT_RESP}" || true)"
if [[ "${TEXT_CONTENT}" == __ERROR__:* ]]; then
  fail "Text baseline failed: ${TEXT_CONTENT#__ERROR__:}"
fi
echo "[OK] Text baseline: ${TEXT_CONTENT}"

echo ""
echo "==> E2E 2: Cursor daemon image vision (:${CURSOR_PORT})"
IMG_PAYLOAD="$(
  RED_B64="${RED_B64}" MODEL="${MODEL}" python3 - <<'PY'
import json, os
red = os.environ['RED_B64']
print(json.dumps({
  'model': os.environ.get('MODEL', 'composer-2.5'),
  'max_tokens': 32,
  'stream': False,
  'messages': [{
    'role': 'user',
    'content': [
      {'type': 'text', 'text': 'What is the dominant color in this image? Reply with one word only.'},
      {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{red}'}}
    ]
  }]
}))
PY
)"
IMG_RESP="$(
  curl -sS --max-time 180 \
    "${auth_header[@]}" "${json_header[@]}" \
    -d "${IMG_PAYLOAD}" \
    "http://127.0.0.1:${CURSOR_PORT}/v1/chat/completions"
)"
IMG_CONTENT="$(extract_content "${IMG_RESP}" || true)"
if [[ "${IMG_CONTENT}" == __ERROR__:* ]]; then
  fail "Image vision failed: ${IMG_CONTENT#__ERROR__:}"
fi
echo "Image response: ${IMG_CONTENT}"
if echo "${IMG_CONTENT}" | grep -Eiq '\bred\b'; then
  echo "[OK] Model identified red — native cursor daemon vision path works"
else
  fail "Expected model to mention red; got: ${IMG_CONTENT}"
fi

echo ""
echo "==> E2E 3: ollama-proxy -> CCS image path (:${OLLAMA_PORT})"
PROXY_PAYLOAD="$(
  RED_B64="${RED_B64}" MODEL="${MODEL}" python3 - <<'PY'
import json, os
red = os.environ['RED_B64']
print(json.dumps({
  'model': f"ccs:{os.environ.get('MODEL', 'composer-2.5')}",
  'max_tokens': 32,
  'stream': False,
  'messages': [{
    'role': 'user',
    'content': [
      {'type': 'text', 'text': 'What is the dominant color in this image? Reply with one word only.'},
      {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{red}'}}
    ]
  }]
}))
PY
)"
PROXY_RESP="$(
  curl -sS --max-time 180 \
    "${auth_header[@]}" "${json_header[@]}" \
    -d "${PROXY_PAYLOAD}" \
    "http://127.0.0.1:${OLLAMA_PORT}/v1/chat/completions"
)"
PROXY_CONTENT="$(extract_content "${PROXY_RESP}" || true)"
if [[ "${PROXY_CONTENT}" == __ERROR__:* ]]; then
  fail "ollama-proxy image path failed: ${PROXY_CONTENT#__ERROR__:}"
fi
echo "Proxy image response: ${PROXY_CONTENT}"
if echo "${PROXY_CONTENT}" | grep -Eiq '\bred\b'; then
  echo "[OK] Model identified red — ollama-proxy -> CCS vision path works"
else
  fail "Expected proxy path to mention red; got: ${PROXY_CONTENT}"
fi

echo ""
echo "[OK] All cursor image E2E checks passed"
