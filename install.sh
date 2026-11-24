#!/usr/bin/env bash
# Installs or updates the Top Pill GNOME Shell extension for the current user.
# Once Top Pill is running, updates reload live — no need to log out.
set -euo pipefail
UUID="top-pill@jude.local"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
BUILD="$(date +%Y%m%d-%H%M%S)"

# Refuse a mixed set of files (an older copy unpacked over newer ones once
# made the pill freeze the pointer).
if [ -f "$SRC/MANIFEST" ]; then
  if ! (cd "$SRC" && sha256sum --quiet -c MANIFEST >/dev/null 2>&1); then
    echo "✗ The files in $SRC don't match each other (some are older or newer copies)."
    echo "  Nothing was installed. Ask Claude for a fresh copy of the folder."
    exit 1
  fi
else
  echo "✗ $SRC/MANIFEST is missing, so the files can't be checked. Nothing was installed."
  exit 1
fi

echo "→ Installing to $DEST (build $BUILD)"
OLD_LOADER="$(sha256sum "$DEST/extension.js" 2>/dev/null | cut -d' ' -f1)"
mkdir -p "$DEST/builds/$BUILD"
# Loader, settings, styles and icons live at the top level…
cp -r "$SRC/metadata.json" "$SRC/extension.js" "$SRC/prefs.js" "$SRC/stylesheet.css" "$SRC/schemas" "$SRC/icons" "$DEST/"
# …and the rest of the code goes into a fresh build folder.
for f in "$SRC"/*.js; do
  case "$(basename "$f")" in extension.js|prefs.js) ;; *) cp "$f" "$DEST/builds/$BUILD/";; esac
done
cp "$SRC"/*.js "$DEST/" 2>/dev/null || true   # fallback copy used before the first build exists
glib-compile-schemas "$DEST/schemas"
(cd "$DEST/builds/$BUILD" && sha256sum *.js > SUMS)   # lets `top-pill doctor` check the build later
PREV="$(cat "$DEST/builds/current" 2>/dev/null || true)"
echo "$BUILD" > "$DEST/builds/current"
# keep the three newest builds (never the one being replaced, so rollback works)
for d in $(ls -1 "$DEST/builds" | grep -v '^\.' | grep -v '^current$' | sort | head -n -3); do
  [ "$d" = "$PREV" ] || rm -rf "${DEST:?}/builds/$d"
done

# the `top-pill` command (status, doctor, reload, rollback, logs)
mkdir -p "$HOME/.local/bin"
install -m 755 "$(dirname "$SRC")/top-pill" "$HOME/.local/bin/top-pill"
# agent hooks helper, so `top-pill hooks enable` works from anywhere
mkdir -p "$HOME/.local/share/top-pill/agent-hooks"
install -m 755 "$(dirname "$SRC")/agent-hooks/agent-hooks.sh" "$(dirname "$SRC")/agent-hooks/top-pill-hook" "$HOME/.local/share/top-pill/agent-hooks/"

python3 - "$UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
cur = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip()
cur = cur.replace('@as ', '')
lst = ast.literal_eval(cur) if cur else []
if uuid not in lst:
    lst.append(uuid)
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(lst)])
PY
gsettings set org.gnome.shell disable-user-extensions false

if command -v gst-inspect-1.0 >/dev/null && ! gst-inspect-1.0 pulsesrc >/dev/null 2>&1; then
  echo "  Note: GStreamer's pulsesrc is missing, so the bars will use a gentle animation"
  echo "        instead of reacting to the music (sudo apt install gstreamer1.0-pulseaudio)."
fi

# Live reload works once the running shell uses the reloadable loader, which
# leaves a marker each time it starts (newer than the shell's own start time).
MARK="$DEST/builds/.loader-running"
SHELL_PID="$(pgrep -u "$(id -u)" -x gnome-shell | head -1 || true)"
LIVE=""
if [ -f "$MARK" ] && [ -n "$SHELL_PID" ]; then
  SHELL_START=$(( $(date +%s) - $(ps -o etimes= -p "$SHELL_PID" | tr -d ' ') ))
  [ "$(stat -c %Y "$MARK")" -ge "$SHELL_START" ] && LIVE=1
fi

if [ -n "$LIVE" ]; then
  echo "→ Reloading Top Pill"
  if "$HOME/.local/bin/top-pill" reload; then
    echo
    echo "Done — the new version is live. Check on it any time with: top-pill doctor"
  else
    echo
    echo "The reload didn't confirm. Run: top-pill doctor   (or go back with: top-pill rollback)"
  fi
  NEW_LOADER="$(sha256sum "$DEST/extension.js" | cut -d' ' -f1)"
  if [ -n "$OLD_LOADER" ] && [ "$OLD_LOADER" != "$NEW_LOADER" ]; then
    echo "  (The loader itself changed too; that part starts at your next log-in. No need to log out now.)"
  fi
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  Note: open a new terminal for the top-pill command to be found.";; esac
else
  echo
  echo "Done. Log out and back in once so GNOME Shell starts the reloadable version."
  echo "After that, running this script again updates Top Pill without logging out."
fi
