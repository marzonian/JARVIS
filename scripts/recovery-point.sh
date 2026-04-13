#!/bin/zsh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_FILE="$APP_DIR/data/mcnair.db"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
RECOVERY_DIR="$APP_DIR/data/backups/recovery_${STAMP}"
LAUNCHER_DIR="$RECOVERY_DIR/launcher_files"

mkdir -p "$RECOVERY_DIR" "$LAUNCHER_DIR"

if [[ -f "$DB_FILE" ]]; then
  cp "$DB_FILE" "$RECOVERY_DIR/mcnair.db"
else
  echo "[3130] Database not found: $DB_FILE" >&2
  exit 1
fi

# Keep key startup files so restore can return to a known-good launch state.
for f in "$APP_DIR/package.json" "$APP_DIR/setup.sh" "$APP_DIR/update.sh" "$APP_DIR/deploy.sh"; do
  [[ -f "$f" ]] && cp "$f" "$RECOVERY_DIR/"
done

# Capture desktop/app launcher artifacts if present.
typeset -a search_dirs
search_dirs=("$APP_DIR" "$HOME/Desktop" "$HOME/Applications")

for dir in "${search_dirs[@]}"; do
  [[ -d "$dir" ]] || continue

  find "$dir" -maxdepth 2 \( \
    -name '*3130*.command' -o \
    -name '*3130*.app' -o \
    -name '*3130*.webloc' -o \
    -name '*McNair*.command' -o \
    -name '*McNair*.app' -o \
    -name '*OpenClaw*.command' -o \
    -name '*OpenClaw*.app' \
  \) | while IFS= read -r item; do
    base="$(basename "$item")"
    if [[ -d "$item" ]]; then
      cp -R "$item" "$LAUNCHER_DIR/$base"
    else
      cp "$item" "$LAUNCHER_DIR/$base"
    fi
  done
done

{
  echo "recovery_timestamp=$STAMP"
  echo "app_dir=$APP_DIR"
  echo "db=$DB_FILE"
  echo "files:"
  find "$RECOVERY_DIR" -type f | sed "s|$RECOVERY_DIR/|  - |"
} > "$RECOVERY_DIR/manifest.txt"

echo "[3130] Recovery point created: $RECOVERY_DIR"
