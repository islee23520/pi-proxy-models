#!/usr/bin/env bash
# Install pi-proxy-models for both:
#   - pi coding-agent (TS extension: index.ts)
#   - grok / rust-pi agent (cliproxy-api-provider plugin)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROK_PLUGIN_SRC="$ROOT/plugins/grok/cliproxy-api-provider"

echo "[install] pi extension from $ROOT"
if command -v pi >/dev/null 2>&1; then
  if ! pi install "$ROOT"; then
    echo "[install] pi install failed; falling back to symlink"
    mkdir -p "$HOME/.pi/agent/extensions/cliproxy"
    ln -sfn "$ROOT/index.ts" "$HOME/.pi/agent/extensions/cliproxy/index.ts"
  fi
else
  echo "[install] pi CLI not found; symlink extension only"
  mkdir -p "$HOME/.pi/agent/extensions/cliproxy"
  ln -sfn "$ROOT/index.ts" "$HOME/.pi/agent/extensions/cliproxy/index.ts"
fi

echo "[install] grok plugin from $GROK_PLUGIN_SRC"
if command -v grok >/dev/null 2>&1; then
  if grok plugin list 2>/dev/null | grep -q 'cliproxy-api-provider'; then
    grok plugin uninstall cliproxy-api-provider 2>/dev/null || true
  fi
  if [ -e "$HOME/.grok/plugins/cliproxy-api-provider" ] && [ ! -L "$HOME/.grok/plugins/cliproxy-api-provider" ]; then
    ts=$(date +%Y%m%d%H%M%S)
    mv "$HOME/.grok/plugins/cliproxy-api-provider" "$HOME/.grok/plugins/cliproxy-api-provider.bak-$ts"
    echo "[install] backed up existing unmanaged plugin -> cliproxy-api-provider.bak-$ts"
  fi
  if ! grok plugin install "$GROK_PLUGIN_SRC" --trust; then
    echo "[install] grok plugin install failed; symlink fallback"
    mkdir -p "$HOME/.grok/plugins"
    ln -sfn "$GROK_PLUGIN_SRC" "$HOME/.grok/plugins/cliproxy-api-provider"
  fi
  grok plugin enable cliproxy-api-provider 2>/dev/null || true
else
  echo "[install] grok CLI not found; symlink plugin only"
  mkdir -p "$HOME/.grok/plugins"
  ln -sfn "$GROK_PLUGIN_SRC" "$HOME/.grok/plugins/cliproxy-api-provider"
fi

USER_CFG="$HOME/.grok/config.user.toml"
if [ -f "$USER_CFG" ] && ! grep -q 'cliproxy-api-provider' "$USER_CFG"; then
  echo "[install] adding cliproxy-api-provider to [plugins].enabled"
  python3 - <<'PY'
from pathlib import Path
import re
p = Path.home()/".grok/config.user.toml"
t = p.read_text()
if "cliproxy-api-provider" in t:
    raise SystemExit
m = re.search(r'(\[plugins\][\s\S]*?enabled\s*=\s*\[)([^\]]*)(\])', t)
if not m:
    raise SystemExit('no enabled list')
body = m.group(2)
if body.strip():
    if "\n" in body:
        insert = body.rstrip() + '\n    "cliproxy-api-provider",\n'
    else:
        insert = body.rstrip().rstrip(',') + ', "cliproxy-api-provider"'
else:
    insert = '\n    "cliproxy-api-provider",\n'
t = t[:m.start()] + m.group(1) + insert + m.group(3) + t[m.end():]
p.write_text(t)
print('updated config.user.toml')
PY
fi

echo "[install] sync grok models from catalog"
node "$GROK_PLUGIN_SRC/scripts/sync-models.mjs" --force

echo "[install] done"
echo "  pi:   pi --list-models grok-4.5"
echo "  grok: open TUI and pick CLIProxy grok-4.5 (defaultModel=grok-4.5)"
