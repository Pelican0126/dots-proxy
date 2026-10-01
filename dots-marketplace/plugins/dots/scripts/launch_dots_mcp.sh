#!/bin/sh
# dots MCP launcher (macOS/Linux). Prefers system node, falls back to the
# Node runtime bundled with the ChatGPT desktop app, then CODEX_MCP_NODE_PATH.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
node_supported() {
  v="$1"
  major=$("$v" --version 2>/dev/null) || return 1
  major=${major#v}
  major=${major%%.*}
  [ "$major" -ge 22 ] 2>/dev/null
}
PATH_NODE="$(command -v node 2>/dev/null || true)"
if [ -n "$PATH_NODE" ] && node_supported "$PATH_NODE"; then
  exec "$PATH_NODE" "$DIR/server.mjs" "$@"
fi
CUA_NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
if [ -x "$CUA_NODE" ] && node_supported "$CUA_NODE"; then
  exec "$CUA_NODE" "$DIR/server.mjs" "$@"
fi
if [ -n "$CODEX_MCP_NODE_PATH" ] && [ -x "$CODEX_MCP_NODE_PATH" ] && node_supported "$CODEX_MCP_NODE_PATH"; then
  exec "$CODEX_MCP_NODE_PATH" "$DIR/server.mjs" "$@"
fi
echo "dots: node runtime not found (need Node >= 22)" >&2
exit 1
