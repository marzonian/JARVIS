#!/bin/bash
# ═══════════════════════════════════════
# McNair Mindset by 3130
# Setup Script — Mac Mini M4
# ═══════════════════════════════════════

set -e

echo ""
echo "═══════════════════════════════════════"
echo "  McNAIR MINDSET by 3130"
echo "  Setup & Installation"
echo "═══════════════════════════════════════"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install with: brew install node"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required (found: $(node -v))"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found"
    exit 1
fi
echo "✅ npm $(npm -v)"

# Create directories
echo ""
echo "Creating directories..."
mkdir -p data/exports
mkdir -p data/uploads
echo "✅ Directory structure created"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install
echo "✅ Dependencies installed"

# Initialize database
echo ""
echo "Initializing database..."
node server/db/database.js
echo "✅ Database ready"

# Run tests
echo ""
echo "Running ORB 3130 engine tests..."
node tests/test-orb.js

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    cat > .env << 'EOF'
# McNair Mindset by 3130

# Server
PORT=3131
HOST=localhost

# Claude API (for AI features)
# ANTHROPIC_API_KEY=sk-ant-...

# Topstep Account Settings
TOPSTEP_STARTING_BALANCE=50000
TOPSTEP_MAX_DRAWDOWN=2000
TOPSTEP_PROFIT_TARGET=3000
EOF
    echo "✅ .env file created"
fi

# Check for data to import
CSV_COUNT=$(find data/exports -name "*.csv" 2>/dev/null | wc -l | tr -d ' ')
if [ "$CSV_COUNT" -gt 0 ]; then
    echo ""
    echo "Found $CSV_COUNT CSV file(s) in data/exports/"
    echo "Importing..."
    node server/cli/import.js
else
    echo ""
    echo "📭 No CSV data found in data/exports/"
    echo "   Place your TradingView 5-min MNQ export there, then run:"
    echo "   node server/cli/import.js"
fi

# Build client
echo ""
echo "Building frontend..."
cd client && npx vite build 2>/dev/null && cd ..
echo "✅ Frontend built"

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ McNAIR MINDSET SETUP COMPLETE"
echo "═══════════════════════════════════════"
echo ""
echo "  Start the system:"
echo "    npm run dev     (development — hot reload)"
echo "    npm run server  (production — built client)"
echo ""
echo "  Open: http://localhost:3130 (dev)"
echo "  Open: http://localhost:3131 (production)"
echo ""
echo "  3130 — McNair Mindset"
echo ""
