#!/usr/bin/env bash
# Lets Claude Code and Codex ask Top Pill for permission (Allow / Always / Deny).
#   bash agent-hooks.sh enable    add Top Pill's hooks (your own hooks are kept; a backup is made)
#   bash agent-hooks.sh disable   take them out again
#   bash agent-hooks.sh status    show what is set up
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/top-pill"
HOOK="$DEST/top-pill-hook"
ACTION="${1:-status}"

if [ "$ACTION" = "enable" ]; then
  mkdir -p "$DEST"
  install -m 755 "$HERE/top-pill-hook" "$HOOK"
fi

python3 - "$ACTION" "$HOOK" <<'PY'
import json, os, shutil, sys, time
action, hook = sys.argv[1], sys.argv[2]
home = os.path.expanduser("~")
claude = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude"), "settings.json")
codex = os.path.join(os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"), "hooks.json")
MARK = "top-pill-hook"
targets = [
    ("Claude Code", claude, "claude", [("PermissionRequest", 600), ("Notification", None), ("Stop", None)]),
    ("Codex", codex, "codex", [("PermissionRequest", 600), ("Stop", None)]),
]

def load(path):
    if not os.path.exists(path):
        return {}
    text = open(path).read()
    if not text.strip():
        return {}
    return json.loads(text)   # invalid JSON stops here, untouched

def save(path, data):
    if os.path.exists(path):
        backup = f"{path}.before-top-pill"
        if not os.path.exists(backup):
            shutil.copy2(path, backup)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)

def strip(data):
    hooks = data.get("hooks") or {}
    changed = False
    for event in list(hooks):
        groups = hooks[event]
        kept = []
        for g in groups:
            inner = [h for h in g.get("hooks", []) if MARK not in str(h.get("command", ""))]
            changed |= len(inner) != len(g.get("hooks", []))
            if inner:
                g["hooks"] = inner
                kept.append(g)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks and "hooks" in data:
        del data["hooks"]
    return changed

for name, path, ai, events in targets:
    tool_dir = os.path.dirname(path)
    if action == "status":
        try:
            on = MARK in json.dumps(load(path).get("hooks", {}))
        except Exception as e:
            on = f"unreadable ({e})"
        print(f"{name}: {'on' if on is True else on if on else 'off'}  ({path})")
        continue
    if not os.path.isdir(tool_dir):
        print(f"{name}: not installed, skipped")
        continue
    try:
        data = load(path)
    except Exception as e:
        print(f"{name}: {path} is not valid JSON, left untouched ({e})")
        continue
    strip(data)
    if action == "enable":
        hooks = data.setdefault("hooks", {})
        for event, timeout in events:
            h = {"type": "command", "command": f"{hook} {ai}"}
            if timeout:
                h["timeout"] = timeout
            hooks.setdefault(event, []).append({"hooks": [h]})
        save(path, data)
        print(f"{name}: on  ({path}; backup: {path}.before-top-pill)")
    elif action == "disable":
        save(path, data)
        print(f"{name}: off ({path})")
PY

if [ "$ACTION" = "disable" ]; then
  rm -f "$HOOK"
fi
if [ "$ACTION" = "enable" ]; then
  echo
  echo "Done. Agents started from now on will ask Top Pill. Already-running sessions pick it up when restarted."
fi
