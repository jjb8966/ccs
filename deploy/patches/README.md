# CLIProxyAPIPlus cursor stream patch

Pinned binary: `CLIProxyAPIPlus v7.1.68-6`

## Why

Stock Plus has Hermes-breaking behaviors on Cursor streams:

1. Thinking is wrapped as `content` with `<think>` markers instead of
   `delta.reasoning_content`.
2. Cursor MCP tool call IDs sometimes contain raw newlines
   (`call-...\nfc_...`). Emitting those unescaped into SSE `data: {...}`
   truncates the JSON event, so Hermes sees `finish_reason=tool_calls`
   with empty/broken `tool_calls` and stops after announcing work.
3. Cursor built-in web search sends `InteractionQuery` (ASM field 7) and
   waits for `InteractionResponse`. Stock Plus ignores it, so streams hang
   after text like "확인 중입니다" with only heartbeats.
4. `span_context` (exec field 19) was misclassified as an unknown tool and
   could steal the real tool field number (e.g. field 28).

## What this patch changes

Files:

- `internal/runtime/executor/cursor_executor.go`
- `internal/auth/cursor/proto/decode.go`
- `internal/auth/cursor/proto/encode.go`
- `internal/auth/cursor/proto/fieldnumbers.go`

1. Emit thinking as `delta.reasoning_content` (no `<think>` wrappers).
2. Emit an immediate `{"role":"assistant"}` chunk when the stream opens so
   clients are not stuck on "no chunks yet" during Cursor prefill/thinking.
3. Sanitize tool call IDs (drop embedded newlines) and JSON-escape
   `id` / `name` when building tool_call SSE chunks.
4. Do **not** emit empty `reasoning_content` keepalives (those reset Hermes
   stale timers and can keep dead streams open).
5. Decode `InteractionQuery` (`id` is `uint32`) and auto-approve with
   `EncodeInteractionQueryApproved` so built-in web search can complete.
6. Ignore `span_context` (field 19); reject/bridge other unknown exec fields
   instead of hanging with no reply.

## Apply / rebuild (linux/arm64 container)

```bash
git clone --depth 1 --branch v7.1.68-6 https://github.com/kaitranntt/CLIProxyAPIPlus.git /tmp/CLIProxyAPIPlus
cd /tmp/CLIProxyAPIPlus
patch -p1 < /path/to/ccs/deploy/patches/cli-proxy-api-plus-v7.1.68-6-cursor-reasoning-keepalive.patch
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o cli-proxy-api-plus ./cmd/server
cp cli-proxy-api-plus /path/to/ccs/deploy/state/.ccs/cliproxy/bin/plus/cli-proxy-api-plus
echo 'patched-for-hermes-iq-uint32-id' > /path/to/ccs/deploy/state/.ccs/cliproxy/bin/plus/.local-patch
docker exec ccs supervisorctl restart cliproxy
```

Hermes `custom:ccs` points at nginx `/ccs/` → cliproxy `:8317` (this binary),
not the Node `cursor-daemon` on `:20129`.

## Additional Hermes hang fixes (2026-07-09)

Marker: `patched-for-hermes-idle-ignore-heartbeat`

- MCP tool result `tool_call_id` mismatch fallback (sole result) + reject if none
- Tool-result wait timeout 90s (was infinite hang on orphaned resume)
- Stream idle timeout 120s that **ignores Cursor heartbeats** (heartbeats previously reset idle forever)
- InteractionQuery kind 2–8 auto-approve; kind 9+ (URL fetch) reject (empty Approved hangs)

## Incomplete-stop fix (2026-07-09 evening)

Marker: `patched-for-hermes-incomplete-stop-20260709`

Problem: after stream idle timeout (or other mid-turn errors), Plus still
emitted `finish_reason=stop` + `[DONE]`. Hermes treated the partial status
sentence ("조사합니다…확인합니다.") as a finished answer, so users saw
reasoning + progress text with no real conclusion.

Changes in `cursor_executor.go`:

1. On stream error **after** SSE data was already sent, emit
   `finish_reason=length` (not `stop`) and append a short
   `[stream interrupted before final answer]` content note so Hermes can
   treat the turn as truncated / retryable.
2. After InteractionQuery auto-approve, extend idle budget (~5 min while
   Cursor runs built-in search) so heartbeats-only search windows are less
   likely to cut the turn right after a status sentence.

