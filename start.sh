#!/bin/bash
# Comfy Asset Manager — macOS/Linux launcher
cd "$(dirname "$0")"

echo ""
echo "  ========================================"
echo "    Comfy Asset Manager — Starting..."
echo "  ========================================"
echo ""

# ─── Ensure Node.js is in PATH ───
if ! command -v node &>/dev/null; then
    # Try nvm (most common Node version manager)
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi

if ! command -v node &>/dev/null; then
    # Try Homebrew paths (Apple Silicon + Intel)
    for p in /opt/homebrew/bin /usr/local/bin; do
        [ -x "$p/node" ] && export PATH="$p:$PATH" && break
    done
fi

if ! command -v node &>/dev/null; then
    echo ""
    echo "  ❌ Node.js not found!"
    echo ""
    echo "  Please run the installer first:"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "    Double-click install.command"
    else
        echo "    chmod +x install.sh && ./install.sh"
    fi
    echo ""
    exit 1
fi

# ─── [1/3] Clear port ───
echo "  [1/3] Preparing..."
PID=$(lsof -ti:7700 2>/dev/null)
if [ -n "$PID" ]; then
    kill -9 $PID 2>/dev/null
    sleep 1
fi
echo "         ✓ Ready."

# ─── [2/3] Check dependencies ───
echo "  [2/3] Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "         First run — installing packages..."
    npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -1 || true
fi
echo "         ✓ Ready."

# Create directories if needed
mkdir -p data thumbnails

# ─── [3/3] Start server ───
echo "  [3/3] Starting server..."
echo ""
echo "  ┌──────────────────────────────────────────┐"
echo "  │                                          │"
echo "  │   Your browser will open automatically.  │"
echo "  │                                          │"
echo "  │   If not, go to: http://localhost:7700   │"
echo "  │                                          │"
echo "  │   To stop: press Ctrl+C or close this    │"
echo "  │   window.                                │"
echo "  │                                          │"
echo "  └──────────────────────────────────────────┘"
echo ""

# Auto-open browser on macOS after a short delay
if [[ "$OSTYPE" == "darwin"* ]]; then
    (sleep 2 && open "http://localhost:7700") &
fi

node src/server.js
