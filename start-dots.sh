#!/bin/sh
# dots launcher — starts dots-manager (console on http://127.0.0.1:8788/).
# Finds a Node >= 22 runtime: system node, Homebrew, then the runtime bundled
# with the ChatGPT desktop app (so a separate Node install is not required).
DIR="$(cd "$(dirname "$0")" && pwd)"

node_supported() {
  v="$1"
  major=$("$v" --version 2>/dev/null) || return 1
  major=${major#v}
  major=${major%%.*}
  [ "$major" -ge 22 ] 2>/dev/null
}

pick_node() {
  for c in \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "$CODEX_MCP_NODE_PATH"; do
    [ -n "$c" ] && [ -x "$c" ] && node_supported "$c" && { echo "$c"; return; }
  done
  return 1
}

NODE="$(pick_node)" || { echo "dots: no Node runtime found (need Node >= 22, or the ChatGPT desktop app)" >&2; exit 1; }
echo "dots: using node at $NODE ($("$NODE" --version))"
exec "$NODE" "$DIR/dots-manager.mjs" "$@"
