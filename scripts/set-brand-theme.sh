#!/bin/zsh
set -euo pipefail

THEME="${1:-ultra6}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STYLE_DIR="$ROOT_DIR/client/src/styles"
ASSETS_DIR="$ROOT_DIR/scripts/assets"
UI_LINK="$STYLE_DIR/globals.css"
ICON_LINK="$ASSETS_DIR/3130_active.icns"
SYNC_SCRIPT="$ROOT_DIR/scripts/sync-desktop-icons.sh"

case "$THEME" in
  ultra6)
    UI_TARGET="$STYLE_DIR/globals.ultra6.css"
    ICON_TARGET="$ASSETS_DIR/3130_ultra6.icns"
    ;;
  v2|current)
    UI_TARGET="$STYLE_DIR/globals.v2.css"
    ICON_TARGET="$ASSETS_DIR/3130_v2.icns"
    ;;
  *)
    echo "Usage: zsh scripts/set-brand-theme.sh [ultra6|v2]" >&2
    exit 2
    ;;
esac

if [[ ! -f "$UI_TARGET" ]]; then
  echo "[ERR] Missing UI theme file: $UI_TARGET" >&2
  exit 1
fi

if [[ ! -f "$ICON_TARGET" ]]; then
  echo "[ERR] Missing icon file: $ICON_TARGET" >&2
  exit 1
fi

rm -f "$UI_LINK" "$ICON_LINK"
ln -s "$(basename "$UI_TARGET")" "$UI_LINK"
ln -s "$(basename "$ICON_TARGET")" "$ICON_LINK"

if [[ "${NO_BUILD:-0}" != "1" ]]; then
  (cd "$ROOT_DIR" && npm run build >/tmp/3130-theme-build.log 2>&1)
fi

if [[ -x "$SYNC_SCRIPT" ]]; then
  /bin/zsh "$SYNC_SCRIPT" --ensure >/tmp/3130-theme-icon-sync.log 2>&1 || true
fi

echo "[OK] Theme set to: $THEME"
echo "[OK] UI source: $UI_TARGET"
echo "[OK] Icon source: $ICON_TARGET"
if [[ "${NO_BUILD:-0}" != "1" ]]; then
  echo "[OK] Client rebuilt. Refresh browser to apply."
fi
