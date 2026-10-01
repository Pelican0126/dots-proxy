#!/bin/sh
# dots launcher — starts dots-manager (console on http://127.0.0.1:8788/).
# Finds a Node >= 22 runtime: system node, Homebrew, then the runtime bundled
# with the ChatGPT desktop app (so a separate Node install is not required).
DIR="$(cd "$(dirname "$0")" && pwd)"

pick_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "$CODEX_MCP_NODE_PATH"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  return 1
}

NODE="$(pick_node)" || { echo "dots: no Node runtime found (need Node >= 22, or the ChatGPT desktop app)" >&2; exit 1; }
echo "dots: using node at $NODE ($("$NODE" --version))"
exec "$NODE" "$DIR/dots-manager.mjs" "$@"
