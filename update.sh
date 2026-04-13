#!/bin/bash
# ═══════════════════════════════════════
# McNair Mindset by 3130 — Quick Update
# Rebuilds frontend + restarts server
# Use this for code-only changes (no new dependencies)
# ═══════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "▸ Rebuilding frontend..."
cd client
npx vite build --logLevel silent 2>/dev/null || npx vite build
cd ..

echo "▸ Starting server..."
npm run dev
