#!/usr/bin/env bash
# Removes Top Pill and puts GNOME's notification banners back.
#   ./uninstall.sh          remove the extension, its cache and the top-pill command
#   ./uninstall.sh --purge  also reset Top Pill's settings
set -euo pipefail
UUID="top-pill@jude.local"
HERE="$(cd "$(dirname "$0")" && pwd)"
gnome-extensions disable "$UUID" 2>/dev/null || true
python3 - "$UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
cur = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip().replace('@as ', '')
lst = [u for u in (ast.literal_eval(cur) if cur else []) if u != uuid]
subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(lst)])
PY
# agent hooks (only removes Top Pill's own entries)
if [ -f "$HERE/agent-hooks/agent-hooks.sh" ]; then
  bash "$HERE/agent-hooks/agent-hooks.sh" disable >/dev/null 2>&1 || true
fi
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID" "$HOME/.cache/top-pill" "$HOME/.local/bin/top-pill" "$HOME/.local/share/top-pill"
if [ "${1:-}" = "--purge" ]; then
  dconf reset -f /org/gnome/shell/extensions/top-pill/ && echo "→ Settings reset"
fi
echo "Top Pill removed. GNOME's own banners are back now; no need to log out."
