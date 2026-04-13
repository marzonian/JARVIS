#!/bin/zsh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_FILE="$APP_DIR/data/mcnair.db"
BACKUP_DIR="$APP_DIR/data/backups"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
OUT_FILE="$BACKUP_DIR/mcnair_${STAMP}.db"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_FILE" ]]; then
  echo "Database not found: $DB_FILE" >&2
  exit 1
fi

cp "$DB_FILE" "$OUT_FILE"

# Keep only the most recent 30 backups.
old="$(ls -1t "$BACKUP_DIR"/mcnair_*.db 2>/dev/null | tail -n +31 || true)"
if [[ -n "$old" ]]; then
  echo "$old" | xargs rm -f
fi

echo "Backup created: $OUT_FILE"
