#!/bin/bash
# ═══════════════════════════════════════
# McNair Mindset by 3130 — Deploy Script
# One command to rule them all
# ═══════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "═══════════════════════════════════════"
echo "  McNAIR MINDSET — DEPLOYING"
echo "═══════════════════════════════════════"
echo ""

# Step 1: Install dependencies (skips if already installed)
echo "▸ Installing dependencies..."
npm install --silent 2>/dev/null || npm install

# Step 2: Initialize database (creates tables if not exist)
echo "▸ Initializing database..."
# Remove old database to ensure clean schema
rm -f data/mcnair.db data/mcnair.db-wal data/mcnair.db-shm
node server/db/database.js

# Step 3: Import data (safe to re-run — uses INSERT OR IGNORE)
echo "▸ Importing data..."
node server/cli/import.js

# Step 4: Build frontend
echo "▸ Building frontend..."
cd client
npx vite build --logLevel silent 2>/dev/null || npx vite build
cd ..

# Step 5: Check for .env / API key
if [ ! -f .env ]; then
  echo ""
  echo "  ⚠  No .env file found."
  echo "  Create one with: echo 'ANTHROPIC_API_KEY=your-key' > .env"
  echo "  (AI Analyst will show setup instructions without it)"
  echo ""
fi

# Step 6: Start server
echo ""
echo "═══════════════════════════════════════"
echo "  DEPLOY COMPLETE — Starting server..."
echo "═══════════════════════════════════════"
echo ""

npm run dev
