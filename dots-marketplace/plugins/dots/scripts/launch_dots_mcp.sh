#!/bin/sh
# dots MCP launcher (macOS/Linux). Prefers system node, falls back to the
# Node runtime bundled with the ChatGPT desktop app, then CODEX_MCP_NODE_PATH.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$DIR/server.mjs" "$@"
fi
CUA_NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
if [ -x "$CUA_NODE" ]; then
  exec "$CUA_NODE" "$DIR/server.mjs" "$@"
fi
if [ -n "$CODEX_MCP_NODE_PATH" ] && [ -x "$CODEX_MCP_NODE_PATH" ]; then
  exec "$CODEX_MCP_NODE_PATH" "$DIR/server.mjs" "$@"
fi
echo "dots: node runtime not found (need Node >= 22)" >&2
exit 1
