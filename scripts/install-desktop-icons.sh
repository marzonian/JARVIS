#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER_SCRIPT="$ROOT_DIR/scripts/desktop-launcher.sh"
ICON_DEFAULT="$ROOT_DIR/scripts/assets/3130_v2.icns"
ICON_ACTIVE="$ROOT_DIR/scripts/assets/3130_active.icns"
ICON_SOURCE="$ICON_DEFAULT"
DESKTOP_DIR="$HOME/Desktop"
APP_NORMAL="$DESKTOP_DIR/3130.app"
APP_SAFE="$DESKTOP_DIR/3130 Safe Mode.app"
TMP_DIR="$(mktemp -d /tmp/3130-icons.XXXXXX)"

if [[ -f "$ICON_ACTIVE" ]]; then
  ICON_SOURCE="$ICON_ACTIVE"
fi

if [[ ! -x "$LAUNCHER_SCRIPT" ]]; then
  echo "[ERR] Launcher missing or not executable: $LAUNCHER_SCRIPT" >&2
  exit 1
fi

cleanup() {
  rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

escape_apple() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

SCRIPT_ESCAPED="$(escape_apple "$LAUNCHER_SCRIPT")"

plist_put_string() {
  local plist="$1"
  local key="$2"
  local value="$3"
  if /usr/libexec/PlistBuddy -c "Print :${key}" "$plist" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :${key} ${value}" "$plist" >/dev/null
  else
    /usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "$plist" >/dev/null
  fi
}

build_app() {
  local mode="$1"
  local app_path="$2"
  local bundle_id="$3"
  local display_name="$4"
  local applescript_file="$TMP_DIR/${mode}.applescript"

  cat > "$applescript_file" <<APPLESCRIPT
on run
  try
    do shell script "/bin/zsh \"${SCRIPT_ESCAPED}\" ${mode} >> /tmp/3130-launcher-invoke.log 2>&1"
  on error errMsg number errNum
    display alert "3130" message "Launcher failed (" & errNum & "): " & errMsg as critical buttons {"OK"} default button "OK"
  end try
end run
APPLESCRIPT

  rm -rf "$app_path"
  osacompile -o "$app_path" "$applescript_file" >/dev/null

  local plist="$app_path/Contents/Info.plist"
  plist_put_string "$plist" "CFBundleIdentifier" "$bundle_id"
  plist_put_string "$plist" "CFBundleDisplayName" "$display_name"
  plist_put_string "$plist" "CFBundleName" "$display_name"
  plist_put_string "$plist" "CFBundleIconFile" "3130"
  plist_put_string "$plist" "CFBundleIconName" "3130"
  plist_put_string "$plist" "LSMinimumSystemVersion" "11.0"

  if [[ -f "$ICON_SOURCE" ]]; then
    cp "$ICON_SOURCE" "$app_path/Contents/Resources/3130.icns"
  elif [[ -f "$DESKTOP_DIR/3130.app/Contents/Resources/3130.icns" ]]; then
    cp "$DESKTOP_DIR/3130.app/Contents/Resources/3130.icns" "$app_path/Contents/Resources/3130.icns"
  elif [[ -f "$DESKTOP_DIR/3130 Safe Mode.app/Contents/Resources/3130.icns" ]]; then
    cp "$DESKTOP_DIR/3130 Safe Mode.app/Contents/Resources/3130.icns" "$app_path/Contents/Resources/3130.icns"
  fi

  chmod -R u+rwX,go+rX "$app_path"
  # Re-sign after all edits/permission changes so Finder can launch cleanly.
  codesign --force --deep --sign - "$app_path" >/dev/null
  xattr -dr com.apple.quarantine "$app_path" >/dev/null 2>&1 || true
  xattr -dr com.apple.provenance "$app_path" >/dev/null 2>&1 || true
}

build_app "normal" "$APP_NORMAL" "ai.3130.launcher" "3130"
build_app "safe" "$APP_SAFE" "ai.3130.launcher.safemode" "3130 Safe Mode"

CMD_LAUNCHER="$DESKTOP_DIR/3130.command"
cat > "$CMD_LAUNCHER" <<CMD
#!/bin/zsh
exec /bin/zsh "$LAUNCHER_SCRIPT" normal
CMD
chmod +x "$CMD_LAUNCHER"
xattr -d com.apple.quarantine "$CMD_LAUNCHER" >/dev/null 2>&1 || true
xattr -d com.apple.provenance "$CMD_LAUNCHER" >/dev/null 2>&1 || true

touch "$APP_NORMAL" "$APP_SAFE" "$CMD_LAUNCHER"

echo "[OK] Installed desktop launchers:"
echo "  - $APP_NORMAL"
echo "  - $APP_SAFE"
echo "  - $CMD_LAUNCHER"
