#!/bin/bash
# Digital Media Vault — macOS/Linux launcher
cd "$(dirname "$0")"

echo ""
echo "  ========================================"
echo "       MediaVault - Starting Server"
echo "  ========================================"
echo ""

# ─── Ensure Node.js is in PATH ───
# nvm installs node in a non-standard location — source it if available
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
        echo "    — or —"
    fi
    echo "    chmod +x install.sh && ./install.sh"
    echo ""
    echo "  Or install Node.js manually:"
    echo "    macOS:  brew install node"
    echo "    Linux:  sudo apt install nodejs npm"
    echo "    nvm:    nvm install --lts"
    echo ""
    exit 1
fi

# ─── [1/4] Kill any existing instance on port 7700 ───
echo "  [1/4] Clearing port 7700..."
PID=$(lsof -ti:7700 2>/dev/null)
if [ -n "$PID" ]; then
    echo "         Stopping PID $PID..."
    kill -9 $PID 2>/dev/null
    sleep 1
else
    echo "         Port clear."
fi

# ─── [2/4] Auto-install if first run ───
echo "  [2/4] Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "         First run — installing npm packages..."
    npm install --no-audit --no-fund
    echo ""
else
    echo "         Dependencies installed."
fi

# ─── [3/4] Create directories if needed ───
echo "  [3/4] Checking directories..."
mkdir -p data thumbnails

# ─── [4/4] Start server ───
echo ""
echo "  Starting MediaVault on http://localhost:7700"
echo "  Node: $(node --version) at $(which node)"
echo ""
node src/server.js
