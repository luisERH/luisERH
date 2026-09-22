#!/usr/bin/env bash
# Sobe o servidor e um túnel público numa tacada só.
#
# Uso: ./scripts/dev.sh
# Requer: cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${ALEXA_MCP_PORT:-8080}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared não encontrado. Instale-o ou exponha a porta $PORT por outro túnel." >&2
  exit 1
fi

TUNNEL_LOG="$(mktemp)"
cloudflared tunnel --url "http://127.0.0.1:${PORT}" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill "$TUNNEL_PID" 2>/dev/null || true; rm -f "$TUNNEL_LOG"' EXIT

echo "aguardando o túnel..."
PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "não consegui descobrir a URL do túnel; veja $TUNNEL_LOG" >&2
  exit 1
fi

echo "túnel:    $PUBLIC_URL"
echo "endpoint: $PUBLIC_URL/mcp"
ALEXA_MCP_PUBLIC_URL="$PUBLIC_URL" python -m alexa_claude_mcp
