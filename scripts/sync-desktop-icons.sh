#!/bin/zsh
set -euo pipefail

MODE="${1:---ensure}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SCRIPT="$ROOT_DIR/scripts/install-desktop-icons.sh"
ICON_DEFAULT="$ROOT_DIR/scripts/assets/3130_v2.icns"
ICON_ACTIVE="$ROOT_DIR/scripts/assets/3130_active.icns"
ICON_SOURCE="$ICON_DEFAULT"
DESKTOP_DIR="$HOME/Desktop"
APP_NORMAL="$DESKTOP_DIR/3130.app"
APP_SAFE="$DESKTOP_DIR/3130 Safe Mode.app"
CMD_LAUNCHER="$DESKTOP_DIR/3130.command"

if [[ -f "$ICON_ACTIVE" ]]; then
  ICON_SOURCE="$ICON_ACTIVE"
fi

if [[ ! -f "$ICON_SOURCE" ]]; then
  echo "[ERR] Icon source missing: $ICON_SOURCE" >&2
  exit 1
fi

if [[ ! -x "$INSTALL_SCRIPT" ]]; then
  echo "[ERR] Install script missing or not executable: $INSTALL_SCRIPT" >&2
  exit 1
fi

hash_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

plist_get() {
  local plist="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :${key}" "$plist" 2>/dev/null || true
}

needs_rebuild=0

if [[ "$MODE" == "--force" ]]; then
  needs_rebuild=1
fi

if [[ ! -f "$CMD_LAUNCHER" ]]; then
  needs_rebuild=1
fi

src_hash="$(hash_file "$ICON_SOURCE")"

for app_path in "$APP_NORMAL" "$APP_SAFE"; do
  plist="$app_path/Contents/Info.plist"
  icon_file="$app_path/Contents/Resources/3130.icns"

  if [[ ! -d "$app_path" || ! -f "$plist" || ! -f "$icon_file" ]]; then
    needs_rebuild=1
    continue
  fi

  icon_name="$(plist_get "$plist" "CFBundleIconFile")"
  if [[ "$icon_name" != "3130" ]]; then
    needs_rebuild=1
  fi

  app_hash="$(hash_file "$icon_file")"
  if [[ "$app_hash" != "$src_hash" ]]; then
    needs_rebuild=1
  fi
done

if [[ "$needs_rebuild" -eq 1 ]]; then
  /bin/zsh "$INSTALL_SCRIPT"
else
  # Touch to help Finder refresh icon metadata if needed.
  touch "$APP_NORMAL" "$APP_SAFE" "$CMD_LAUNCHER" >/dev/null 2>&1 || true
  echo "[OK] Desktop launchers already synchronized."
fi

